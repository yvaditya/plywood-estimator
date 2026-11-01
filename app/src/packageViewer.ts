import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { decodeArray, type PackageModel } from './packageData';

const GHOST = new THREE.Color(0xd9d4ca);

/** Small offline viewer: no composer, analysis, textures, or perpetual render loop. */
export class PackageViewer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, .1, 1000000);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private bodies = new Map<string, { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; edges: THREE.LineSegments; direction: THREE.Vector3 }>();
  private selected: string | null = null;
  private isolated = false;
  /** Bodies outside this set are hidden (null = show all). */
  private shown: Set<string> | null = null;
  private amount = 0;
  private diagonal = 1;
  private pending = false;
  private pointerStart: [number, number] = [0, 0];
  private moved = false;
  private touchCount = 0;
  private spinToken = 0;
  private observer!: ResizeObserver;

  constructor(private host: HTMLElement, models: PackageModel[], onSelect: (id: string) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setClearColor(0xf3f0e8, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', 'Assembly model. Drag to rotate; scroll or pinch to zoom.');
    this.renderer.domElement.setAttribute('role', 'img');
    host.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(1, -1.6, 1.1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.invalidate());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x756956, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 2.3);
    light.position.set(1, -2, 4); this.scene.add(light);
    const groupCenters = new Map<string, THREE.Box3>();
    const bodyCenters = new Map<string, THREE.Vector3>();
    const total = new THREE.Box3();
    for (const model of models) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(decodeArray(model.positions, 'float'), 3));
      geometry.setIndex(new THREE.BufferAttribute(decodeArray(model.indices, 'index'), 1));
      if (model.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(decodeArray(model.normals, 'float'), 3));
      else geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!;
      total.union(bounds);
      const group = groupCenters.get(model.fileTag) ?? new THREE.Box3();
      group.union(bounds); groupCenters.set(model.fileTag, group);
      bodyCenters.set(model.id, bounds.getCenter(new THREE.Vector3()));
      const material = new THREE.MeshStandardMaterial({ color: model.color, roughness: .83, metalness: 0, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.bodyId = model.id;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({color: 0x443e35, transparent: true, opacity: .48}));
      mesh.add(edges); this.scene.add(mesh);
      this.bodies.set(model.id, { mesh, edges, direction: new THREE.Vector3() });
    }
    this.diagonal = Math.max(total.getSize(new THREE.Vector3()).length(), 1);
    for (const model of models) {
      const direction = bodyCenters.get(model.id)!.clone().sub(groupCenters.get(model.fileTag)!.getCenter(new THREE.Vector3()));
      if (direction.lengthSq() < .01) direction.set(0, 0, 1);
      this.bodies.get(model.id)!.direction.copy(direction.normalize());
    }
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', e => {
      this.spinToken++;
      this.touchCount++;
      if (this.touchCount > 1) this.moved = true;
      else { this.moved = false; this.pointerStart = [e.clientX, e.clientY]; }
    });
    canvas.addEventListener('pointermove', e => {
      if (Math.hypot(e.clientX - this.pointerStart[0], e.clientY - this.pointerStart[1]) > 5) this.moved = true;
    });
    canvas.addEventListener('pointercancel', () => { this.touchCount = 0; this.moved = true; });
    canvas.addEventListener('pointerup', e => {
      this.touchCount = Math.max(0, this.touchCount - 1);
      if (this.moved || e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), this.camera);
      const hits = ray.intersectObjects([...this.bodies.values()].filter(b => b.mesh.visible).map(b => b.mesh), false);
      if (hits[0]) onSelect(hits[0].object.userData.bodyId);
    });
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      host.dataset.contextLost = 'true';
      const message = document.createElement('p');
      message.className = 'model-error'; message.textContent = '3D view paused. Reload this file to restore it. Your cut list is still available.';
      host.append(message);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      host.querySelector('.model-error')?.remove(); delete host.dataset.contextLost; this.invalidate();
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize(); this.reset();
  }
  private invalidate() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; if (this.host.clientWidth && this.host.clientHeight) this.renderer.render(this.scene, this.camera); });
  }
  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false); this.fit();
  }
  private fit() {
    const bounds = new THREE.Box3();
    for (const b of this.bodies.values()) if (b.mesh.visible) bounds.union(b.mesh.geometry.boundingBox!.clone().translate(b.mesh.position));
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 1);
    const fov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const distance = radius / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * this.camera.aspect))) * 1.08;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center); this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = Math.max(.01, radius / 1000); this.camera.far = Math.max(distance * 20, radius * 100);
    this.controls.minDistance = radius * .08; this.controls.maxDistance = distance * 6;
    this.camera.updateProjectionMatrix(); this.controls.update(); this.invalidate();
  }
  select(id: string | null) { this.selected = id; this.paint(); }
  private paint() {
    for (const [id, b] of this.bodies) {
      const active = id === this.selected;
      const ghost = !!this.selected && !active;
      const m = b.mesh.material;
      b.mesh.visible = (!this.shown || this.shown.has(id)) && (!this.isolated || active);
      m.userData.base ??= m.color.clone();
      // Ghosts fade to a pale neutral so the chosen part's own colour carries.
      m.color.copy(m.userData.base);
      if (ghost) m.color.lerp(GHOST, .7);
      m.emissive.set(active && this.selected ? 0x8a5410 : 0x000000);
      m.emissiveIntensity = active && this.selected ? .55 : 1;
      m.transparent = ghost;
      m.opacity = ghost ? .13 : 1;
      m.depthWrite = !ghost;
      const edge = b.edges.material as THREE.LineBasicMaterial;
      edge.color.set(active && this.selected ? 0x1d1408 : 0x443e35);
      edge.opacity = active && this.selected ? 1 : ghost ? .07 : .48;
      b.mesh.renderOrder = active ? 1 : 0;
    }
    this.invalidate();
  }
  /** Select one body, ghost the rest, and orbit close around it once so the
   *  part's place reads from every side. Any touch stops the spin. */
  focus(id: string | null) {
    this.select(id);
    const body = id ? this.bodies.get(id) : undefined;
    if (!body || !body.mesh.visible) return;
    this.fit();
    const fitTarget = this.controls.target.clone();
    const fitDistance = this.camera.position.distanceTo(fitTarget);
    const offset = this.camera.position.clone().sub(fitTarget);
    // Close-up: centre on the part, near enough that it fills a good share of
    // the view, but never so near that its neighbours (the context) leave it.
    const box = body.mesh.geometry.boundingBox!.clone().translate(body.mesh.position);
    const partTarget = box.getCenter(new THREE.Vector3());
    const partRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const fov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const half = Math.min(fov, Math.atan(Math.tan(fov) * this.camera.aspect));
    const closeDistance = Math.min(fitDistance, Math.max(partRadius * 1.9 / Math.sin(half), fitDistance * .42));
    const up = new THREE.Vector3(0, 0, 1);
    const token = ++this.spinToken;
    const start = performance.now(), duration = 2600;
    const frame = (now: number) => {
      if (token !== this.spinToken) return;
      const t = Math.min(1, (now - start) / duration);
      const ease = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      // Dolly in over the first third, then hold close for the rest of the turn.
      const z = Math.min(1, t / .35), zoom = 1 - (1 - z) ** 3;
      this.controls.target.lerpVectors(fitTarget, partTarget, zoom);
      const distance = fitDistance + (closeDistance - fitDistance) * zoom;
      this.camera.position.copy(this.controls.target).add(offset.clone().setLength(distance).applyAxisAngle(up, ease * Math.PI * 2));
      this.controls.update();
      if (this.host.clientWidth && this.host.clientHeight) this.renderer.render(this.scene, this.camera);
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  explode(amount: number) {
    this.amount = amount;
    for (const b of this.bodies.values()) b.mesh.position.copy(b.direction).multiplyScalar(this.diagonal * .34 * amount);
    this.fit();
  }
  /** Limit the model to some bodies, e.g. one cabinet of a multi-file job. */
  showOnly(ids: string[] | null) { this.shown = ids ? new Set(ids) : null; this.paint(); this.fit(); }
  isolate(value: boolean) { this.isolated = value && this.selected !== null; this.paint(); this.fit(); }
  /** Free the GL context before a replacement viewer is built. */
  dispose() {
    this.spinToken++;
    this.observer.disconnect();
    this.controls.dispose();
    for (const b of this.bodies.values()) { b.mesh.geometry.dispose(); b.mesh.material.dispose(); b.edges.geometry.dispose(); }
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
  }
  reset() {
    this.spinToken++;
    this.amount = 0; this.isolated = false;
    for (const b of this.bodies.values()) b.mesh.position.set(0, 0, 0);
    this.paint(); this.controls.target.set(0, 0, 0); this.camera.position.set(1, -1.6, 1.1); this.fit();
  }
}
