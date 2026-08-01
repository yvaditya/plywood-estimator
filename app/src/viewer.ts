/**
 * Three.js viewer tuned for CAD-style legibility (Onshape / Fusion vibe).
 *
 * Rendering pipeline:
 *   RenderPass -> GTAOPass (ground-truth ambient occlusion)
 *              -> OutlinePass (crisp silhouettes around every body)
 *              -> SMAAPass (anti-alias, replaces lost MSAA)
 *              -> OutputPass (AgX tone map + sRGB)
 *
 * Each body:
 *   - MeshPhysicalMaterial with a unique high-chroma HSL color.
 *   - Bright in-body-color edge overlay (EdgesGeometry @ ~25 deg) for crease
 *     definition that survives even when the body is dimmed.
 *   - Subtle baked Fresnel rim in the material (onBeforeCompile) so edges
 *     lift off the background without a separate pass.
 *
 * Selection model preserved:
 *   - selection: Set<bodyId>; toggleSelection / setSelection / selectAll /
 *     selectNone; setSelectionListener(cb).
 *   - When something is selected, every body's outline still pops (white for
 *     selected, faint grey for the rest) so the dimmed bodies remain readable
 *     silhouettes instead of disappearing into the background.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { OcctResult, OcctMesh } from './stepLoader';
import { DEFAULT_LEGEND, legendT, sampleColorMap, type LegendSpec } from './cae';

export type GrainLock = 'free' | 'length' | 'width';

export interface GrainArrowConfig {
  /** Centroid of the PRIMARY flat face (e.g. +Z top), world coords. */
  faceCenter: [number, number, number];
  /** Outward normal of the PRIMARY face (unit vector, world). */
  faceNormal: [number, number, number];
  /** Unit vector along the panel's LENGTH (longer in-face edge), world. */
  lengthDir: [number, number, number];
  /** Unit vector along the panel's WIDTH (shorter in-face edge), world. */
  widthDir: [number, number, number];
  length: number;        // mm
  width: number;         // mm
  thickness: number;     // mm — used to find the OPPOSITE face anchor
}

const COLOR_HOVER = new THREE.Color('#7ef3c0');
const DIM_OPACITY = 0.22;

export interface BodyHandle {
  id: number;
  name: string;
  mesh: THREE.Mesh;
  /** Each body's stable color, sRGB hex string (also used in 2D layout). */
  hexColor: string;
}

/** The FE discretisation to draw — structurally `CaeMeshView` from cae.ts,
 *  restated here so the viewer stays independent of the solver's types. */
export interface CaeMeshData {
  nodes: Float32Array;      // 3 floats per node, world mm
  elems: Int32Array;        // nodesPerElem indices per element
  nodesPerElem: 4 | 8;      // 4 = shell quad, 8 = solid hex
  nodeCount: number;
  elemCount: number;
}

export interface CaeMeshStyle {
  /** Fill the element faces (default true). */
  faces?: boolean;
  /** Draw element edges (default true). */
  edges?: boolean;
  /** Draw a dot per node (default false). */
  points?: boolean;
  /** Per-node scalar field for the contour; NaN entries render neutral gray. */
  field?: Float32Array | null;
  /** Bottom of the colour scale (the legend's resolved low end). */
  fieldMin?: number;
  /** Top of the colour scale. Leave equal to fieldMin to disable contouring. */
  fieldMax?: number;
  /** Colour map / banding / reverse — the SAME spec the legend renders from,
   *  so the bar and the geometry can never disagree. */
  legend?: LegendSpec | null;
  /** Per-node displacement (3 floats/node) for the deformed shape. */
  disp?: Float32Array | null;
  /** Displacement exaggeration factor (0 = undeformed). */
  dispScale?: number;
  /** Face opacity — drop it to see the mesh interior. */
  opacity?: number;
}

/** One joint node-pair coupling, drawn as a segment. */
export interface CaeCouplingLine {
  p0: [number, number, number];
  p1: [number, number, number];
  stiffness: string;
}

/** One nodal load: arrow along `f`, tip on `at`. */
export interface CaeLoadArrow {
  at: [number, number, number];
  f: [number, number, number];
}

/** An extreme-value annotation: marker at `at`, leader out along `dir`. */
export interface CaeCallout {
  at: [number, number, number];
  /** Leader direction (world). Defaults to +Z. */
  dir?: [number, number, number];
  /** Short tag, e.g. "MAX". */
  tag: string;
  /** Formatted value, e.g. "3.88 mm". */
  value: string;
  /** Optional second line, e.g. "panel 1p". */
  sub?: string;
  /** CSS colour for the marker, leader and label accent. */
  color: string;
}

/**
 * Hand-picked palette of 24 well-separated colors (Tableau / Carto / ColorBrewer
 * combined). Up to index 23, colors come from this list — guaranteed
 * perceptually distinct, no near-duplicates. Beyond that we fall back to
 * golden-ratio HSL with varied saturation+lightness so further bodies
 * still stay visually different from each other.
 */
const PALETTE_24 = [
  '#4E79A7', '#F28E2C', '#E15759', '#76B7B2', '#59A14F',
  '#EDC949', '#AF7AA1', '#FF9DA7', '#9C755F', '#7C7C7C',
  '#6A91D4', '#5F4690', '#1D6996', '#38A6A5', '#0F8554',
  '#73AF48', '#EDAD08', '#E17C05', '#CC503E', '#94346E',
  '#6F4070', '#994E95', '#2D4A77', '#B07A2E',
];

export function bodyColor(i: number): string {
  if (i < PALETTE_24.length) return PALETTE_24[i];
  // Fallback for very large jobs: phi hue stepping with rotating
  // sat/lightness so adjacent overflow indices don't repeat.
  const phi = 0.61803398875;
  const k = i - PALETTE_24.length;
  const hue = ((k + 1) * phi) % 1;
  const sat = 0.62 + ((k * 0.27) % 0.34);   // 0.62 … 0.96
  const light = 0.40 + ((k * 0.41) % 0.28); // 0.40 … 0.68
  const perceptualBoost = 0.05 * Math.cos((hue - 0.15) * Math.PI * 2);
  const c = new THREE.Color().setHSL(hue, sat, light - perceptualBoost);
  return '#' + c.getHexString();
}

export class Viewer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  composer: EffectComposer;
  // Kept public to preserve the previous constructor's surface shape.
  ssaoPass: GTAOPass;
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  bodies: BodyHandle[] = [];
  selection = new Set<number>();
  hovered: number | null = null;

  private root = new THREE.Group();
  private grainGroup = new THREE.Group();
  private nonSheetGroup = new THREE.Group();
  /** Overlays for the structural-analysis feature: deflection heatmap meshes,
   *  force arrows, joint contact lines, floor glyphs, and the "weak panel"
   *  outline tints. Cleared via the clear* helpers so they never permanently
   *  alter the body material. */
  private caeGroup = new THREE.Group();
  private caeWeakOutlines = new Map<number, THREE.LineSegments>();
  private caeOverlays = new Map<number, THREE.Object3D>();
  /** Per-body-id → load-index → arrow+footprint group (for multiple loads). */
  private caeLoadMarkers = new Map<number, Map<number, THREE.Object3D>>();
  /** Assembly joint contact lines (one group for the whole cabinet). */
  private asmJointGroup: THREE.Object3D | null = null;
  /** FE mesh overlay (element faces + edges + nodes) and the constraint
   *  glyph set (supports / joint couplings / load arrows). */
  private caeMeshGroup: THREE.Group | null = null;
  private caeConstraintGroup: THREE.Group | null = null;
  private caeCalloutGroup: THREE.Group | null = null;
  /** Callout labels + the last screen position written for each, so the
   *  per-frame tracker can skip untouched DOM writes. */
  private caeCallouts: {
    el: HTMLElement; anchor: THREE.Vector3;
    x: number; y: number; hidden: boolean;
  }[] = [];
  private caeMeshFocus = false;
  /** Assembly floor-support glyphs (one group for the whole cabinet). */
  private asmFloorGroup: THREE.Object3D | null = null;
  /** When set, the next body-face click is captured for force placement
   *  instead of toggling selection. */
  private caePlacePick: { bodyId: number; cb: (p: THREE.Vector3, n: THREE.Vector3) => void } | null = null;
  /** When set, the next click on ANY panel captures (bodyId, worldPoint,
   *  worldNormal) — used to place an assembly load on the clicked panel. */
  private asmPlacePick: ((bodyId: number, point: [number, number, number], normal: [number, number, number]) => void) | null = null;
  private grainArrows = new Map<number, THREE.Group>();
  private grainConfigs = new Map<number, GrainArrowConfig>();
  private grainStates = new Map<number, GrainLock>();
  private onSelectionChange?: () => void;
  private onGrainCycle?: (bodyId: number) => void;
  /** Wheel-gesture stream state — see handleWheelPan. A stream keeps its
   *  pan/zoom verdict; a >400 ms pause starts a fresh classification. */
  private wheelStreamKind: 'pan' | 'zoom' | null = null;
  private lastWheelTs = -Infinity;
  private pmrem: THREE.PMREMGenerator;
  private key!: THREE.DirectionalLight;
  private rim!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private shadowFloor!: THREE.Mesh;
  private grid!: THREE.GridHelper;
  private outlinePass!: OutlinePass;
  private outlineDimPass!: OutlinePass;
  private smaaPass!: SMAAPass;

  constructor(container: HTMLElement) {
    this.scene = new THREE.Scene();
    // Studio gradient + soft radial vignette: brighter near the model center,
    // darker at the corners. Gives the geometry a "stage" to sit on rather
    // than fading into the panel.
    this.scene.background = makeStudioBackground();
    // STEP files use Z-up. Match that so orbit + grid match CAD expectations.
    this.scene.up.set(0, 0, 1);
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.camera = new THREE.PerspectiveCamera(
      40,
      container.clientWidth / container.clientHeight,
      0.1,
      100000,
    );
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(600, -600, 500);

    // antialias:true would only AA the final back-buffer, not what the
    // EffectComposer renders into. We get crisp geometry edges from a
    // multisampled render target below, and SMAA cleans up post-pass aliasing.
    // preserveDrawingBuffer is required for reliable canvas.toDataURL() so
    // snapshot()/snapshotExploded() can embed the scene in the PDF.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral tone mapping preserves chroma far better than
    // ACES/AgX, which both push midtones toward white. Critical for the
    // CAD look — bodies need to read as their actual color, not a pastel
    // version of it.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Environment map for crisp speculars + soft ambient
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    const envTex = this.pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environment = envTex;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Three-point dynamic lighting + diffused hemisphere
    //   KEY: dominant directional that casts shadows
    //   RIM: opposite back light for edge separation
    //   FILL: hemisphere (sky/ground gradient) — soft diffuse wash
    this.key = new THREE.DirectionalLight(0xfff2dc, 2.2);
    this.key.position.set(1, -1.2, 1.4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(4096, 4096);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.04;
    this.key.shadow.radius = 4;
    this.scene.add(this.key);

    this.rim = new THREE.DirectionalLight(0x9fc1ff, 0.9);
    this.rim.position.set(-1.4, 1.0, 0.5);
    this.scene.add(this.rim);

    // Hemisphere fill — sky (warm off-white) + ground (warm gray) tuned to
    // the new light backdrop so the floor-side of the model picks up a
    // neutral bounce instead of a dark-blue cast.
    this.hemi = new THREE.HemisphereLight(0xfaf9f6, 0xb8b6b0, 0.22);
    this.scene.add(this.hemi);

    // Ground plane that receives shadows (sits just below the geometry).
    // Higher opacity per follow-up direction — punchier ground contact
    // anchors the model on the light floor.
    this.shadowFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(40000, 40000),
      new THREE.ShadowMaterial({ opacity: 0.62, color: 0x000000 }),
    );
    this.shadowFloor.receiveShadow = true;
    this.shadowFloor.position.z = 0;
    this.scene.add(this.shadowFloor);

    // Floor grid on the XY plane (Z-up world). Switched to warm grays so
    // it reads as a quiet drafting grid against the light backdrop instead
    // of glowing blue.
    // Auto-resized to wrap the loaded model's footprint in frameAll().
    const grid = new THREE.GridHelper(6000, 60, 0x9b9a97, 0xcfceca);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.grid = grid;
    this.scene.add(grid);

    this.scene.add(this.root);
    this.scene.add(this.grainGroup);
    this.scene.add(this.nonSheetGroup);
    this.scene.add(this.caeGroup);

    // ----- Post-processing chain -------------------------------------------
    // We render into a HalfFloat target so AgX has headroom and the outline
    // pass's additive blend doesn't clip.
    // 4x MSAA on the multisampled render target — gives geometry edges true
    // hardware AA on the first pass, before AO + Outline run. SMAA pass at
    // the end still helps with edges introduced by post processing.
    this.composer = new EffectComposer(
      this.renderer,
      new THREE.WebGLRenderTarget(container.clientWidth, container.clientHeight, {
        type: THREE.HalfFloatType,
        colorSpace: THREE.LinearSRGBColorSpace,
        samples: 4,
      }),
    );
    this.composer.setPixelRatio(window.devicePixelRatio);
    this.composer.setSize(container.clientWidth, container.clientHeight);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);

    // GTAO — ground-truth AO — much cleaner crevice darkening than SSAO,
    // and unlike SSAO it can actually shade the whole body's far side.
    const gtao = new GTAOPass(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
    );
    gtao.output = GTAOPass.OUTPUT.Default;
    // Tuned for the light backdrop. Original was 1.15; stepped 50% darker
    // (1.725) when we switched to a light scene background; another 30%
    // deeper (×1.3) per follow-up direction for stronger crevice darkening.
    gtao.blendIntensity = 2.2425;
    gtao.updateGtaoMaterial({
      radius: 0.4,
      distanceExponent: 1.4,
      thickness: 0.4,
      scale: 1.0,
      samples: 24,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    this.composer.addPass(gtao);
    this.ssaoPass = gtao;

    // OutlinePass — used ONLY for selection/hover emphasis. The "resting"
    // crease + silhouette legibility comes from the per-body LineSegments
    // overlays, because OutlinePass draws one silhouette around the union
    // of its selectedObjects (so seams between adjacent bodies don't show
    // up if we pass them all in at once).
    //
    // We keep two passes:
    //   * outlineDimPass: subtle grey halo around hovered body (preview)
    //   * outlinePass: bright halo around explicitly selected bodies
    const res = new THREE.Vector2(container.clientWidth, container.clientHeight);
    this.outlineDimPass = new OutlinePass(res, this.scene, this.camera);
    this.outlineDimPass.edgeStrength = 4.0;
    this.outlineDimPass.edgeThickness = 1.0;
    this.outlineDimPass.edgeGlow = 0.0;
    this.outlineDimPass.visibleEdgeColor.set('#0F7B6C');
    this.outlineDimPass.hiddenEdgeColor.set('#b8d8d0');
    this.composer.addPass(this.outlineDimPass);

    this.outlinePass = new OutlinePass(res, this.scene, this.camera);
    this.outlinePass.edgeStrength = 10.0;
    this.outlinePass.edgeThickness = 2.0;
    this.outlinePass.edgeGlow = 0.5;
    this.outlinePass.visibleEdgeColor.set('#37352F');
    this.outlinePass.hiddenEdgeColor.set('#bfbeb9');
    this.composer.addPass(this.outlinePass);

    // SMAA — recovers anti-aliasing lost when SSAO / OutlinePass ate the
    // MSAA buffer. Cheap and very effective on CAD silhouettes.
    this.smaaPass = new SMAAPass(
      container.clientWidth * window.devicePixelRatio,
      container.clientHeight * window.devicePixelRatio,
    );
    this.composer.addPass(this.smaaPass);

    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('click', this.handleClick);
    // Trackpad two-finger pan. Cross-platform detection:
    //   - ctrlKey                       → pinch-to-zoom → defer to OrbitControls
    //   - large vertical-only delta w/  → mouse wheel → defer (OrbitControls zoom)
    //     non-zero deltaMode (lines)
    //   - everything else (precision    → two-finger pan → handled here
    //     trackpad on Mac OR Windows)
    this.renderer.domElement.addEventListener('wheel', this.handleWheelPan, { passive: false, capture: true });
    new ResizeObserver(() => this.resize(container)).observe(container);

    this.tick();
  }

  private handleWheelPan = (ev: WheelEvent) => {
    if (ev.ctrlKey) return; // pinch-zoom — defer to OrbitControls
    // Distinguish trackpad vs mouse wheel. Mouse wheels emit:
    //   - deltaMode > 0 (lines/pages) OR
    //   - large vertical-only steps with deltaX === 0
    // Precision touchpads on BOTH Mac and Windows emit deltaMode === 0 with
    // small mixed deltaX/deltaY values — handle those as pan.
    //
    // Classification is STICKY per gesture stream: events arriving within
    // 400 ms of the previous one keep the stream's verdict instead of being
    // re-classified. Windows wheel drivers with smooth scrolling split a
    // fast spin into many small pixel-mode deltas — judged per-event, the
    // sub-50px ones fell through to the pan path and the model jumped
    // up/down mid-zoom. A user can't switch devices mid-scroll, so the
    // first event of a stream decides for all of it.
    const sinceLast = ev.timeStamp - this.lastWheelTs;
    this.lastWheelTs = ev.timeStamp;
    if (sinceLast > 400 || this.wheelStreamKind === null) {
      const isMouseWheel =
        ev.deltaMode !== 0 || (ev.deltaX === 0 && Math.abs(ev.deltaY) >= 50);
      this.wheelStreamKind = isMouseWheel ? 'zoom' : 'pan';
    }
    if (this.wheelStreamKind === 'zoom') return; // defer to OrbitControls

    ev.preventDefault();
    ev.stopPropagation();
    // Convert pixel deltas to world units at the target depth (same formula
    // OrbitControls uses internally for screen-space pan).
    const offset = new THREE.Vector3().copy(this.camera.position).sub(this.controls.target);
    const targetDist = offset.length();
    const fov = (this.camera.fov * Math.PI) / 180;
    const h = this.renderer.domElement.clientHeight || 1;
    const panX = (2 * ev.deltaX * targetDist * Math.tan(fov / 2)) / h;
    const panY = (2 * ev.deltaY * targetDist * Math.tan(fov / 2)) / h;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.matrix.extractBasis(right, up, new THREE.Vector3());
    // Sign convention: drag scene WITH the fingers — two-finger swipe RIGHT
    // moves the scene right (camera left = -right axis), swipe DOWN moves
    // the scene down (camera up = +up axis). Note that browser wheel deltaY
    // is positive when "scrolling down" which corresponds to a downward
    // finger gesture on both Mac (natural scroll on) and Windows (default).
    const pan = right.multiplyScalar(panX).add(up.multiplyScalar(-panY));
    this.camera.position.add(pan);
    this.controls.target.add(pan);
  };

  setSelectionListener(cb: () => void) { this.onSelectionChange = cb; }
  setGrainCycleListener(cb: (bodyId: number) => void) { this.onGrainCycle = cb; }

  /**
   * Tell the viewer what each body's grain state is. The viewer renders
   * an arrow on every SELECTED body whose state is known.
   */
  setBodyGrain(bodyId: number, grain: GrainLock, cfg: GrainArrowConfig) {
    this.grainStates.set(bodyId, grain);
    this.grainConfigs.set(bodyId, cfg);
    this.refreshGrainArrows();
  }

  private refreshGrainArrows() {
    // Remove existing arrows
    for (const g of this.grainArrows.values()) {
      this.grainGroup.remove(g);
      disposeObject3D(g);
    }
    this.grainArrows.clear();

    for (const bodyId of this.selection) {
      const grain = this.grainStates.get(bodyId);
      const cfg = this.grainConfigs.get(bodyId);
      if (!grain || !cfg) continue;
      const a = buildGrainArrow(bodyId, grain, cfg);
      this.grainGroup.add(a);
      this.grainArrows.set(bodyId, a);
    }
  }

  // -------------------------------------------------------------------------
  // Quick-CAE overlays
  // -------------------------------------------------------------------------

  /**
   * Mark a set of bodies as "structurally weak" (screening verdict === weak).
   * Renders a subtle orange edge outline over each — no halo, no fill change,
   * just a slightly warmer outline that survives dimming. Minimal-UI rule.
   */
  setWeakBodies(ids: Iterable<number>) {
    const want = new Set(ids);
    // remove outlines no longer wanted
    for (const [id, ls] of this.caeWeakOutlines) {
      if (!want.has(id)) {
        this.caeGroup.remove(ls);
        disposeObject3D(ls);
        this.caeWeakOutlines.delete(id);
      }
    }
    for (const id of want) {
      if (this.caeWeakOutlines.has(id)) continue;
      const body = this.bodies.find((b) => b.id === id);
      if (!body) continue;
      const geom = new THREE.EdgesGeometry(body.mesh.geometry as THREE.BufferGeometry, 25);
      const ls = new THREE.LineSegments(
        geom,
        new THREE.LineBasicMaterial({ color: 0xe8871e, transparent: true, opacity: 0.9, depthTest: true }),
      );
      // body meshes carry raw world-coord vertices with identity transform, so
      // the outline sits exactly on the body without extra placement.
      ls.renderOrder = 4;
      this.caeGroup.add(ls);
      this.caeWeakOutlines.set(id, ls);
    }
  }

  /** Enter "place force" mode for a body — the next click on that body's face
   *  (NOT near an edge that's armed for edge-picking) fires `cb(point,
   *  faceNormal)` (world coords) instead of selecting. Placement modes take
   *  priority over the edge picker. */
  beginForcePlacement(bodyId: number, cb: (point: [number, number, number], normal: [number, number, number]) => void) {
    this.caePlacePick = {
      bodyId,
      cb: (p, n) => cb([p.x, p.y, p.z], [n.x, n.y, n.z]),
    };
  }
  cancelForcePlacement() { this.caePlacePick = null; }

  /** Arm assembly-load placement: the next click on ANY loaded panel fires
   *  `cb(bodyId, worldPoint, worldNormal)`. */
  beginAssemblyPlacement(cb: (bodyId: number, point: [number, number, number], normal: [number, number, number]) => void) {
    this.asmPlacePick = cb;
  }
  cancelAssemblyPlacement() { this.asmPlacePick = null; }

  /**
   * Draw the marker for ONE load: a footprint outline (square or circle, red
   * hairline) on the face plus an arrow. Down loads (N>0) point INTO the face;
   * up loads (reactions, N<0) point OUT of it. Keyed per (bodyId, index) so
   * multiple loads coexist.
   */
  showLoadMarker(
    bodyId: number,
    index: number,
    point: [number, number, number],
    normal: [number, number, number],
    len: number,
    footprint: { shape: 'square' | 'round'; size: number; uAxis: [number, number, number]; vAxis: [number, number, number] },
    down: boolean,
  ) {
    let perBody = this.caeLoadMarkers.get(bodyId);
    if (!perBody) { perBody = new Map(); this.caeLoadMarkers.set(bodyId, perBody); }
    const existing = perBody.get(index);
    if (existing) { this.caeGroup.remove(existing); disposeObject3D(existing); perBody.delete(index); }

    const group = new THREE.Group();
    const origin = new THREE.Vector3(...point);
    const n = new THREE.Vector3(...normal).normalize();
    // Float the marker a hair off the face.
    const base = origin.clone().addScaledVector(n, 0.6);

    // Arrow: down → point into the face (along −n, starting proud); up → point
    // out (along +n).
    const dir = down ? n.clone().negate() : n.clone();
    const start = down ? origin.clone().addScaledVector(n, len) : base.clone();
    const arrow = new THREE.ArrowHelper(dir, start, len, down ? 0xd6353b : 0x2f7fd6, len * 0.28, len * 0.16);
    (arrow.line.material as THREE.LineBasicMaterial).linewidth = 2;
    arrow.renderOrder = 6;
    group.add(arrow);

    // Footprint outline (red hairline) in the face plane.
    if (footprint.size > 0) {
      const u = new THREE.Vector3(...footprint.uAxis).normalize();
      const v = new THREE.Vector3(...footprint.vAxis).normalize();
      const half = footprint.size / 2;
      const pts: THREE.Vector3[] = [];
      if (footprint.shape === 'round') {
        const seg = 40;
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          pts.push(base.clone().addScaledVector(u, Math.cos(a) * half).addScaledVector(v, Math.sin(a) * half));
        }
      } else {
        const corners: [number, number][] = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]];
        for (const [su, sv] of corners) pts.push(base.clone().addScaledVector(u, su).addScaledVector(v, sv));
      }
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0xd6353b, transparent: true, opacity: 0.95, depthTest: true }));
      line.renderOrder = 6;
      group.add(line);
    }

    group.userData.caeLoadFor = bodyId;
    this.caeGroup.add(group);
    perBody.set(index, group);
  }
  /** Remove ALL load markers for a body. */
  clearLoadMarkers(bodyId: number) {
    const perBody = this.caeLoadMarkers.get(bodyId);
    if (!perBody) return;
    for (const g of perBody.values()) { this.caeGroup.remove(g); disposeObject3D(g); }
    this.caeLoadMarkers.delete(bodyId);
  }

  /**
   * Draw the assembly's joint contact lines. Each joint is a world segment
   * coloured by its stiffness class: rigid dark, semi-rigid mid, hinged light.
   * Replaces any previously drawn joint set. One group for the whole cabinet.
   */
  showAssemblyJoints(joints: { p0: [number, number, number]; p1: [number, number, number]; stiffness: 'rigid' | 'semi-rigid' | 'hinged' }[]) {
    this.clearAssemblyJoints();
    if (joints.length === 0) return;
    const group = new THREE.Group();
    const color: Record<string, number> = { rigid: 0x1b2733, 'semi-rigid': 0x4a7bb0, hinged: 0x9fc0e0 };
    for (const j of joints) {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...j.p0), new THREE.Vector3(...j.p1),
      ]);
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({
        color: color[j.stiffness] ?? 0x1b2733, transparent: true, opacity: 0.95, depthTest: true,
      }));
      line.renderOrder = 6;
      group.add(line);
    }
    this.caeGroup.add(group);
    this.asmJointGroup = group;
  }
  clearAssemblyJoints() {
    if (this.asmJointGroup) { this.caeGroup.remove(this.asmJointGroup); disposeObject3D(this.asmJointGroup); this.asmJointGroup = null; }
  }

  /** Draw floor-support glyphs (small triangles) at the given world points — the
   *  nodes the solver grounds to z = 0. Replaces any previous set. */
  showFloorGlyphs(points: [number, number, number][]) {
    this.clearFloorGlyphs();
    if (points.length === 0) return;
    const group = new THREE.Group();
    const s = 14;
    for (const pt of points) {
      // A little upward chevron ▲ sitting under the contact, in world XZ.
      const p = new THREE.Vector3(...pt);
      const a = p.clone().add(new THREE.Vector3(-s, 0, -s));
      const b = p.clone().add(new THREE.Vector3(s, 0, -s));
      const geom = new THREE.BufferGeometry().setFromPoints([a, p, b]);
      const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x2f7d4f, transparent: true, opacity: 0.9, depthTest: true }));
      line.renderOrder = 6;
      group.add(line);
    }
    this.caeGroup.add(group);
    this.asmFloorGroup = group;
  }
  clearFloorGlyphs() {
    if (this.asmFloorGroup) { this.caeGroup.remove(this.asmFloorGroup); disposeObject3D(this.asmFloorGroup); this.asmFloorGroup = null; }
  }

  /** Remove every assembly overlay: heatmaps, joint lines, floor glyphs, load
   *  markers. Leaves the weak-panel tint alone (screening is always on). */
  clearAssemblyOverlay() {
    this.clearAssemblyJoints();
    this.clearFloorGlyphs();
    this.clearCaeMesh();
    this.clearCaeConstraints();
    this.clearCaeCallouts();
    this.setCaeMeshFocus(false);
    for (const o of this.caeOverlays.values()) { this.caeGroup.remove(o); disposeObject3D(o); }
    this.caeOverlays.clear();
    for (const perBody of this.caeLoadMarkers.values()) {
      for (const g of perBody.values()) { this.caeGroup.remove(g); disposeObject3D(g); }
    }
    this.caeLoadMarkers.clear();
    this.caePlacePick = null;
  }

  /**
   * Paint a deflection heatmap on a body's face. `tex` is a CanvasTexture the
   * caller built from the solver grid; `plane` describes how to lay it on the
   * body face: origin (a corner of the outline bbox in world), and the two
   * in-face world axes (uAxis spans bbox width w, vAxis spans height h). The
   * overlay is a thin quad clone floated a hair off the face along the normal.
   */
  showDeflectionOverlay(
    bodyId: number,
    tex: THREE.CanvasTexture,
    plane: {
      origin: [number, number, number];
      uAxis: [number, number, number]; // unit, world
      vAxis: [number, number, number]; // unit, world
      normal: [number, number, number];
      w: number; h: number; // mm
      /** Panel thickness — when given, the heatmap is painted on BOTH faces
       *  (the analyzed outline face can be the hidden underside). */
      thickness?: number;
    },
  ) {
    this.clearDeflectionOverlay(bodyId);
    const o = new THREE.Vector3(...plane.origin);
    const u = new THREE.Vector3(...plane.uAxis).normalize();
    const v = new THREE.Vector3(...plane.vAxis).normalize();
    const n = new THREE.Vector3(...plane.normal).normalize();
    const group = new THREE.Group();
    // Opaque fringe plot (standard CAE display) — a translucent map over the
    // part's own color muddies the scale beyond reading.
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    // Float 0.5 mm proud of each face so it wins the depth test cleanly.
    const offsets = plane.thickness ? [0.5, -(plane.thickness + 0.5)] : [0.5];
    for (const d of offsets) {
      const off = o.clone().addScaledVector(n, d);
      const c0 = off.clone();
      const c1 = off.clone().addScaledVector(u, plane.w);
      const c2 = off.clone().addScaledVector(u, plane.w).addScaledVector(v, plane.h);
      const c3 = off.clone().addScaledVector(v, plane.h);
      const geom = new THREE.BufferGeometry();
      const positions = new Float32Array([
        c0.x, c0.y, c0.z,  c1.x, c1.y, c1.z,  c2.x, c2.y, c2.z,
        c0.x, c0.y, c0.z,  c2.x, c2.y, c2.z,  c3.x, c3.y, c3.z,
      ]);
      const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geom.computeVertexNormals();
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 5;
      group.add(mesh);
    }
    group.userData.caeOverlayFor = bodyId;
    this.caeGroup.add(group);
    this.caeOverlays.set(bodyId, group);
  }
  clearDeflectionOverlay(bodyId: number) {
    const m = this.caeOverlays.get(bodyId);
    if (m) { this.caeGroup.remove(m); disposeObject3D(m); this.caeOverlays.delete(bodyId); }
  }

  // -------------------------------------------------------------------------
  // FE MESH VIEW
  //
  // Draws the solver's own discretisation: element faces (optionally contoured
  // by a per-node result field), element edges, and node dots — on the
  // undeformed geometry or on a scaled deformed shape. Shell meshes draw every
  // quad; solid meshes draw only the hull faces (a face used by one hex), so
  // you see the outside of the solid rather than a fog of interior faces.
  // -------------------------------------------------------------------------

  /** Replace the mesh overlay. Pass `null` to remove it. */
  showCaeMesh(data: CaeMeshData | null, style: CaeMeshStyle = {}) {
    this.clearCaeMesh();
    if (!data || data.elemCount === 0) return;

    const {
      faces = true, edges = true, points = false,
      field = null, fieldMin = 0, fieldMax = 0, legend = null,
      disp = null, dispScale = 0, opacity = 1,
    } = style;

    // Display positions = undeformed + scaled displacement.
    const pos = new Float32Array(data.nodes.length);
    pos.set(data.nodes);
    if (disp && dispScale !== 0) {
      const n = Math.min(data.nodeCount, Math.floor(disp.length / 3));
      for (let i = 0; i < n; i++) {
        pos[i * 3] += disp[i * 3] * dispScale;
        pos[i * 3 + 1] += disp[i * 3 + 1] * dispScale;
        pos[i * 3 + 2] += disp[i * 3 + 2] * dispScale;
      }
    }

    // Per-node contour colors (NaN / no field → neutral gray).
    let colors: Float32Array | null = null;
    if (field && fieldMax > fieldMin) {
      const spec = legend ?? DEFAULT_LEGEND;
      colors = new Float32Array(data.nodeCount * 3);
      for (let i = 0; i < data.nodeCount; i++) {
        const v = field[i];
        if (!Number.isFinite(v)) { colors[i * 3] = 0.65; colors[i * 3 + 1] = 0.65; colors[i * 3 + 2] = 0.66; continue; }
        // Values outside a manually-narrowed range clamp to the end colours,
        // which is what the legend's "range clipped" note is warning about.
        const [r, g, b] = sampleColorMap(spec, legendT(v, fieldMin, fieldMax));
        // Vertex colors feed the material in linear space.
        colors[i * 3] = srgbToLinear(r / 255);
        colors[i * 3 + 1] = srgbToLinear(g / 255);
        colors[i * 3 + 2] = srgbToLinear(b / 255);
      }
    }

    const group = new THREE.Group();
    const quads = data.nodesPerElem === 8 ? hullFacesOfHexes(data) : quadsOfShell(data);

    if (faces) {
      const tri = new Uint32Array(quads.length / 4 * 6);
      for (let q = 0, t = 0; q < quads.length; q += 4) {
        const a = quads[q], b = quads[q + 1], c = quads[q + 2], d = quads[q + 3];
        tri[t++] = a; tri[t++] = b; tri[t++] = c;
        tri[t++] = a; tri[t++] = c; tri[t++] = d;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (colors) geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geom.setIndex(new THREE.BufferAttribute(tri, 1));
      geom.computeVertexNormals();
      // Lambert, not Basic: an unlit mesh loses every edge of the assembly and
      // reads as a flat silhouette. A little shading keeps the panels legible
      // while the contour still carries the actual result.
      const mat = new THREE.MeshLambertMaterial({
        vertexColors: !!colors,
        color: colors ? 0xffffff : 0xb9c2cc,
        emissive: colors ? 0x3a3a3a : 0x2a2f36,
        side: THREE.DoubleSide,
        transparent: opacity < 1,
        opacity,
        // FLAT shading, always. Averaged vertex normals round a hex mesh off
        // into a blob — the through-thickness faces of a solid have to read as
        // discrete facets with hard edges, which is the whole point of looking
        // at a solid mesh. Planar shell panels are unaffected.
        flatShading: true,
        // Push faces back so the wireframe on top never z-fights with them.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.renderOrder = 5;
      group.add(mesh);
    }

    if (edges) {
      const segs = uniqueQuadEdges(quads);
      const eGeom = new THREE.BufferGeometry();
      eGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      eGeom.setIndex(new THREE.BufferAttribute(segs, 1));
      // Solid hull edges carry the element facets, so they sit darker/stronger
      // than the shell's in-plane grid.
      const solid = data.nodesPerElem === 8;
      const eMat = new THREE.LineBasicMaterial({
        color: faces ? (solid ? 0x0f1720 : 0x1b2733) : 0x37414f,
        transparent: true,
        opacity: faces ? (solid ? 0.8 : 0.6) : 0.9,
      });
      const lines = new THREE.LineSegments(eGeom, eMat);
      lines.renderOrder = 6;
      group.add(lines);
    }

    if (points) {
      const pGeom = new THREE.BufferGeometry();
      pGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const pMat = new THREE.PointsMaterial({ color: 0x1b2733, size: 2.4, sizeAttenuation: false });
      const pts = new THREE.Points(pGeom, pMat);
      pts.renderOrder = 7;
      group.add(pts);
    }

    this.caeGroup.add(group);
    this.caeMeshGroup = group;
  }

  clearCaeMesh() {
    if (this.caeMeshGroup) {
      this.caeGroup.remove(this.caeMeshGroup);
      disposeObject3D(this.caeMeshGroup);
      this.caeMeshGroup = null;
    }
  }

  // -------------------------------------------------------------------------
  // CONSTRAINT VIEW — the boundary conditions the solver actually applied.
  //
  //   supports  fixed nodes         → green pyramid under each node
  //   couplings joint node-pairs    → short segment per penalty spring pair,
  //                                   coloured by the joint's stiffness class
  //   loads     nodal force vectors → arrows along the force, length ∝ √|F|
  //
  // All three are instanced/batched: a workbench mesh grounds several hundred
  // nodes and couples a few thousand pairs, which would be far too many
  // individual Object3Ds.
  // -------------------------------------------------------------------------

  showCaeConstraints(
    data: {
      supports?: Float32Array | null;          // 3 floats per fixed node
      couplings?: CaeCouplingLine[] | null;
      loads?: CaeLoadArrow[] | null;
    },
    opts: { glyphMm?: number } = {},
  ) {
    this.clearCaeConstraints();
    const group = new THREE.Group();
    const s = opts.glyphMm ?? 12;

    // --- Supports: a 4-sided pyramid apex-up, sitting just below the node. ---
    const sup = data.supports;
    if (sup && sup.length >= 3) {
      const count = Math.floor(sup.length / 3);
      const geom = new THREE.ConeGeometry(s * 0.55, s, 4);
      // Cone is +Y up around the origin; move it so the APEX touches (0,0,0)
      // and the base hangs below, then stand it up in the Z-up world.
      geom.translate(0, -s / 2, 0);
      geom.rotateX(Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0x2f7d4f, transparent: true, opacity: 0.85 });
      const inst = new THREE.InstancedMesh(geom, mat, count);
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        m4.makeTranslation(sup[i * 3], sup[i * 3 + 1], sup[i * 3 + 2]);
        inst.setMatrixAt(i, m4);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.renderOrder = 7;
      group.add(inst);
    }

    // --- Joint couplings: one segment per coupled node pair. ---
    const cpl = data.couplings;
    if (cpl && cpl.length) {
      const byClass = new Map<string, number[]>();
      for (const c of cpl) {
        const arr = byClass.get(c.stiffness) ?? [];
        arr.push(c.p0[0], c.p0[1], c.p0[2], c.p1[0], c.p1[1], c.p1[2]);
        byClass.set(c.stiffness, arr);
      }
      const color: Record<string, number> = { rigid: 0xd6336c, 'semi-rigid': 0x7048e8, hinged: 0x1c7ed6 };
      for (const [cls, arr] of byClass) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
        const line = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({
          color: color[cls] ?? 0xd6336c, transparent: true, opacity: 0.9,
        }));
        line.renderOrder = 8;
        group.add(line);
      }
    }

    // --- Loads: arrows along the applied force. ---
    let loads = data.loads;
    if (loads && loads.length) {
      // A patch load spreads over every node under it — on a fine mesh that's
      // hundreds of identical arrows, which reads as a solid thicket and hides
      // the geometry. Draw an evenly-spaced subset; the stats line carries the
      // true loaded-node count and total force.
      const MAX_ARROWS = 140;
      if (loads.length > MAX_ARROWS) {
        const step = loads.length / MAX_ARROWS;
        const thinned: CaeLoadArrow[] = [];
        for (let i = 0; i < MAX_ARROWS; i++) thinned.push(loads[Math.floor(i * step)]);
        loads = thinned;
      }
      let maxF = 0;
      for (const l of loads) maxF = Math.max(maxF, Math.hypot(l.f[0], l.f[1], l.f[2]));
      if (maxF > 0) {
        // Square-root scaling: a patch spread over many nodes still shows a
        // readable arrow instead of collapsing to a dot next to one big one.
        const len = (mag: number) => s * (1.4 + 3.4 * Math.sqrt(mag / maxF));
        const geom = arrowGlyphGeometry();      // unit length, along +Y, tip at origin
        const mat = new THREE.MeshBasicMaterial({ color: 0xc92a2a });
        const inst = new THREE.InstancedMesh(geom, mat, loads.length);
        const m4 = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const up = new THREE.Vector3(0, 1, 0);
        const dir = new THREE.Vector3();
        const scale = new THREE.Vector3();
        const at = new THREE.Vector3();
        for (let i = 0; i < loads.length; i++) {
          const l = loads[i];
          const mag = Math.hypot(l.f[0], l.f[1], l.f[2]);
          if (mag <= 0) { m4.makeScale(0, 0, 0); inst.setMatrixAt(i, m4); continue; }
          // The arrow points ALONG the force and its tip sits on the node.
          dir.set(l.f[0] / mag, l.f[1] / mag, l.f[2] / mag);
          q.setFromUnitVectors(up, dir);
          const L = len(mag);
          scale.set(s * 0.16, L, s * 0.16);
          at.set(l.at[0], l.at[1], l.at[2]);
          m4.compose(at, q, scale);
          inst.setMatrixAt(i, m4);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.renderOrder = 8;
        group.add(inst);
      }
    }

    this.caeGroup.add(group);
    this.caeConstraintGroup = group;
  }

  clearCaeConstraints() {
    if (this.caeConstraintGroup) {
      this.caeGroup.remove(this.caeConstraintGroup);
      disposeObject3D(this.caeConstraintGroup);
      this.caeConstraintGroup = null;
    }
  }

  // -------------------------------------------------------------------------
  // MAX / MIN CALLOUTS
  //
  // The MX/MN annotation every FE post-processor puts on a fringe plot: a
  // marker on the extreme node, a leader line out to clear air, and a label at
  // the end of it. The label is an HTML element tracked against the projected
  // 3D point each frame (crisp text at any zoom, and it can carry the same
  // typography as the rest of the UI), while the marker and leader are real
  // geometry so they occlude correctly against the model.
  // -------------------------------------------------------------------------

  /** Place the extreme-value callouts. Pass an empty array to clear them. */
  showCaeCallouts(marks: CaeCallout[]) {
    this.clearCaeCallouts();
    if (marks.length === 0) return;

    const group = new THREE.Group();
    const diag = this.modelDiagonal() || 1000;
    const lead = diag * 0.11;      // leader length
    const r = diag * 0.008;        // marker radius

    for (const mk of marks) {
      const at = new THREE.Vector3(...mk.at);
      // Lead up-and-out along the marker's own direction so the two callouts
      // on one model don't stack on top of each other.
      const dir = new THREE.Vector3(...(mk.dir ?? [0, 0, 1])).normalize();
      const tip = at.clone().addScaledVector(dir, lead);

      const color = new THREE.Color(mk.color);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([at, tip]),
        new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
      );
      line.renderOrder = 20;
      group.add(line);

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      );
      dot.position.copy(at);
      dot.renderOrder = 21;
      group.add(dot);

      const el = document.createElement('div');
      el.className = 'cae-callout';
      el.style.setProperty('--cae-callout-color', mk.color);
      el.innerHTML =
        `<span class="cae-callout-tag">${escapeCalloutText(mk.tag)}</span>`
        + `<span class="cae-callout-val">${escapeCalloutText(mk.value)}</span>`
        + (mk.sub ? `<span class="cae-callout-sub">${escapeCalloutText(mk.sub)}</span>` : '');
      this.renderer.domElement.parentElement?.appendChild(el);
      this.caeCallouts.push({ el, anchor: tip, x: NaN, y: NaN, hidden: false });
    }

    this.caeGroup.add(group);
    this.caeCalloutGroup = group;
    this.updateCalloutPositions();
  }

  clearCaeCallouts() {
    if (this.caeCalloutGroup) {
      this.caeGroup.remove(this.caeCalloutGroup);
      disposeObject3D(this.caeCalloutGroup);
      this.caeCalloutGroup = null;
    }
    for (const c of this.caeCallouts) c.el.remove();
    this.caeCallouts = [];
  }

  /**
   * Project each callout anchor to screen space. Runs every frame, so it only
   * TOUCHES the DOM when a label has actually moved by a visible amount —
   * writing the same style values every frame keeps the subtree permanently
   * "unstable", which stalls anything waiting on it (screenshot capture, and
   * the browser's own layout work).
   */
  private updateCalloutPositions() {
    if (this.caeCallouts.length === 0) return;
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const v = new THREE.Vector3();
    for (const c of this.caeCallouts) {
      v.copy(c.anchor).project(this.camera);
      const behind = v.z > 1;
      if (behind !== c.hidden) {
        c.el.style.display = behind ? 'none' : '';
        c.hidden = behind;
      }
      if (behind) continue;
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      if (Math.abs(x - c.x) < 0.25 && Math.abs(y - c.y) < 0.25) continue;
      c.x = x; c.y = y;
      c.el.style.left = `${x.toFixed(1)}px`;
      c.el.style.top = `${y.toFixed(1)}px`;
    }
  }

  /**
   * Hide (or restore) the CAD solids while the FE mesh is shown. The mesh IS
   * the model in this view — leaving the shaded solids underneath puts a second
   * surface at almost the same depth, which z-fights the contour and tints it.
   * The grain arrows and the selection outlines go with them.
   */
  setCaeMeshFocus(on: boolean) {
    if (this.caeMeshFocus === on) return;
    this.caeMeshFocus = on;
    for (const b of this.bodies) b.mesh.visible = !on;
    this.nonSheetGroup.visible = !on;
    this.grainGroup.visible = !on;
    // Outline passes raycast against hidden meshes otherwise.
    this.outlinePass.enabled = !on;
    this.outlineDimPass.enabled = !on;
    // Ambient occlusion contributes nothing to a flat-shaded fringe plot — it
    // just darkens the contour — and it is by far the most expensive pass in
    // the chain. Dropping it while the mesh view is up is what keeps a
    // 100k-DOF mesh interactive to orbit.
    this.ssaoPass.enabled = !on;
  }

  resize(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.ssaoPass.setSize(w, h);
    this.outlinePass.setSize(w, h);
    this.outlineDimPass.setSize(w, h);
    this.smaaPass.setSize(w * window.devicePixelRatio, h * window.devicePixelRatio);
  }

  clear() {
    for (const b of this.bodies) {
      this.root.remove(b.mesh);
      b.mesh.geometry.dispose();
      (b.mesh.material as THREE.Material).dispose();
    }
    this.bodies = [];
    this.selection.clear();
    this.hovered = null;
    this.outlinePass.selectedObjects = [];
    this.outlineDimPass.selectedObjects = [];
    for (const g of this.grainArrows.values()) { this.grainGroup.remove(g); disposeObject3D(g); }
    this.grainArrows.clear();
    this.grainStates.clear();
    this.grainConfigs.clear();
    // Structural-analysis overlays
    this.clearAssemblyOverlay();
    for (const ls of this.caeWeakOutlines.values()) { this.caeGroup.remove(ls); disposeObject3D(ls); }
    this.caeWeakOutlines.clear();
  }

  /**
   * Replace all loaded geometry with the meshes from a single OCCT result.
   * Used for single-file drops; for multi-file accumulation use addOcctMesh
   * instead.
   */
  loadResult(res: OcctResult) {
    this.clear();
    let validIdx = 0;
    res.meshes.forEach((m, idx) => {
      const indices = m.index?.array;
      if (!indices || indices.length < 3) return;
      const hex = bodyColor(validIdx);
      this.addOcctMesh(m, idx, hex, m.name && m.name.trim() ? m.name : `Body ${idx + 1}`);
      validIdx++;
    });
    this.frameAll();
    this.refreshColors();
  }

  /**
   * Append a single OCCT mesh with the supplied stable id + color + display
   * name. Caller (multi-file path) chooses globally-unique ids so IDs don't
   * collide between files. Does not call frameAll() — caller should call
   * frameAll() once after the batch.
   */
  addOcctMesh(m: OcctMesh, id: number, hex: string, name: string) {
    const indices = m.index?.array;
    if (!indices || indices.length < 3) return;
    const mesh = this.meshFromOcct(m, id, hex);
    this.root.add(mesh);
    this.bodies.push({ id, name, mesh, hexColor: hex });
  }

  /**
   * Render a body that ISN'T a sheet good (round leg, dowel, block, etc.):
   * light red translucent fill + dashed outline. It's visible in 3D so the
   * user can see what was imported and skipped, but it's not added to the
   * selectable bodies list or the nester.
   */
  addNonSheetMesh(m: OcctMesh) {
    const indices = m.index?.array;
    if (!indices || indices.length < 3) return;

    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(m.attributes.position.array);
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (m.attributes.normal) {
      geom.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.attributes.normal.array), 3));
    }
    const Index = indices.length > 65535 ? Uint32Array : Uint16Array;
    geom.setIndex(new THREE.BufferAttribute(new Index(indices), 1));
    if (!m.attributes.normal) geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0xff8a8a,
      transparent: true,
      opacity: 0.28,
      roughness: 0.6,
      metalness: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.nonSheetGroup.add(mesh);

    // Dashed edge outline at sharp angles. LineDashedMaterial needs
    // computeLineDistances() after geometry creation.
    const edgesGeom = new THREE.EdgesGeometry(geom, 25);
    const edges = new THREE.LineSegments(
      edgesGeom,
      new THREE.LineDashedMaterial({
        color: 0xd44a4a,
        dashSize: 3,
        gapSize: 2.5,
        transparent: true,
        opacity: 0.9,
      }),
    );
    edges.computeLineDistances();
    edges.renderOrder = 3;
    this.nonSheetGroup.add(edges);
  }

  /** Frame everything currently loaded and refresh selection colors. */
  finishLoad() {
    this.frameAll();
    this.refreshColors();
  }

  /**
   * Snapshot the current 3D scene as a base64 JPEG.
   * JPEG, not PNG: the canvas encode is several times faster AND jsPDF
   * embeds JPEG bytes directly (DCTDecode) instead of decoding a PNG in
   * JS — together the dominant cost of PDF generation. Snapshots render
   * on the opaque white PDF background, so alpha is never needed.
   * Returns the canvas pixel dimensions too so callers can preserve
   * aspect ratio when placing the image elsewhere (e.g. in a PDF).
   */
  snapshot(): { dataUrl: string; width: number; height: number } {
    this.composer.render();
    const c = this.renderer.domElement;
    return { dataUrl: c.toDataURL('image/jpeg', 0.9), width: c.width, height: c.height };
  }

  /**
   * Snapshot an exploded view: each body is temporarily translated along
   * its `direction` by `distance` mm (typically the body's outward face
   * normal × bbox-diagonal × ~0.3). Original positions are restored
   * before returning so the live view is unaffected.
   *
   * Pass `selectionOnly: true` to only explode selected bodies (the rest
   * stay assembled).
   */
  snapshotExploded(
    directions: Map<number, [number, number, number]>,
    distance: number,
    selectionOnly = false,
  ): { dataUrl: string; width: number; height: number } {
    const backup = new Map<number, THREE.Vector3>();
    for (const b of this.bodies) {
      if (selectionOnly && !this.selection.has(b.id)) continue;
      const dir = directions.get(b.id);
      if (!dir) continue;
      backup.set(b.id, b.mesh.position.clone());
      b.mesh.position.x += dir[0] * distance;
      b.mesh.position.y += dir[1] * distance;
      b.mesh.position.z += dir[2] * distance;
    }
    this.composer.render();
    const c = this.renderer.domElement;
    const out = { dataUrl: c.toDataURL('image/jpeg', 0.9), width: c.width, height: c.height };
    // Restore so the live viewer doesn't visibly jump
    for (const b of this.bodies) {
      const bk = backup.get(b.id);
      if (bk) b.mesh.position.copy(bk);
    }
    this.composer.render();
    return out;
  }

  /**
   * Switch the scene to a clean white background + faint shadow floor for
   * PDF capture. Call enterPdfBg() before snapshot(), then exitPdfBg() after.
   * The dark studio backdrop is restored on exit so the live viewer is
   * unaffected.
   */
  private _pdfBgBackup: {
    background: any;
    envMapIntensity: number[];
    shadowOpacity: number;
    hemiIntensity: number;
    toneExposure: number;
  } | null = null;
  enterPdfBg() {
    if (this._pdfBgBackup) return; // already in PDF mode
    const shadowMat = this.shadowFloor.material as THREE.ShadowMaterial;
    const envIntensities: number[] = [];
    for (const b of this.bodies) {
      const m = b.mesh.material as THREE.MeshPhysicalMaterial;
      envIntensities.push(m.envMapIntensity);
      m.envMapIntensity = 0.65; // brighter for white bg
    }
    this._pdfBgBackup = {
      background: this.scene.background,
      envMapIntensity: envIntensities,
      shadowOpacity: shadowMat.opacity,
      hemiIntensity: this.hemi.intensity,
      toneExposure: this.renderer.toneMappingExposure,
    };
    this.scene.background = new THREE.Color(0xffffff);
    shadowMat.opacity = 0.12;
    this.hemi.intensity = 0.55;          // lift fill so whites stay white
    this.renderer.toneMappingExposure = 1.05;
  }
  exitPdfBg() {
    if (!this._pdfBgBackup) return;
    const shadowMat = this.shadowFloor.material as THREE.ShadowMaterial;
    this.scene.background = this._pdfBgBackup.background;
    shadowMat.opacity = this._pdfBgBackup.shadowOpacity;
    this.hemi.intensity = this._pdfBgBackup.hemiIntensity;
    this.renderer.toneMappingExposure = this._pdfBgBackup.toneExposure;
    for (let i = 0; i < this.bodies.length; i++) {
      const m = this.bodies[i].mesh.material as THREE.MeshPhysicalMaterial;
      m.envMapIntensity = this._pdfBgBackup.envMapIntensity[i] ?? m.envMapIntensity;
    }
    this._pdfBgBackup = null;
    this.composer.render(); // restore the visible scene
  }

  /** Diagonal length of the AABB enclosing all loaded bodies, in world mm. */
  modelDiagonal(): number {
    const box = new THREE.Box3();
    for (const b of this.bodies) box.expandByObject(b.mesh);
    if (box.isEmpty()) return 0;
    const size = new THREE.Vector3();
    box.getSize(size);
    return size.length();
  }

  // While a snapshot batch is open, snapshotFiltered skips its per-call
  // renderer resize AND the restore-the-live-view re-render — both are pure
  // waste between consecutive snapshots. Holds the ORIGINAL live-view size
  // to restore when the batch ends.
  private _snapBatch: { size: THREE.Vector2; aspect: number } | null = null;

  /**
   * Open (or re-target) a snapshot batch: size the renderer for a BURST of
   * same-size snapshots. Resizing a WebGL renderer reallocates the
   * multisampled + SMAA render targets — doing that (plus a live-view
   * re-render) per snapshot dominated PDF generation time. Call again with a
   * different target to switch sizes mid-batch (one realloc), and
   * endSnapshotBatch() once when every capture is done.
   */
  beginSnapshotBatch(target: { w: number; h: number }) {
    if (!this._snapBatch) {
      this._snapBatch = {
        size: this.renderer.getSize(new THREE.Vector2()),
        aspect: this.camera.aspect,
      };
    }
    this.renderer.setSize(target.w, target.h, false);
    this.composer.setSize(target.w, target.h);
    this.camera.aspect = target.w / target.h;
    this.camera.updateProjectionMatrix();
  }

  /** Restore the live-view renderer size and repaint. Safe to call when no
   *  batch is open. */
  endSnapshotBatch() {
    if (!this._snapBatch) return;
    this.renderer.setSize(this._snapBatch.size.x, this._snapBatch.size.y, false);
    this.composer.setSize(this._snapBatch.size.x, this._snapBatch.size.y);
    this.camera.aspect = this._snapBatch.aspect;
    this.camera.updateProjectionMatrix();
    this._snapBatch = null;
    this.composer.render();
  }

  /**
   * Snapshot ONLY a subset of bodies (e.g. one cabinet's panels per STEP file).
   *
   * Hides everything not in `visibleIds`, refits the camera to the subset,
   * optionally explodes by `directions × distance`, renders, then restores
   * visibility AND the camera. Used for per-cabinet assembly pages.
   */
  snapshotFiltered(
    visibleIds: Set<number>,
    directions: Map<number, [number, number, number]> | null,
    distance: number,
    /** When provided, frame the camera to THESE bodies instead of `visibleIds`.
     *  Used for IKEA-style step snapshots so every step in a sequence shares
     *  one consistent camera (frameIds = the full cabinet, even when only a
     *  subset is visible this step). */
    frameIds?: Set<number>,
    /** Target canvas dimensions for the rendered snapshot. Defaults to the
     *  current renderer size. Use for high-resolution PDF embedding — e.g.
     *  pass { w: 1600, h: 1000 } to get a sharp wide image regardless of the
     *  user's window size. The renderer is resized for the snapshot and
     *  restored afterwards, transparently to the live viewer. */
    target?: { w: number; h: number },
  ): { dataUrl: string; width: number; height: number } {
    // 0. (Optional) resize the renderer for a high-resolution snapshot.
    //    Inside a snapshot batch the renderer is already sized — skip the
    //    (expensive) per-call resize entirely.
    const inBatch = this._snapBatch !== null;
    const sizeBackup = this.renderer.getSize(new THREE.Vector2());
    const aspectBackup = this.camera.aspect;
    if (target && !inBatch) {
      this.renderer.setSize(target.w, target.h, false);
      this.composer.setSize(target.w, target.h);
      this.camera.aspect = target.w / target.h;
    }
    // 1. Snapshot current visibility + positions
    const visBackup = new Map<number, boolean>();
    const posBackup = new Map<number, THREE.Vector3>();
    for (const b of this.bodies) {
      visBackup.set(b.id, b.mesh.visible);
      b.mesh.visible = visibleIds.has(b.id);
    }
    // Hide non-sheet bodies (red ghost meshes for legs, dowels, etc.) and
    // grain arrows during a clean per-cabinet snapshot.
    const grainBackup: { obj: THREE.Object3D; vis: boolean }[] = [];
    this.grainGroup.children.forEach((c) => {
      grainBackup.push({ obj: c, vis: c.visible });
      c.visible = false;
    });
    const nonSheetVisBackup = this.nonSheetGroup.visible;
    this.nonSheetGroup.visible = false;
    // Hide the floor grid too — assembly/exploded diagrams read cleaner
    // without a drafting grid under the parts.
    const gridVisBackup = this.grid.visible;
    this.grid.visible = false;

    // 2. Refit camera + shadow camera to the visible bodies
    const cameraBackup = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
      near: this.camera.near,
      far: this.camera.far,
    };
    const box = new THREE.Box3();
    const fids = frameIds ?? visibleIds;
    for (const b of this.bodies) if (fids.has(b.id)) box.expandByObject(b.mesh);
    if (!box.isEmpty()) {
      const size = new THREE.Vector3(); box.getSize(size);
      const center = new THREE.Vector3(); box.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z) + distance * 2;
      const fov = (this.camera.fov * Math.PI) / 180;
      // Distance multiplier was 1.7 — the cabinet floated in lots of empty
      // background. 1.25 frames it tightly with a small margin so the
      // assembly fills the snapshot, much more readable in the PDF cards.
      const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.25;
      this.controls.target.copy(center);
      this.camera.position.copy(
        center.clone().add(new THREE.Vector3(1.0, -1.2, 0.9).normalize().multiplyScalar(dist)),
      );
      this.camera.near = Math.max(0.1, maxDim / 1000);
      this.camera.far = maxDim * 100;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }

    // 3. Optionally explode the visible subset. For each body we explode we
    //    also drop a TRANSPARENT "ghost" clone at the body's rest position —
    //    classic IKEA convention showing where the panel will land.
    const explodeBackup = new Map<number, THREE.Vector3>();
    const ghosts: THREE.Mesh[] = [];
    if (directions) {
      for (const b of this.bodies) {
        if (!visibleIds.has(b.id)) continue;
        const dir = directions.get(b.id);
        if (!dir) continue;
        // Ghost = same geometry, faintly transparent — placed at the body's
        // CURRENT (rest) position before we move the original out.
        const ghostMat = new THREE.MeshBasicMaterial({
          color: (b.mesh.material as THREE.MeshPhysicalMaterial).color,
          transparent: true,
          opacity: 0.15,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const ghost = new THREE.Mesh(b.mesh.geometry, ghostMat);
        ghost.position.copy(b.mesh.position);
        ghost.rotation.copy(b.mesh.rotation);
        ghost.scale.copy(b.mesh.scale);
        ghost.castShadow = false;
        ghost.receiveShadow = false;
        ghost.renderOrder = 2;
        this.root.add(ghost);
        ghosts.push(ghost);
        // Now actually explode the original.
        explodeBackup.set(b.id, b.mesh.position.clone());
        b.mesh.position.x += dir[0] * distance;
        b.mesh.position.y += dir[1] * distance;
        b.mesh.position.z += dir[2] * distance;
      }
    }

    // 4. Render + grab (canvas dims captured for downstream aspect-fit)
    this.composer.render();
    const c = this.renderer.domElement;
    const out = { dataUrl: c.toDataURL('image/jpeg', 0.9), width: c.width, height: c.height };

    // 5. Restore EVERYTHING — remove ghosts, restore positions and visibility.
    for (const g of ghosts) {
      this.root.remove(g);
      (g.material as THREE.Material).dispose();
    }
    for (const b of this.bodies) {
      const v = visBackup.get(b.id);
      if (v !== undefined) b.mesh.visible = v;
      const p = explodeBackup.get(b.id);
      if (p) b.mesh.position.copy(p);
    }
    for (const g of grainBackup) g.obj.visible = g.vis;
    this.nonSheetGroup.visible = nonSheetVisBackup;
    this.grid.visible = gridVisBackup;
    this.camera.position.copy(cameraBackup.pos);
    this.controls.target.copy(cameraBackup.target);
    this.camera.near = cameraBackup.near;
    this.camera.far = cameraBackup.far;
    // Restore renderer size + camera aspect if we changed them for the
    // snapshot. In a batch both stay put (endSnapshotBatch restores), and
    // the live-view repaint is skipped — the next snapshot re-renders anyway.
    if (target && !inBatch) {
      this.renderer.setSize(sizeBackup.x, sizeBackup.y, false);
      this.composer.setSize(sizeBackup.x, sizeBackup.y);
      this.camera.aspect = aspectBackup;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
    if (!inBatch) this.composer.render();
    return out;
  }

  private meshFromOcct(m: OcctMesh, idx: number, hex: string): THREE.Mesh {
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(m.attributes.position.array);
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (m.attributes.normal) {
      const nrm = new Float32Array(m.attributes.normal.array);
      geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    }
    const indexArr = m.index.array;
    const Index = indexArr.length > 65535 ? Uint32Array : Uint16Array;
    geom.setIndex(new THREE.BufferAttribute(new Index(indexArr), 1));
    if (!m.attributes.normal) geom.computeVertexNormals();
    geom.computeBoundingSphere();

    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(hex),
      metalness: 0.0,
      roughness: 0.6,
      clearcoat: 0.35,
      clearcoatRoughness: 0.3,
      side: THREE.DoubleSide,
      // Keep env reflections very subtle — Room env was washing diffuse
      // toward white. Specular pop comes from the direct key + rim lights.
      envMapIntensity: 0.25,
    });
    // Subtle Fresnel rim — slightly lifts silhouettes off the background
    // without flooding the diffuse with white (which is what was making
    // every body look pastel).
    const rimTint = new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), 0.7);
    addFresnelRim(mat, rimTint, 2.8, 0.18);

    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.bodyId = idx;
    mesh.userData.baseHex = hex;

    // Two-layer edge overlay:
    //   - Tangential edges (small dihedral angles): smooth transitions like
    //     a cylinder side meeting a flat top. Drawn LIGHTER (lerp toward
    //     white) so they suggest curvature without competing.
    //   - Solid edges (sharp angles ≥25°): corners, intersection of flat
    //     faces. Drawn DARKER (lerp toward black) so silhouettes pop.
    // Tangential is rendered below so the solid layer wins at shared verts.
    const tangentialGeom = new THREE.EdgesGeometry(geom, 5);
    const tangentialColor = new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), 0.78);
    const tangential = new THREE.LineSegments(
      tangentialGeom,
      new THREE.LineBasicMaterial({
        color: tangentialColor,
        transparent: true,
        opacity: 0.55,
        depthTest: true,
      }),
    );
    tangential.userData.isEdge = true;
    tangential.userData.isTangential = true;
    tangential.userData.bodyId = idx;
    tangential.renderOrder = 2;
    mesh.add(tangential);

    const solidGeom = new THREE.EdgesGeometry(geom, 25);
    const solidColor = new THREE.Color(hex).lerp(new THREE.Color('#0a0a0a'), 0.55);
    const edges = new THREE.LineSegments(
      solidGeom,
      new THREE.LineBasicMaterial({
        color: solidColor,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
      }),
    );
    edges.userData.isEdge = true;
    edges.userData.bodyId = idx;
    edges.renderOrder = 3;
    mesh.add(edges);
    mesh.userData.edges = edges;
    mesh.userData.tangentialEdges = tangential;

    return mesh;
  }

  frameAll() {
    const box = new THREE.Box3();
    for (const b of this.bodies) {
      box.expandByObject(b.mesh);
    }
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.7;
    this.controls.target.copy(center);
    // Z-up: place camera with positive Z (above) and offset on -Y / +X
    this.camera.position.copy(
      center.clone().add(new THREE.Vector3(1.0, -1.2, 0.9).normalize().multiplyScalar(dist)),
    );
    this.camera.near = Math.max(0.1, maxDim / 1000);
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // GTAO radius is in world units — tie to model scale so creases get
    // shaded similarly regardless of model size (mm vs in vs m).
    this.ssaoPass.updateGtaoMaterial({
      radius: Math.max(0.05, maxDim * 0.05),
      distanceExponent: 1.4,
      thickness: Math.max(0.05, maxDim * 0.05),
      scale: 1.0,
    });
    // Constrain GTAO sampling to the model bbox so background pixels don't
    // bleed into the AO and create halos around the silhouette.
    const aoBox = box.clone().expandByScalar(maxDim * 0.05);
    this.ssaoPass.setSceneClipBox(aoBox);

    // Position the key light and its shadow camera to the model
    const r = maxDim * 0.9;
    this.key.position.set(center.x + r * 0.55, center.y - r * 0.85, center.z + r * 1.1);
    this.key.target.position.copy(center);
    this.scene.add(this.key.target);
    const sc = this.key.shadow.camera as THREE.OrthographicCamera;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = Math.max(0.1, maxDim * 0.01);
    sc.far = maxDim * 6;
    sc.updateProjectionMatrix();

    this.rim.position.set(center.x - r, center.y + r * 0.9, center.z + r * 0.6);

    // Drop the shadow floor just below the model bottom (Z is up)
    this.shadowFloor.position.z = box.min.z - maxDim * 0.001;

    // Wrap the floor grid tightly around the model's footprint (+ margin).
    this.fitGridToModel(box);

    // Refresh outline selection cache after the body list changed.
    this.refreshOutlines();
  }

  /**
   * Resize + recentre the floor grid so it spans the model's XY footprint
   * plus a margin, with tidy cell spacing. Rebuilds the GridHelper (its size
   * is fixed at construction). Sits on the model's lowest Z so it reads as the
   * ground the parts rest on.
   */
  private fitGridToModel(box: THREE.Box3) {
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    // ~20% clear margin around the parts on every side.
    const footprint = Math.max(size.x, size.y, 1);
    const span = footprint * 1.4;

    // Snap the cell size to a tidy number near span/20 so the grid reads as a
    // drafting grid rather than arbitrary spacing.
    const nice = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000];
    const target = span / 20;
    let cell = nice[nice.length - 1];
    for (const n of nice) { if (n >= target) { cell = n; break; } }
    const divisions = Math.max(2, Math.round(span / cell));
    const realSpan = divisions * cell;

    const old = this.grid;
    this.scene.remove(old);
    old.geometry.dispose();
    (old.material as THREE.Material).dispose();

    const grid = new THREE.GridHelper(realSpan, divisions, 0x9b9a97, 0xcfceca);
    grid.rotation.x = Math.PI / 2; // GridHelper is XZ by default → rotate to XY (Z-up)
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.set(center.x, center.y, box.min.z);
    this.scene.add(grid);
    this.grid = grid;
  }

  toggleSelection(id: number) {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.refreshColors();
    this.refreshGrainArrows();
    this.onSelectionChange?.();
  }

  setSelection(ids: number[]) {
    this.selection = new Set(ids);
    this.refreshColors();
    this.refreshGrainArrows();
    this.onSelectionChange?.();
  }

  selectAll() { this.setSelection(this.bodies.map((b) => b.id)); }
  selectNone() { this.setSelection([]); }

  private refreshColors() {
    const anySelected = this.selection.size > 0;
    for (const b of this.bodies) {
      const mat = b.mesh.material as THREE.MeshPhysicalMaterial;
      const edgeMat = (b.mesh.userData.edges as THREE.LineSegments | undefined)
        ?.material as THREE.LineBasicMaterial | undefined;
      const tanMat = (b.mesh.userData.tangentialEdges as THREE.LineSegments | undefined)
        ?.material as THREE.LineBasicMaterial | undefined;
      const solidDark = new THREE.Color(b.hexColor).lerp(new THREE.Color('#0a0a0a'), 0.55);
      const tangentialLight = new THREE.Color(b.hexColor).lerp(new THREE.Color('#ffffff'), 0.78);
      mat.color.set(b.hexColor);
      if (this.selection.has(b.id)) {
        mat.opacity = 1.0;
        mat.transparent = false;
        mat.emissive = new THREE.Color(b.hexColor).multiplyScalar(0.22);
        if (edgeMat) { edgeMat.opacity = 0.95; edgeMat.color.copy(solidDark); }
        if (tanMat)  { tanMat.opacity  = 0.55; tanMat.color.copy(tangentialLight); }
      } else if (b.id === this.hovered) {
        mat.color.copy(COLOR_HOVER);
        mat.opacity = 1.0;
        mat.transparent = false;
        mat.emissive = new THREE.Color('#06140f');
        if (edgeMat) { edgeMat.opacity = 1.0; edgeMat.color.set('#0a1a14'); }
        if (tanMat)  { tanMat.opacity  = 0.6; tanMat.color.set('#cdeede'); }
      } else {
        mat.emissive = new THREE.Color('#000');
        if (anySelected) {
          mat.opacity = DIM_OPACITY;
          mat.transparent = true;
          if (edgeMat) { edgeMat.opacity = 0.7; edgeMat.color.copy(solidDark); }
          if (tanMat)  { tanMat.opacity  = 0.3; tanMat.color.copy(tangentialLight); }
        } else {
          mat.opacity = 1.0;
          mat.transparent = false;
          if (edgeMat) { edgeMat.opacity = 0.95; edgeMat.color.copy(solidDark); }
          if (tanMat)  { tanMat.opacity  = 0.55; tanMat.color.copy(tangentialLight); }
        }
      }
      mat.needsUpdate = true;
    }
    this.refreshOutlines();
  }

  /** Sync the outline-pass selection lists with current state. */
  private refreshOutlines() {
    // outlinePass: white emphasis halo around explicitly selected bodies.
    const selected: THREE.Object3D[] = [];
    for (const b of this.bodies) {
      if (this.selection.has(b.id)) selected.push(b.mesh);
    }
    this.outlinePass.selectedObjects = selected;

    // outlineDimPass: subtle green halo around just the hovered body (only
    // when it's NOT already in the selected set — to avoid double-outline).
    const hoverMesh =
      this.hovered != null && !this.selection.has(this.hovered)
        ? this.bodies.find((b) => b.id === this.hovered)?.mesh
        : undefined;
    this.outlineDimPass.selectedObjects = hoverMesh ? [hoverMesh] : [];
  }

  private handlePointerMove = (ev: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.bodies.map((b) => b.mesh), false);
    const newHover = hits.length ? (hits[0].object.userData.bodyId as number) : null;
    if (newHover !== this.hovered) {
      this.hovered = newHover;
      this.refreshColors();
    }
  };

  private handleClick = (ev: MouseEvent) => {
    if ((ev as any).detail === 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Assembly-placement mode: the next click on ANY panel's face fires the
    // callback with the clicked body's id. Used to place a load on whichever
    // cabinet panel the user clicks.
    if (this.asmPlacePick) {
      const pick = this.asmPlacePick;
      const anyHit = this.raycaster.intersectObjects(this.bodies.map((b) => b.mesh), false)[0];
      if (anyHit) {
        const id = anyHit.object.userData.bodyId as number;
        const n = (anyHit.face ? anyHit.face.normal.clone() : new THREE.Vector3(0, 0, 1)).normalize();
        this.asmPlacePick = null;
        pick(id, [anyHit.point.x, anyHit.point.y, anyHit.point.z], [n.x, n.y, n.z]);
      }
      // click missed everything — stay in place mode, ignore this click.
      return;
    }

    // Force-placement mode: capture the next click on the target body's face.
    if (this.caePlacePick) {
      const pick = this.caePlacePick;
      const body = this.bodies.find((b) => b.id === pick.bodyId);
      if (body) {
        const hit = this.raycaster.intersectObject(body.mesh, false)[0];
        if (hit) {
          const n = (hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1)).normalize();
          this.caePlacePick = null;
          pick.cb(hit.point.clone(), n);
          return;
        }
      }
      // click missed the body — stay in place mode, ignore this click.
      return;
    }

    // Test grain-arrow hits first so the arrow can intercept clicks that
    // would otherwise be treated as body picks.
    const arrowHits = this.raycaster.intersectObjects(this.grainGroup.children, true);
    if (arrowHits.length) {
      const bid = findBodyIdOnAncestor(arrowHits[0].object);
      if (bid != null) {
        this.onGrainCycle?.(bid);
        return;
      }
    }

    const hits = this.raycaster.intersectObjects(this.bodies.map((b) => b.mesh), false);
    if (hits.length) {
      const id = hits[0].object.userData.bodyId as number;
      this.toggleSelection(id);
    }
  };

  private tick = () => {
    requestAnimationFrame(this.tick);
    this.controls.update();
    this.composer.render();
    // Callout labels are DOM, so they have to follow the camera every frame.
    this.updateCalloutPositions();
  };
}

/**
 * Inject a soft Fresnel-style rim term into a MeshPhysicalMaterial's
 * fragment shader. Adds `rimColor * pow(1 - dot(N,V), power) * strength` to
 * the final emissive contribution — independent of scene lighting, so it
 * always lifts silhouettes off the background.
 */
function addFresnelRim(
  mat: THREE.MeshPhysicalMaterial,
  rimColor: THREE.Color,
  power: number,
  strength: number,
) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimPower = { value: power };
    shader.uniforms.uRimStrength = { value: strength };

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
       uniform vec3 uRimColor;
       uniform float uRimPower;
       uniform float uRimStrength;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <output_fragment>',
      `float rimDot = 1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
       vec3 rim = uRimColor * pow(rimDot, uRimPower) * uRimStrength;
       diffuseColor.rgb += rim;
       #include <output_fragment>`,
    );
  };
}

/**
 * Build a 4×512 CanvasTexture combining a vertical studio gradient with a
 * very subtle radial vignette. Renders parts on a "soft stage" rather than
 * a flat dark wall.
 */
function makeStudioBackground(): THREE.CanvasTexture {
  const W = 512;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Light "Notion-paper" backdrop. Warm off-white at the top fading to a
  // slightly grayer floor so the model has a sense of ground without going
  // dark. A subtle radial vignette behind the model lifts it forward.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.0, '#FAF9F6');
  g.addColorStop(0.55, '#F2F1ED');
  g.addColorStop(1.0, '#E4E3DE');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Soft radial lift behind the model — a touch brighter at the center so
  // the geometry sits in front of the brightest part of the backdrop.
  const r = ctx.createRadialGradient(W / 2, H * 0.42, 20, W / 2, H * 0.42, W * 0.65);
  r.addColorStop(0.0, 'rgba(255, 255, 255, 0.55)');
  r.addColorStop(0.5, 'rgba(255, 255, 255, 0.15)');
  r.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Grain arrow.
//
// A flat, minimal arrow that lies on the panel's top face at its centroid.
// Always in the panel's XY plane (never along thickness / Z — that has no
// physical meaning for plywood grain). For "free" we render a double-headed
// arrow along the LENGTH axis: plywood grain naturally runs parallel to the
// longer edge, so "free" visually defaults to the natural orientation.
//
// Color semantics:
//   length → green   (panel's long axis = grain direction; the natural pick)
//   width  → orange  (rotated 90°, against natural grain)
//   free   → gray    (no constraint locked; doubleheaded along length)
//
// Geometry is a single flat ExtrudeGeometry of a 2D arrow shape with a
// generous click target. Sits a hair above topZ so it doesn't z-fight.
// ---------------------------------------------------------------------------

// Darker, denser colors — they need to read on light wood faces.
const GRAIN_COLORS: Record<GrainLock, number> = {
  free:   0x2d3340,
  length: 0x0e7b3a,
  width:  0xb3520a,
};

/**
 * Build a grain-arrow widget for a single body.
 *
 * Layout:
 *   - One arrow set on each of the two flat faces (front + back).
 *   - grain='length' → single arrow along length on each face.
 *   - grain='width'  → single arrow along width on each face.
 *   - grain='free'   → TWO perpendicular arrows (length + width) on each face.
 *   - Each arrow is wrapped in an invisible oversize hit box so clicks land
 *     even when the visible geometry is small.
 */
function buildGrainArrow(bodyId: number, grain: GrainLock, cfg: GrainArrowConfig): THREE.Group {
  const group = new THREE.Group();
  group.userData.bodyId = bodyId;
  group.userData.isGrainArrow = true;

  const faceNormal = new THREE.Vector3(...cfg.faceNormal);
  // +face centroid (provided) and -face centroid (walk back by thickness).
  const plusCenter = new THREE.Vector3(...cfg.faceCenter);
  const minusCenter = plusCenter.clone().addScaledVector(faceNormal, -cfg.thickness);

  // +face arrows pointing along +faceNormal
  group.add(buildArrowsOnFace(bodyId, grain, cfg, faceNormal.clone(), plusCenter));
  // -face arrows pointing along -faceNormal
  group.add(buildArrowsOnFace(bodyId, grain, cfg, faceNormal.clone().negate(), minusCenter));

  return group;
}

/** Build the arrow set for ONE face, anchored at faceCenter with normal zWorld. */
function buildArrowsOnFace(
  bodyId: number,
  grain: GrainLock,
  cfg: GrainArrowConfig,
  zWorld: THREE.Vector3,
  faceCenter: THREE.Vector3,
): THREE.Group {
  const subgroup = new THREE.Group();
  subgroup.userData.bodyId = bodyId;
  subgroup.userData.isGrainArrow = true;

  const minDim = Math.min(cfg.length, cfg.width);
  const armLen = clamp(minDim * 0.42, 30, 220);
  const lengthW = new THREE.Vector3(...cfg.lengthDir);
  const widthW  = new THREE.Vector3(...cfg.widthDir);

  if (grain === 'free') {
    // TWO perpendicular arrows (a "+") — one along length, one along width.
    subgroup.add(buildSingleArrow(bodyId, GRAIN_COLORS.free, armLen, false, lengthW, widthW, zWorld));
    subgroup.add(buildSingleArrow(bodyId, GRAIN_COLORS.free, armLen, false, widthW,  lengthW, zWorld));
  } else if (grain === 'length') {
    subgroup.add(buildSingleArrow(bodyId, GRAIN_COLORS.length, armLen, false, lengthW, widthW, zWorld));
  } else {
    subgroup.add(buildSingleArrow(bodyId, GRAIN_COLORS.width, armLen, false, widthW, lengthW, zWorld));
  }

  // Lift off the face along its outward normal so we don't z-fight.
  const lift = 0.6;
  subgroup.position.set(
    faceCenter.x + zWorld.x * lift,
    faceCenter.y + zWorld.y * lift,
    faceCenter.z + zWorld.z * lift,
  );
  return subgroup;
}

function buildSingleArrow(
  bodyId: number,
  color: number,
  armLen: number,
  isDouble: boolean,
  xWorld: THREE.Vector3,
  yWorld: THREE.Vector3,
  zWorld: THREE.Vector3,
): THREE.Group {
  const g = new THREE.Group();
  g.userData.bodyId = bodyId;
  g.userData.isGrainArrow = true;

  const shaftThick = armLen * 0.09;
  const headLen = armLen * 0.32;
  const headHalf = armLen * 0.20;

  const shape = buildArrowShape(armLen, shaftThick, headLen, headHalf, isDouble);
  const extrude = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.6, armLen * 0.012),
    bevelEnabled: false,
    curveSegments: 6,
  });

  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.05, // mostly diffuse so darker reads as darker
    metalness: 0.0,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(extrude, mat);
  mesh.userData.bodyId = bodyId;
  mesh.userData.isGrainArrow = true;

  // Local frame → world: local +X→xWorld, +Y→yWorld, +Z→zWorld
  const basis = new THREE.Matrix4().makeBasis(xWorld, yWorld, zWorld);
  mesh.applyMatrix4(basis);
  g.add(mesh);

  // Invisible oversize hit target — a flat plane covering ~1.8× arm length.
  // Picks up clicks on near-misses around the visible arrow.
  const hitW = armLen * 1.8;
  const hitH = armLen * 0.6;
  const hitGeom = new THREE.PlaneGeometry(hitW, hitH);
  const hitMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const hit = new THREE.Mesh(hitGeom, hitMat);
  hit.applyMatrix4(basis);
  hit.userData.bodyId = bodyId;
  hit.userData.isGrainArrow = true;
  g.add(hit);

  g.renderOrder = 10;
  return g;
}

/**
 * Construct a 2D arrow shape centered on the origin, pointing along +X.
 *   - Shaft: long horizontal bar of thickness `shaftThick`.
 *   - Head: triangle at the +X end.
 *   - If `isDouble`, mirror a second head onto the -X end.
 */
function buildArrowShape(
  armLen: number,
  shaftThick: number,
  headLen: number,
  headHalf: number,
  isDouble: boolean,
): THREE.Shape {
  const half = armLen / 2;
  const sh = shaftThick / 2;
  const headBase = half - headLen;

  const s = new THREE.Shape();

  // Walk the perimeter CCW starting at the back-bottom corner.
  if (isDouble) {
    // Bottom-tail head base
    s.moveTo(-headBase, -sh);
    s.lineTo(-headBase, -headHalf);
    s.lineTo(-half, 0);
    s.lineTo(-headBase, headHalf);
    s.lineTo(-headBase, sh);
  } else {
    s.moveTo(-half, -sh);
    s.lineTo(-half, sh);
  }
  // Top of shaft → forward head
  s.lineTo(headBase, sh);
  s.lineTo(headBase, headHalf);
  s.lineTo(half, 0);
  s.lineTo(headBase, -headHalf);
  s.lineTo(headBase, -sh);
  // Close back to start
  if (isDouble) {
    s.lineTo(-headBase, -sh);
  } else {
    s.lineTo(-half, -sh);
  }
  return s;
}

// ---------------------------------------------------------------------------
// FE mesh geometry helpers
// ---------------------------------------------------------------------------

function escapeCalloutText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

/** sRGB → linear, for vertex colors fed to a three.js material. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Shell mesh → its quads (already one quad per element). */
function quadsOfShell(data: CaeMeshData): Int32Array {
  return data.elems;
}

/**
 * Solid mesh → the HULL quads only: each hex contributes 6 faces, and a face
 * shared by two hexes is interior and dropped. What's left is the outside
 * surface of the solid — which is what you want to look at, and roughly an
 * order of magnitude fewer triangles than drawing every face.
 */
function hullFacesOfHexes(data: CaeMeshData): Int32Array {
  // Local face node ordering for the hex layout used by cae.solidMeshView:
  // 0-3 = bottom (−normal) face, 4-7 = top, matched corner for corner.
  const FACES = [
    [0, 3, 2, 1], [4, 5, 6, 7],
    [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ];
  const seen = new Map<string, { quad: number[]; count: number }>();
  for (let e = 0; e < data.elemCount; e++) {
    const base = e * 8;
    for (const f of FACES) {
      const quad = [
        data.elems[base + f[0]], data.elems[base + f[1]],
        data.elems[base + f[2]], data.elems[base + f[3]],
      ];
      const key = quad.slice().sort((a, b) => a - b).join(',');
      const hit = seen.get(key);
      if (hit) hit.count++;
      else seen.set(key, { quad, count: 1 });
    }
  }
  const out: number[] = [];
  for (const { quad, count } of seen.values()) {
    if (count === 1) out.push(quad[0], quad[1], quad[2], quad[3]);
  }
  return Int32Array.from(out);
}

/** Deduplicated edge index list for a quad soup (4 indices per quad). */
function uniqueQuadEdges(quads: Int32Array): Uint32Array {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let q = 0; q < quads.length; q += 4) {
    for (let k = 0; k < 4; k++) {
      const a = quads[q + k];
      const b = quads[q + ((k + 1) % 4)];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      // Pack into one number; safe while node counts stay under ~4M.
      const key = lo * 4194304 + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a, b);
    }
  }
  return Uint32Array.from(out);
}

/**
 * A unit arrow along +Y with its TIP at the origin and its tail at y = −1,
 * so an instance matrix can place the tip on the loaded node and scale the
 * shaft to the force magnitude. Shaft radius is 1 in local X/Z — the instance
 * scale sets the real thickness.
 */
function arrowGlyphGeometry(): THREE.BufferGeometry {
  const headLen = 0.32;
  const shaft = new THREE.CylinderGeometry(1, 1, 1 - headLen, 8, 1, true);
  shaft.translate(0, -(headLen + (1 - headLen) / 2), 0);
  const head = new THREE.ConeGeometry(2.1, headLen, 8);
  head.translate(0, -headLen / 2, 0);
  return mergeGeometries([shaft, head]);
}

/** Minimal position-only geometry merge (avoids pulling in BufferGeometryUtils). */
function mergeGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts: Float32Array[] = [];
  let total = 0;
  for (const g of geoms) {
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    const arr = nonIndexed.getAttribute('position').array as Float32Array;
    parts.push(arr instanceof Float32Array ? arr : Float32Array.from(arr));
    total += arr.length;
    if (nonIndexed !== g) nonIndexed.dispose();
    g.dispose();
  }
  const merged = new Float32Array(total);
  let off = 0;
  for (const p of parts) { merged.set(p, off); off += p.length; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  out.computeVertexNormals();
  return out;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function disposeObject3D(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as any).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) mat.dispose();
  });
}

function findBodyIdOnAncestor(o: THREE.Object3D): number | null {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    if (cur.userData && typeof cur.userData.bodyId === 'number' && cur.userData.isGrainArrow) {
      return cur.userData.bodyId as number;
    }
    cur = cur.parent;
  }
  return null;
}

