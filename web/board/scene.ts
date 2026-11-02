import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Board } from "../../shared/board";
import { Bloom } from "../xr/bloom";
import { ItemView } from "./items";
import { LinkView } from "./links";
import { LOOK, makeDust, makeTable, shared } from "./look";
import { num, on, onTune } from "./tune";

/**
 * The workshop's scene. One renderer for the desktop (orbiting the table
 * with the mouse) and the headset (VR, or passthrough with the table on your
 * desk). The board lives in `rig`: in the headset you move, turn and scale
 * the rig, never yourself.
 *
 * Three passes a frame: the room behind (background, floor, stars; nothing
 * in passthrough), the board over it with bloom, and the overlay — panels,
 * hands, rays — crisp on top.
 */

export type Mode = "flat" | "vr" | "ar";
export type Hit = { kind: "item"; id: string; point: THREE.Vector3; dist: number } | { kind: "link"; id: string; point: THREE.Vector3; dist: number } | { kind: "table"; point: THREE.Vector3; dist: number };
type FrameFn = (t: number, dt: number, frame?: XRFrame) => void;

const PLACE_KEY = "workshop.rig.";
/** Where the table stands the first time in each mode: in front of you, at desk height (from the knobs). */
const defaultRig = (m: "vr" | "ar"): { pos: [number, number, number]; yaw: number; scale: number } =>
  m === "ar" ? { pos: [0, num("arHeight"), -num("arDistance")], yaw: 0, scale: num("arScale") } : { pos: [0, 0.82, -1.25], yaw: 0, scale: num("vrScale") };

export class BoardScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  /** Behind the board: never bloomed. */
  readonly room = new THREE.Scene();
  /** The board itself, bloomed. */
  readonly scene = new THREE.Scene();
  /** Over everything, crisp: panels, hands, rays. */
  readonly overlay = new THREE.Scene();
  readonly rig = new THREE.Group();
  readonly itemsGroup = new THREE.Group();
  readonly linksGroup = new THREE.Group();
  /** Previews: the stroke being drawn, the link being pulled. */
  readonly fx = new THREE.Group();
  readonly controls: OrbitControls;
  readonly views = new Map<string, ItemView>();
  readonly linkViews = new Map<string, LinkView>();
  mode: Mode = "flat";
  bloomOn = true;
  bloomParams = { strength: 0.5, radius: 0.45, threshold: 0.22 };
  private bloom: Bloom | null = null;
  private table = makeTable();
  private dust = makeDust();
  private roomStuff = new THREE.Group();
  private offTune: () => void;
  /** Items held in a hand or under the mouse: placed at once, never glided. */
  isHeld: (id: string) => boolean = () => false;
  private frameFns = new Set<FrameFn>();
  private last = performance.now();
  private t0 = performance.now();
  private board: Board | null = null;
  private selected = new Set<string>();
  private hovered = new Set<string>();
  private loaded = false;
  private fly: { from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; t0: number; ms: number } | null = null;
  private inkLine: THREE.Line;
  private pullLine: THREE.Line;
  private raycaster = new THREE.Raycaster();
  session: XRSession | null = null;
  onMode?: (m: Mode) => void;

  constructor(private host: HTMLElement) {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    r.setSize(host.clientWidth, host.clientHeight);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType("local-floor");
    r.xr.setFoveation(0.5);
    host.appendChild(r.domElement);
    r.domElement.style.display = "block";

    this.camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 0.01, 200);
    this.camera.position.set(0, 1.05, 1.62);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.set(0, 0.05, 0.08);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.25;
    this.controls.maxDistance = 7;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.update();

    this.room.background = new THREE.Color(LOOK.bg);
    this.room.add(this.roomStuff);
    this.roomStuff.add(makeRoom());

    this.rig.add(this.table.group, this.dust.points, this.linksGroup, this.itemsGroup, this.fx);
    this.scene.add(this.rig);
    this.overlay.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2238, 2.2));

    this.inkLine = previewLine(LOOK.cyan, 4096);
    this.pullLine = previewLine(LOOK.select, 64);
    this.fx.add(this.inkLine, this.pullLine);

    this.raycaster.params.Line = { threshold: 0.006 };
    this.raycaster.params.Points = { threshold: 0 };

    window.addEventListener("resize", this.onResize);
    this.offTune = onTune((changed) => this.applyTune(changed));
    this.applyTune([]);
    r.setAnimationLoop(this.frame);
  }

  /** The knobs, applied: uniforms, the camera, the room, and a rebuild when how things are drawn changed. */
  applyTune(changed: string[]) {
    shared.uFillK.value = num("fill");
    shared.uRimK.value = num("rim");
    shared.uEdgeK.value = num("edges");
    shared.uScanK.value = num("scanlines");
    shared.uFlickK.value = num("flicker");
    shared.uLinkK.value = num("linkBrightness");
    shared.uFlowK.value = num("flowSpeed");
    shared.uPacketK.value = num("packets");
    shared.uTableK.value = num("tableBrightness");
    shared.uColumnK.value = num("lightColumn");
    this.table.u.uFade.value = num("tableBrightness");
    this.table.group.visible = on("table");
    this.bloomOn = on("bloom");
    this.bloomParams = { strength: num("bloomStrength"), radius: num("bloomRadius"), threshold: num("bloomThreshold") };
    const c = this.controls;
    c.rotateSpeed = num("orbitSpeed");
    c.zoomSpeed = num("zoomSpeed");
    c.dampingFactor = num("damping");
    c.autoRotate = on("autoRotate");
    c.autoRotateSpeed = num("autoRotateSpeed");
    if (this.camera.fov !== num("fov")) {
      this.camera.fov = num("fov");
      this.camera.updateProjectionMatrix();
    }
    const room = this.roomStuff.children[0];
    const grid = room?.getObjectByName("grid");
    const stars = room?.getObjectByName("stars");
    if (grid) grid.visible = on("grid");
    if (stars) stars.visible = on("stars");
    if (this.session) this.renderer.xr.setFoveation(num("foveation"));
    if (changed.length) for (const v of this.views.values()) v.update(v.item, true);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this.onResize);
    this.offTune();
    this.controls.dispose();
    for (const v of this.views.values()) v.dispose();
    for (const l of this.linkViews.values()) l.dispose();
    this.bloom?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private onResize = () => {
    if (this.renderer.xr.isPresenting) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  onFrame(f: FrameFn) {
    this.frameFns.add(f);
    return () => this.frameFns.delete(f);
  }

  /* -------------------------------- board -------------------------------- */

  /** Draw this board: new items print in, changed ones update, gone ones fade. */
  setBoard(b: Board) {
    const fresh = this.loaded && this.board?.id === b.id;
    if (this.board?.id !== b.id) {
      for (const v of this.views.values()) v.dispose();
      for (const l of this.linkViews.values()) l.dispose();
      this.views.clear();
      this.linkViews.clear();
    }
    const prev = this.board;
    this.board = b;
    this.loaded = true;
    const seen = new Set<string>();
    const prevItems = new Map((prev?.id === b.id ? prev.items : []).map((i) => [i.id, i]));
    for (const it of b.items) {
      seen.add(it.id);
      const v = this.views.get(it.id);
      if (!v) {
        const nv = new ItemView(it, fresh);
        nv.selected = this.selected.has(it.id);
        this.views.set(it.id, nv);
        this.itemsGroup.add(nv.root);
      } else if (prevItems.get(it.id) !== it || v.dying) {
        v.dying = 0;
        v.u.uFade.value = 1;
        v.update(it, this.isHeld(it.id));
      }
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      // Gone: fade out, then go.
      if (!v.dying) v.dying = 1;
    }
    const seenL = new Set<string>();
    for (const l of b.links) {
      seenL.add(l.id);
      if (!this.linkViews.has(l.id)) {
        const lv = new LinkView(l, fresh);
        this.linkViews.set(l.id, lv);
        this.linksGroup.add(lv.root);
      }
    }
    for (const [id, lv] of this.linkViews) {
      if (seenL.has(id)) continue;
      lv.dispose();
      this.linkViews.delete(id);
    }
  }

  /** Where an item stands, right now, without waiting for the board (an item in your hand). */
  preview(id: string, p: { pos?: [number, number, number]; quat?: [number, number, number, number]; scale?: number }) {
    const v = this.views.get(id);
    if (!v) return;
    v.place({ pos: p.pos ?? v.item.pos, quat: p.quat ?? v.item.quat, rotY: v.item.rotY, scale: p.scale ?? v.item.scale }, true);
  }

  setSelected(ids: string[]) {
    this.selected = new Set(ids);
    for (const [id, v] of this.views) v.selected = this.selected.has(id);
  }

  setHover(ids: string[]) {
    for (const id of this.hovered) {
      const v = this.views.get(id);
      if (v) v.lit = 0;
      const l = this.linkViews.get(id);
      if (l) l.lit = 0;
    }
    this.hovered = new Set(ids);
    for (const id of ids) {
      const v = this.views.get(id);
      if (v) v.lit = 0.6;
      const l = this.linkViews.get(id);
      if (l) l.lit = 1;
    }
  }

  /* ------------------------------- picking ------------------------------- */

  /** What a ray (world space) hits first: an item, a link, or the table. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, o: { ignore?: string; tableOnly?: boolean; far?: number } = {}): Hit | null {
    this.raycaster.set(origin, dir);
    this.raycaster.far = o.far ?? 50;
    // Sprites (labels, text) face a camera: picking them needs to know which.
    this.raycaster.camera = this.mode === "flat" ? this.camera : this.renderer.xr.getCamera();
    if (!o.tableOnly) {
      const hits = this.raycaster.intersectObjects([this.itemsGroup, this.linksGroup], true);
      for (const h of hits) {
        if (h.object.userData.noPick) continue;
        let n: THREE.Object3D | null = h.object;
        while (n && !n.userData.itemId && !n.userData.linkId) n = n.parent;
        if (!n) continue;
        if (n.userData.itemId) {
          if (n.userData.itemId === o.ignore || this.views.get(n.userData.itemId)?.dying) continue;
          // Frames lie flat under everything: only picked where nothing else is.
          const v = this.views.get(n.userData.itemId);
          if (v?.item.kind === "frame") {
            const other = hits.find((x) => x !== h && !x.object.userData.noPick && ownerItem(x.object) && this.views.get(ownerItem(x.object)!)?.item.kind !== "frame");
            if (other) continue;
          }
          return { kind: "item", id: n.userData.itemId, point: h.point.clone(), dist: h.distance };
        }
        return { kind: "link", id: n.userData.linkId, point: h.point.clone(), dist: h.distance };
      }
    }
    const t = this.tablePoint(origin, dir, 0);
    if (t) {
      const w = this.rig.localToWorld(t.clone());
      if (Math.hypot(t.x, t.z) < 1.6) return { kind: "table", point: w, dist: w.distanceTo(origin) };
    }
    return null;
  }

  /** Where a ray (world) crosses the board's level plane at height `y` (board space), in board space. */
  tablePoint(origin: THREE.Vector3, dir: THREE.Vector3, y: number): THREE.Vector3 | null {
    const inv = this.rig.matrixWorld.clone().invert();
    const o = origin.clone().applyMatrix4(inv);
    const d = dir.clone().transformDirection(inv);
    if (Math.abs(d.y) < 1e-4) return null;
    const k = (y - o.y) / d.y;
    if (k < 0) return null;
    return o.addScaledVector(d, k);
  }

  toBoard(world: THREE.Vector3) {
    this.rig.updateMatrixWorld();
    return this.rig.worldToLocal(world.clone());
  }

  toWorld(local: THREE.Vector3) {
    this.rig.updateMatrixWorld();
    return this.rig.localToWorld(local.clone());
  }

  /** Where they're looking on the table, in board space: the orbit's target, or the head's gaze. */
  focusPoint(): [number, number, number] {
    if (this.mode === "flat") {
      const t = this.controls.target;
      return [round(t.x), 0, round(t.z)];
    }
    const xrCam = this.renderer.xr.getCamera();
    const o = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(xrCam.matrixWorld);
    const p = this.tablePoint(o, d, 0);
    if (!p || Math.hypot(p.x, p.z) > 1.4) return [0, 0, 0];
    return [round(p.x), 0, round(p.z)];
  }

  /* -------------------------------- camera ------------------------------- */

  /** Frame items (desktop), or light them up (headset, where the view is yours to move). */
  focus(ids: string[]) {
    const vs = ids.map((id) => this.views.get(id)).filter((v): v is ItemView => !!v);
    if (!vs.length) return;
    if (this.mode !== "flat") {
      for (const v of vs) v.lit = 1;
      setTimeout(() => vs.forEach((v) => (v.lit = this.hovered.has(v.id) ? 0.6 : 0)), 1600);
      return;
    }
    const box = new THREE.Box3();
    for (const v of vs) {
      const r = v.radius * v.root.scale.x;
      box.union(new THREE.Box3().setFromCenterAndSize(v.center(), new THREE.Vector3(r, r, r).multiplyScalar(2)));
    }
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(0.15, box.getSize(new THREE.Vector3()).length() / 2);
    this.flyTo(c, r);
  }

  overview() {
    if (this.mode !== "flat") return;
    this.flyTo(new THREE.Vector3(0, 0.12, 0), 1.45);
  }

  private flyTo(c: THREE.Vector3, r: number) {
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.9;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    // Keep the angle they look from, but never from below or flat on.
    if (dir.y < 0.35) dir.y = 0.35;
    dir.normalize();
    this.fly = { from: this.controls.target.clone(), to: c, camFrom: this.camera.position.clone(), camTo: c.clone().addScaledVector(dir, Math.max(0.35, dist)), t0: performance.now(), ms: num("flySeconds") * 1000 };
  }

  /* ------------------------------- previews ------------------------------ */

  /** The stroke being drawn (board space), or null to hide it. */
  showInk(points: THREE.Vector3[] | null, color = LOOK.cyan) {
    setPreview(this.inkLine, points, color);
  }

  /** A link being pulled from an item to a point (board space), or null. */
  showPull(from: THREE.Vector3 | null, to?: THREE.Vector3) {
    setPreview(this.pullLine, from && to ? [from, from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 0.05 + from.distanceTo(to) * 0.12, 0)), to] : null, LOOK.select, true);
  }

  /* --------------------------------- XR ---------------------------------- */

  async enter(mode: "vr" | "ar") {
    if (!navigator.xr) throw new Error("This browser has no WebXR.");
    if (this.session) await this.session.end().catch(() => {});
    const session = await navigator.xr.requestSession(mode === "vr" ? "immersive-vr" : "immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["hand-tracking"],
    });
    this.session = session;
    session.addEventListener("end", () => {
      if (this.session !== session) return;
      this.session = null;
      this.setMode("flat");
    });
    this.renderer.xr.setFramebufferScaleFactor(num("renderScale"));
    this.renderer.xr.setFoveation(num("foveation"));
    await this.renderer.xr.setSession(session);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    this.setMode(mode);
  }

  exit() {
    void this.session?.end();
  }

  private setMode(m: Mode) {
    this.mode = m;
    const ar = m === "ar";
    this.room.background = ar ? null : new THREE.Color(LOOK.bg);
    this.roomStuff.visible = !ar;
    this.renderer.setClearColor(0x000000, ar ? 0 : 1);
    if (m === "flat") {
      this.rig.position.set(0, 0, 0);
      this.rig.rotation.set(0, 0, 0);
      this.rig.scale.setScalar(1);
      this.controls.enabled = true;
      this.onResize();
    } else {
      this.controls.enabled = false;
      this.restoreRig(m);
    }
    this.onMode?.(m);
  }

  /** Where the board stood last time in this mode (in front of you, at desk height, the first time). */
  private restoreRig(m: "vr" | "ar") {
    let p = defaultRig(m);
    try {
      const s = localStorage.getItem(PLACE_KEY + m);
      if (s) p = { ...p, ...JSON.parse(s) };
    } catch {
      // No storage: the default spot.
    }
    this.rig.position.set(...p.pos);
    this.rig.rotation.set(0, p.yaw, 0);
    this.rig.scale.setScalar(p.scale);
  }

  saveRig() {
    if (this.mode === "flat") return;
    try {
      localStorage.setItem(PLACE_KEY + this.mode, JSON.stringify({ pos: this.rig.position.toArray().map(round), yaw: round(this.rig.rotation.y), scale: round(this.rig.scale.x) }));
    } catch {
      // Not kept; it still stands where you put it for now.
    }
  }

  resetRig() {
    if (this.mode === "flat") return this.overview();
    try {
      localStorage.removeItem(PLACE_KEY + this.mode);
    } catch {
      /* nothing kept anyway */
    }
    this.restoreRig(this.mode);
  }

  /* -------------------------------- frame -------------------------------- */

  private frame = (_t: number, xr?: XRFrame) => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;
    shared.uTime.value = t;
    this.table.tick(t, num("tableMotion"));
    this.dust.tick(t, num("dust"));

    if (this.fly) {
      const k = Math.min(1, (now - this.fly.t0) / this.fly.ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.controls.target.lerpVectors(this.fly.from, this.fly.to, e);
      this.camera.position.lerpVectors(this.fly.camFrom, this.fly.camTo, e);
      if (k >= 1) this.fly = null;
    }
    if (this.mode === "flat") this.controls.update();

    for (const f of this.frameFns) f(t, dt, xr);

    for (const [id, v] of this.views) {
      v.tick(t, dt);
      if (v.dying === 0 && !this.board?.items.some((i) => i.id === id)) {
        v.dispose();
        this.views.delete(id);
      }
    }
    if (this.board) {
      for (const l of this.board.links) {
        const lv = this.linkViews.get(l.id);
        const a = this.views.get(l.from);
        const b = this.views.get(l.to);
        if (lv && a && b) lv.update(l, a, b);
      }
    }
    for (const lv of this.linkViews.values()) lv.tick(dt);

    this.draw();
  };

  private draw() {
    const r = this.renderer;
    const target = r.getRenderTarget();
    const under = () => {
      r.setRenderTarget(target);
      r.render(this.room, this.camera);
    };
    if (this.bloomOn) {
      this.bloom ??= new Bloom(r);
      this.bloom.render(r, this.scene, this.camera, target, this.bloomParams, under);
    } else {
      under();
      r.autoClear = false;
      r.render(this.scene, this.camera);
      r.autoClear = true;
    }
    r.setRenderTarget(target);
    r.autoClear = false;
    r.clearDepth();
    r.render(this.overlay, this.camera);
    r.autoClear = true;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function ownerItem(o: THREE.Object3D): string | null {
  let n: THREE.Object3D | null = o;
  while (n && !n.userData.itemId) n = n.parent;
  return n?.userData.itemId ?? null;
}

function previewLine(color: string, max: number) {
  const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
  geo.setDrawRange(0, 0);
  const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  l.frustumCulled = false;
  l.visible = false;
  l.userData.noPick = true;
  return l;
}

function setPreview(l: THREE.Line, pts: THREE.Vector3[] | null, color: string, smooth = false) {
  if (!pts || pts.length < 2) {
    l.visible = false;
    return;
  }
  const list = smooth ? new THREE.QuadraticBezierCurve3(pts[0], pts[1], pts[2]).getPoints(40) : pts;
  const attr = l.geometry.getAttribute("position") as THREE.BufferAttribute;
  const n = Math.min(attr.count, list.length);
  for (let i = 0; i < n; i++) attr.setXYZ(i, list[i].x, list[i].y, list[i].z);
  attr.needsUpdate = true;
  l.geometry.setDrawRange(0, n);
  (l.material as THREE.LineBasicMaterial).color.set(color);
  l.visible = true;
}

/** The room around the table on the desktop and in VR: a dark floor grid fading out, and far stars. */
function makeRoom() {
  const g = new THREE.Group();
  const grid = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vW;
        void main(){
          vec2 c = abs(fract(vW.xz * 2.0 - 0.5) - 0.5) / fwidth(vW.xz * 2.0);
          float line = 1.0 - min(min(c.x, c.y), 1.0);
          float fade = exp(-length(vW.xz) * 0.22);
          gl_FragColor = vec4(vec3(0.2, 0.55, 0.75) * line * 0.22 * fade, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  grid.position.y = -0.82;
  grid.name = "grid";
  g.add(grid);
  const n = 1800;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 30 + Math.random() * 40;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(Math.random() * 1.6 - 0.6);
    pos.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p), r * Math.sin(p) * Math.sin(t)], i * 3);
  }
  const stars = (
    new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ color: 0x7fa6bd, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.5, depthWrite: false }),
    )
  );
  stars.name = "stars";
  g.add(stars);
  return g;
}
