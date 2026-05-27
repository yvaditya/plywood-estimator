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
  private grainArrows = new Map<number, THREE.Group>();
  private grainConfigs = new Map<number, GrainArrowConfig>();
  private grainStates = new Map<number, GrainLock>();
  private onSelectionChange?: () => void;
  private onGrainCycle?: (bodyId: number) => void;
  private pmrem: THREE.PMREMGenerator;
  private key!: THREE.DirectionalLight;
  private rim!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private shadowFloor!: THREE.Mesh;
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
    const grid = new THREE.GridHelper(6000, 60, 0x9b9a97, 0xcfceca);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(grid);

    this.scene.add(this.root);
    this.scene.add(this.grainGroup);

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
    // Trackpad two-finger pan (Mac Safari + Chrome on macOS).
    //   - ctrlKey set     → pinch-to-zoom (browser convention) → OrbitControls
    //   - deltaMode !== 0 → mouse wheel scroll → OrbitControls (zoom)
    //   - deltaMode === 0, no ctrlKey → two-finger trackpad pan → custom
    this.renderer.domElement.addEventListener('wheel', this.handleWheelPan, { passive: false, capture: true });
    new ResizeObserver(() => this.resize(container)).observe(container);

    this.tick();
  }

  private handleWheelPan = (ev: WheelEvent) => {
    if (ev.ctrlKey) return;            // pinch-zoom — defer to OrbitControls
    if (ev.deltaMode !== 0) return;     // mouse wheel — defer to OrbitControls
    ev.preventDefault();
    ev.stopPropagation();
    // Pan camera + target by trackpad delta, scaled to world units at the
    // current target distance (same formula OrbitControls uses internally).
    const offset = new THREE.Vector3().copy(this.camera.position).sub(this.controls.target);
    const targetDist = offset.length();
    const fov = (this.camera.fov * Math.PI) / 180;
    const h = this.renderer.domElement.clientHeight || 1;
    const panX = (2 * ev.deltaX * targetDist * Math.tan(fov / 2)) / h;
    const panY = (2 * ev.deltaY * targetDist * Math.tan(fov / 2)) / h;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.matrix.extractBasis(right, up, new THREE.Vector3());
    const pan = right.multiplyScalar(-panX).add(up.multiplyScalar(panY));
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
    this.root.add(mesh);

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
    this.root.add(edges);
  }

  /** Frame everything currently loaded and refresh selection colors. */
  finishLoad() {
    this.frameAll();
    this.refreshColors();
  }

  /**
   * Snapshot the current 3D scene as a base64 PNG.
   * Returns the canvas pixel dimensions too so callers can preserve
   * aspect ratio when placing the image elsewhere (e.g. in a PDF).
   */
  snapshot(): { dataUrl: string; width: number; height: number } {
    this.composer.render();
    const c = this.renderer.domElement;
    return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
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
    const out = { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
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
  ): { dataUrl: string; width: number; height: number } {
    // 1. Snapshot current visibility + positions
    const visBackup = new Map<number, boolean>();
    const posBackup = new Map<number, THREE.Vector3>();
    for (const b of this.bodies) {
      visBackup.set(b.id, b.mesh.visible);
      b.mesh.visible = visibleIds.has(b.id);
    }
    // Hide non-sheet bodies and grain arrows during a clean per-cabinet shot
    const grainBackup: { obj: THREE.Object3D; vis: boolean }[] = [];
    this.grainGroup.children.forEach((c) => {
      grainBackup.push({ obj: c, vis: c.visible });
      c.visible = false;
    });

    // 2. Refit camera + shadow camera to the visible bodies
    const cameraBackup = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
      near: this.camera.near,
      far: this.camera.far,
    };
    const box = new THREE.Box3();
    for (const b of this.bodies) if (visibleIds.has(b.id)) box.expandByObject(b.mesh);
    if (!box.isEmpty()) {
      const size = new THREE.Vector3(); box.getSize(size);
      const center = new THREE.Vector3(); box.getCenter(center);
      const maxDim = Math.max(size.x, size.y, size.z) + distance * 2;
      const fov = (this.camera.fov * Math.PI) / 180;
      const dist = (maxDim / 2) / Math.tan(fov / 2) * 1.7;
      this.controls.target.copy(center);
      this.camera.position.copy(
        center.clone().add(new THREE.Vector3(1.0, -1.2, 0.9).normalize().multiplyScalar(dist)),
      );
      this.camera.near = Math.max(0.1, maxDim / 1000);
      this.camera.far = maxDim * 100;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }

    // 3. Optionally explode the visible subset
    const explodeBackup = new Map<number, THREE.Vector3>();
    if (directions) {
      for (const b of this.bodies) {
        if (!visibleIds.has(b.id)) continue;
        const dir = directions.get(b.id);
        if (!dir) continue;
        explodeBackup.set(b.id, b.mesh.position.clone());
        b.mesh.position.x += dir[0] * distance;
        b.mesh.position.y += dir[1] * distance;
        b.mesh.position.z += dir[2] * distance;
      }
    }

    // 4. Render + grab (canvas dims captured for downstream aspect-fit)
    this.composer.render();
    const c = this.renderer.domElement;
    const out = { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };

    // 5. Restore EVERYTHING
    for (const b of this.bodies) {
      const v = visBackup.get(b.id);
      if (v !== undefined) b.mesh.visible = v;
      const p = explodeBackup.get(b.id);
      if (p) b.mesh.position.copy(p);
    }
    for (const g of grainBackup) g.obj.visible = g.vis;
    this.camera.position.copy(cameraBackup.pos);
    this.controls.target.copy(cameraBackup.target);
    this.camera.near = cameraBackup.near;
    this.camera.far = cameraBackup.far;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.composer.render();
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

    // Refresh outline selection cache after the body list changed.
    this.refreshOutlines();
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

