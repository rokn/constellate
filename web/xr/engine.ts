import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import { DEFAULT_XR, type XRSettings } from "../lib/xrSettings";
import { Bloom } from "./bloom";
import { MapView, type MapHit } from "./map";
import { C, Panel, Tag, roundRect } from "./ui";

/**
 * The room you stand in. One renderer serves three ways of looking:
 *
 *  - vr: an immersive session in the night sky, the map all around you;
 *  - ar: passthrough on the Quest 3, the map a hologram in your room,
 *        placeable on a table or the floor through hit-testing;
 *  - flat: no headset, a mouse preview of the same scene (for the desktop,
 *        and for checking a change without putting the headset on).
 *
 * You never move through the map: the map moves around you. Grabbing,
 * scaling, thumbstick flight and every camera flight the navigator asks for
 * move the world group, which keeps the real room (in AR) and your own body
 * (in VR) where they are, and is the comfortable way to fly in a headset.
 *
 * Two scenes are drawn each frame: the map (with the stars, the floor and the
 * passthrough dimmer), which gets the desktop's bloom (see bloom.ts), and the
 * overlay over it (panels, hands, rays and tags), which stays crisp.
 */

export type Mode = "flat" | "vr" | "ar";
export type Button = "menu" | "back" | "voice" | "overview" | "frame" | "ask" | "forward";
export type Slot = "left" | "right" | "center" | "low" | "dock" | "tune" | "hints" | "filter" | "focusbar";

export type EngineHandlers = {
  onPick: (hit: MapHit) => void;
  onBackground: () => void;
  onButton: (b: Button) => void;
  /** What the hover tag says about something on the map. */
  describe: (hit: MapHit) => { text: string; color?: string; bold?: boolean; mono?: boolean }[];
  onMode: (m: Mode) => void;
  onPlaced?: () => void;
  /** Each frame in the headset, before the panels paint. */
  onFrame?: () => void;
  /** A session just started. */
  onEntered?: () => void;
  /** The right stick clicked while pointing at something on the map: focus on it (again: wider). */
  onFocus?: (hit: MapHit) => void;
  /** A held body thrown away: hide it. */
  onFlick?: (hit: MapHit) => void;
};

type Grab = { p: Pointer; at0: THREE.Vector3 };
type Press =
  | { kind: "panel"; panel: Panel }
  | { kind: "map"; hit: MapHit; from: THREE.Vector3 }
  | { kind: "grab"; from: THREE.Vector3; moved: boolean }
  /** A body held on the end of the ray, `dist` metres out. */
  /** `pin`: the grip was pressed while holding it, so it stays where it's let go. */
  | { kind: "body"; id: string; dist: number; hit: MapHit; trail: { t: number; at: THREE.Vector3 }[]; pin: boolean }
  /** A panel picked up by its handle with the trigger. */
  | { kind: "handle" };

type Pointer = {
  id: string;
  kind: "controller" | "hand" | "mouse";
  handedness: "left" | "right" | "none";
  ray: THREE.Object3D;
  line: THREE.Line;
  dot: THREE.Mesh;
  source?: XRInputSource;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  hoverPanel: { panel: Panel; x: number; y: number } | null;
  /** A panel's grab handle under the ray. */
  hoverHandle: Panel | null;
  hoverMap: MapHit | null;
  press: Press | null;
  squeezing: boolean;
  /** A panel held with the grip: it follows the hand. */
  carry: { panel: Panel; offset: THREE.Matrix4 } | null;
  buttons: boolean[];
  /** Thumbstick turned past the snap threshold, waiting for it to come back. */
  snapped: boolean;
  /** What a smooth turn turns about, fixed while the stick is held. */
  turnPivot: THREE.Vector3 | null;
  /** This hand stretching a panel the other hand is carrying. */
  resize: { panel: Panel; holder: Pointer; w0: number; h0: number; dx0: number; dy0: number; at: number } | null;
  lastHapticId: string | null;
};

const MIN_SCALE = 0.00015;
const MAX_SCALE = 0.25;
const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Map units → metres. Everything the map is lives in here. */
  readonly world = new THREE.Group();
  readonly map = new MapView();
  readonly hud = new THREE.Group();
  /** Drawn over the (bloomed) map: panels, hands, rays, tags. */
  readonly overlay = new THREE.Scene();
  mode: Mode = "flat";
  settings: XRSettings = DEFAULT_XR;

  private stars: THREE.Points;
  private floor: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  /** In passthrough, the night drawn over your room as much as you ask for. */
  private backdrop: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private bloom: Bloom | null = null;
  /** Panels that have a place in the room; they open there again until recentered. */
  private placed = new Set<Panel>();
  private handles = new Map<Panel, THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>>();
  /** The overview's slow turn (the desktop's "Drift in overview"), until you touch the map. */
  private drift = false;
  private panels: Panel[] = [];
  private slots = new Map<Panel, Slot>();
  private pointers = new Map<string, Pointer>();
  private grabs: Grab[] = [];
  private grabStart: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number; a: THREE.Vector3; b?: THREE.Vector3 } | null = null;
  private flight: { fromP: THREE.Vector3; fromQ: THREE.Quaternion; fromS: number; toP: THREE.Vector3; toQ: THREE.Quaternion; toS: number; t0: number; ms: number } | null = null;
  private tag = new Tag();
  private timer = new THREE.Timer();
  private session: XRSession | null = null;
  private hitSource: XRHitTestSource | null = null;
  private reticle: THREE.Mesh;
  placing = false;
  /** Where the map was put down in your room (AR), for the overview to return to. */
  private anchor: THREE.Vector3 | null = null;
  private mouse = { x: 0, y: 0, down: -1, lastX: 0, lastY: 0, moved: false, keys: new Set<string>() };
  private dockYaw = 0;
  /** When the user last moved the map themselves; automatic refits made before that are dropped. */
  userMovedAt = 0;

  /**
   * `preview`: also draw when no headset is on, driven by the mouse. Off in
   * the desktop app, whose own map is on screen until you put the headset on.
   */
  constructor(
    private host: HTMLElement,
    private h: EngineHandlers,
    private preview = false,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType("local-floor");
    this.renderer.xr.setFoveation(this.settings.foveation);
    this.renderer.xr.setFramebufferScaleFactor(this.settings.renderScale);
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, host.clientWidth / host.clientHeight, 0.02, 400);
    this.camera.position.set(0, 1.6, 0);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(C.night);

    this.world.add(this.map.root);
    this.world.scale.setScalar(0.004);
    this.world.position.set(0, 1.5, -2);
    this.scene.add(this.world);
    this.overlay.add(this.hud);
    // Only the controller and hand models are lit; the map and panels glow on their own.
    this.overlay.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2238, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.5, 2, 1);
    this.overlay.add(sun);
    this.tag.sprite.visible = false;
    this.overlay.add(this.tag.sprite);

    this.backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(180, 32, 16),
      new THREE.MeshBasicMaterial({ color: C.night, side: THREE.BackSide, transparent: true, depthWrite: false, toneMapped: false }),
    );
    this.backdrop.renderOrder = -10;
    this.backdrop.visible = false;
    this.scene.add(this.backdrop);
    this.floor = makeFloor();
    this.scene.add(this.floor);

    // A far starfield, so there is something to fly past. It belongs to the
    // room, not the map: it holds still while the map moves, which keeps the
    // horizon steady in a headset.
    const pts = new Float32Array(2400 * 3);
    for (let i = 0; i < 2400; i++) {
      const r = 60 + Math.random() * 80;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pts.set([r * Math.sin(p) * Math.cos(t), r * Math.sin(p) * Math.sin(t), r * Math.cos(p)], i * 3);
    }
    const starGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pts, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8fa3c8, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false }));
    this.stars.renderOrder = -5;
    this.scene.add(this.stars);

    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.08, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: C.course, toneMapped: false }));
    this.reticle.visible = false;
    this.overlay.add(this.reticle);

    this.setupXRInput();
    this.setupMouse();
    window.addEventListener("resize", this.onResize);
    this.renderer.setAnimationLoop(this.frame);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this.onResize);
    this.map.dispose();
    this.bloom?.dispose();
    this.renderer.dispose();
  }

  /** The headset's own knobs (lib/xrSettings). Resolution waits for the next session; the rest is live. */
  setSettings(s: XRSettings) {
    const was = this.settings;
    this.settings = s;
    if (s.foveation !== was.foveation) this.renderer.xr.setFoveation(s.foveation);
    if (s.renderScale !== was.renderScale && !this.renderer.xr.isPresenting) this.renderer.xr.setFramebufferScaleFactor(s.renderScale);
    if (s.panelDistance !== was.panelDistance) this.recenterPanels();
    this.applyRoom();
  }

  /** The floor, the passthrough dimmer and the stars, for this mode and these settings. */
  private applyRoom() {
    const s = this.settings;
    const ar = this.mode === "ar";
    const tu = this.map.tuning;
    const night = ar ? 1 - s.passthrough : 1;
    this.backdrop.visible = ar && night > 0.001;
    this.backdrop.material.opacity = night;
    const stars = this.stars.material as THREE.PointsMaterial;
    stars.opacity = (tu?.starOpacity ?? 0.55) * (ar ? (s.arStars ? night : 0) : 1);
    stars.size = (tu?.starSize ?? 2.2) * 0.9;
    this.stars.visible = stars.opacity > 0.001;
    this.floor.visible = (ar ? s.floorInAR : s.floor && this.mode === "vr") && s.floorOpacity > 0;
    this.floor.scale.setScalar(s.floorSize / 2);
    this.floor.material.uniforms.uOpacity.value = s.floorOpacity;
  }

  private onResize = () => {
    if (this.renderer.xr.isPresenting) return;
    this.camera.aspect = this.host.clientWidth / this.host.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
  };

  /* ------------------------------- sessions ------------------------------- */

  static async supports(mode: "vr" | "ar") {
    try {
      return !!(await navigator.xr?.isSessionSupported(mode === "vr" ? "immersive-vr" : "immersive-ar"));
    } catch {
      return false;
    }
  }

  async enter(mode: "vr" | "ar") {
    if (!navigator.xr) throw new Error("This browser has no WebXR.");
    if (this.session) {
      // Switching between VR and passthrough: end this one, then start the
      // other while the click that asked for it still counts as a gesture.
      const old = this.session;
      this.session = null;
      await old.end().catch(() => {});
    }
    this.renderer.xr.setFramebufferScaleFactor(this.settings.renderScale);
    const session = await navigator.xr.requestSession(mode === "vr" ? "immersive-vr" : "immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: mode === "ar" ? ["hand-tracking", "hit-test", "plane-detection", "anchors"] : ["hand-tracking", "bounded-floor"],
    });
    this.session = session;
    session.addEventListener("end", () => {
      if (this.session !== session) return;
      this.session = null;
      this.hitSource?.cancel();
      this.hitSource = null;
      this.setMode("flat");
    });
    await this.renderer.xr.setSession(session);
    // A new session is a new room: panels open in front of you again.
    this.placed.clear();
    this.setMode(mode);
    // Once the first poses are in, frame what you were looking at (or the whole map).
    setTimeout(() => (this.h.onEntered ? this.h.onEntered() : this.overview(900)), 400);
  }

  exit() {
    void this.session?.end();
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    const ar = mode === "ar";
    this.scene.background = ar ? null : new THREE.Color(C.night);
    this.renderer.setClearColor(0x000000, ar ? 0 : 1);
    this.placing = false;
    this.reticle.visible = false;
    if (!ar) this.anchor = null;
    this.applyRoom();
    this.recenterPanels();
    this.h.onMode(mode);
  }

  /** AR: point at a table or the floor, pull the trigger, and the map sits there. */
  startPlacing() {
    if (this.mode !== "ar") return;
    this.placing = true;
    const src = [...this.pointers.values()].find((p) => p.handedness === "right" && p.source)?.source ?? [...this.pointers.values()].find((p) => p.source)?.source;
    this.hitSource?.cancel();
    this.hitSource = null;
    const space = src?.targetRaySpace;
    if (space && this.session?.requestHitTestSource) {
      void this.session.requestHitTestSource({ space })?.then((s) => (this.hitSource = s)).catch(() => {});
    }
  }

  /* -------------------------------- panels -------------------------------- */

  addPanel(p: Panel) {
    this.panels.push(p);
    this.hud.add(p.mesh);
    // A handle under every panel: point at it and hold the trigger (or the grip) to carry the panel.
    const h = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.026), new THREE.MeshBasicMaterial({ map: handleTexture(), transparent: true, depthTest: false, depthWrite: false, toneMapped: false, opacity: 0.6 }));
    h.position.set(0, -p.heightM / 2 - 0.028, 0);
    h.renderOrder = 11;
    h.userData.handleOf = p;
    p.mesh.add(h);
    this.handles.set(p, h);
  }

  /**
   * Open a panel. It goes where it was last (you put it there), unless it
   * has never been placed this session or is now out of sight behind you.
   */
  show(p: Panel, slot: Slot) {
    const was = p.open;
    p.mesh.visible = true;
    p.invalidate();
    if (!was && (!this.placed.has(p) || !this.inView(p) || slot === "focusbar")) this.place(p, slot);
    this.slots.set(p, slot);
  }

  /** Whether a panel is roughly where you're looking (within ~70° of your gaze). */
  private inView(p: Panel) {
    const { pos, forward } = this.head();
    const to = p.mesh.position.clone().sub(pos);
    return to.lengthSq() < 25 && to.normalize().dot(forward) > Math.cos(THREE.MathUtils.degToRad(70));
  }

  hide(p: Panel) {
    p.mesh.visible = false;
    for (const ptr of this.pointers.values()) {
      if (ptr.hoverPanel?.panel === p) ptr.hoverPanel = null;
      if (ptr.hoverHandle === p) ptr.hoverHandle = null;
      if (ptr.carry?.panel === p) ptr.carry = null;
      if (ptr.press?.kind === "panel" && ptr.press.panel === p) ptr.press = null;
    }
  }

  /** Put every open panel back around where you're looking; closed ones open there next time. */
  recenterPanels() {
    this.placed.clear();
    for (const [p, slot] of this.slots) if (p.open) this.place(p, slot);
  }

  private place(p: Panel, slot: Slot) {
    // The focus bar sits on top of the dock, wherever you've put that.
    const dock = [...this.slots].find(([, s]) => s === "dock")?.[0];
    if (slot === "focusbar" && dock?.open) {
      p.mesh.position.copy(dock.mesh.position);
      p.mesh.quaternion.copy(dock.mesh.quaternion);
      p.mesh.translateY(dock.heightM / 2 + p.heightM / 2 + 0.05);
      this.placed.add(p);
      return;
    }
    const { pos, yaw } = this.head();
    const spec = {
      left: { yaw: 0.6, dist: 0.95, dy: -0.06, tilt: 0 },
      right: { yaw: -0.6, dist: 0.95, dy: -0.06, tilt: 0 },
      center: { yaw: 0, dist: 0.85, dy: -0.18, tilt: 0.15 },
      low: { yaw: 0, dist: 0.62, dy: -0.38, tilt: 0.6 },
      dock: { yaw: 0, dist: 0.95, dy: -0.48, tilt: 0.55 },
      tune: { yaw: 0.25, dist: 0.9, dy: -0.1, tilt: 0.1 },
      hints: { yaw: 0, dist: 1.0, dy: 0.02, tilt: 0 },
      filter: { yaw: -0.25, dist: 0.9, dy: -0.1, tilt: 0.1 },
      focusbar: { yaw: 0, dist: 0.95, dy: -0.36, tilt: 0.4 },
    }[slot];
    // A desktop window sees a much narrower cone than a headset: the preview
    // sets the same panels further out and closer to the middle.
    const flat = this.mode === "flat";
    const a = yaw + spec.yaw * (flat ? 0.62 : 1);
    const dist = spec.dist * (flat ? 1.4 : 1) * this.settings.panelDistance;
    const dy = spec.dy * (flat ? 1.25 : 1);
    if (slot === "dock") this.dockYaw = yaw;
    p.mesh.position.set(pos.x - Math.sin(a) * dist, pos.y + dy, pos.z - Math.cos(a) * dist);
    // Face the head, then tilt back so a low panel reads like a lectern.
    p.mesh.lookAt(pos.x, p.mesh.position.y, pos.z);
    p.mesh.rotateX(-spec.tilt);
    this.placed.add(p);
  }

  /* --------------------------------- head --------------------------------- */

  head(): { pos: THREE.Vector3; quat: THREE.Quaternion; yaw: number; forward: THREE.Vector3 } {
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    cam.updateMatrixWorld();
    const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const quat = new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const yaw = Math.atan2(-forward.x, -forward.z);
    // A head in a fresh session sits at the floor until the first pose lands.
    if (pos.y < 0.3 && this.renderer.xr.isPresenting) pos.y = 1.5;
    return { pos, quat, yaw, forward };
  }

  /* -------------------------------- flights -------------------------------- */

  /**
   * Bring map point `c` (map units) to `dist` metres in front of you at a
   * scale where `radius` map units are `radiusM` metres. The map keeps its
   * heading; only where it is and how big it is change.
   */
  frameAt(c: THREE.Vector3, radius: number, o: { radiusM: number; dist: number; dy?: number; ms?: number; at?: THREE.Vector3 }) {
    const { pos, yaw } = this.head();
    const s = THREE.MathUtils.clamp(o.radiusM / Math.max(1e-3, radius), MIN_SCALE, MAX_SCALE);
    // The preview's window is a narrower cone than a headset's view.
    const dist = o.dist * (this.mode === "flat" ? 1.6 : 1);
    // On a table (passthrough, placed, "Stay on the surface"): what you focus on comes to the table's middle, not to you.
    const onSurface = !o.at && this.mode === "ar" && this.anchor && this.settings.keepOnSurface ? this.anchor.clone().add(new THREE.Vector3(0, o.radiusM + 0.04, 0)) : null;
    const target = o.at?.clone() ?? onSurface ?? new THREE.Vector3(pos.x - Math.sin(yaw) * dist, pos.y + (o.dy ?? 0), pos.z - Math.cos(yaw) * dist);
    const q = this.world.quaternion.clone();
    const p = target.sub(c.clone().multiplyScalar(s).applyQuaternion(q));
    this.drift = false;
    this.flyWorld(p, q, s, o.ms ?? this.flyMs());
  }

  /** The desktop's "Flight time", a little brisker at arm's length. */
  private flyMs() {
    return (this.map.tuning?.flySeconds ?? 1.6) * 800;
  }

  /** You moved the map yourself: automatic refits made before now are dropped, and the drift stops. */
  private touched() {
    this.userMovedAt = performance.now();
    this.drift = false;
    this.flight = null;
  }

  private flyWorld(p: THREE.Vector3, q: THREE.Quaternion, s: number, ms: number) {
    this.flight = {
      fromP: this.world.position.clone(),
      fromQ: this.world.quaternion.clone(),
      fromS: this.world.scale.x,
      toP: p,
      toQ: q,
      toS: s,
      t0: performance.now(),
      ms,
    };
  }

  /** Frame the whole map, the way the overview does: around you in VR, on the table in AR. */
  overview(ms = this.flyMs() * 1.1) {
    const b = this.map.bounds();
    if (!b) return;
    if (this.mode === "ar") {
      const at = this.anchor ? this.anchor.clone().add(new THREE.Vector3(0, 0.38, 0)) : undefined;
      this.frameAt(b.center, b.radius, { radiusM: 0.38, dist: 0.95, dy: -0.4, ms, at });
    } else if (this.mode === "vr") this.frameAt(b.center, b.radius, { radiusM: 1.1, dist: 2.0, dy: -0.1, ms });
    else this.frameAt(b.center, b.radius, { radiusM: 0.85, dist: 1.65, dy: 0.05, ms });
    // Then it drifts, as the desktop's overview does (on the table or in the preview; turning the whole sky around you in VR is no comfort).
    this.drift = true;
  }

  /** "Focus distance": how close flights stop. Further away is the same framing, smaller. */
  private near() {
    return 1 / Math.max(0.3, this.map.tuning?.focusDistance ?? 1);
  }

  /** Fly to some files: the focus fills a comfortable cone in front of you. */
  focus(ids: string[], ms = this.flyMs()) {
    const b = this.map.bounds(ids);
    if (!b) return;
    const ar = this.mode === "ar";
    this.frameAt(b.center, b.radius, { radiusM: (ar ? 0.3 : 0.42) * this.near(), dist: ar ? 0.8 : 1.0, dy: ar ? -0.25 : -0.08, ms });
  }

  /** Fly to a file: it in the middle, its neighbourhood around it within reach. */
  flyTo(path: string, ms = this.flyMs()) {
    const at = this.map.positionOf(path);
    if (!at) return;
    const around = this.map.bounds([path, ...this.map.neighboursOf(path)]);
    const r = THREE.MathUtils.clamp(around ? around.center.distanceTo(at) + around.radius * 0.5 : 30, 30, 90);
    const ar = this.mode === "ar";
    this.frameAt(at, r, { radiusM: (ar ? 0.22 : 0.32) * this.near(), dist: ar ? 0.65 : 0.85, dy: ar ? -0.2 : -0.06, ms });
  }

  /* --------------------------------- input --------------------------------- */

  private makeRayVisual() {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: C.static, transparent: true, opacity: 0.55, toneMapped: false }),
    );
    line.scale.z = 3;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false, depthTest: false }));
    dot.renderOrder = 30;
    dot.visible = false;
    this.overlay.add(dot);
    return { line, dot };
  }

  private setupXRInput() {
    const controllerModels = new XRControllerModelFactory();
    const handModels = new XRHandModelFactory();
    for (let i = 0; i < 2; i++) {
      const ray = this.renderer.xr.getController(i);
      const grip = this.renderer.xr.getControllerGrip(i);
      const hand = this.renderer.xr.getHand(i);
      grip.add(controllerModels.createControllerModel(grip));
      hand.add(handModels.createHandModel(hand, "mesh"));
      this.overlay.add(ray, grip, hand);
      const { line, dot } = this.makeRayVisual();
      ray.add(line);
      const id = `xr${i}`;
      ray.addEventListener("connected", (e) => {
        const source = (e as unknown as { data: XRInputSource }).data;
        this.pointers.set(id, {
          id,
          kind: source.hand ? "hand" : "controller",
          handedness: source.handedness === "left" ? "left" : source.handedness === "right" ? "right" : "none",
          ray,
          line,
          dot,
          source,
          origin: new THREE.Vector3(),
          dir: new THREE.Vector3(),
          hoverPanel: null,
          hoverHandle: null,
          hoverMap: null,
          press: null,
          squeezing: false,
          carry: null,
          buttons: [],
          snapped: false,
          turnPivot: null,
          resize: null,
          lastHapticId: null,
        });
        line.visible = true;
      });
      ray.addEventListener("disconnected", () => {
        const p = this.pointers.get(id);
        if (p) this.endGrab(p);
        this.pointers.delete(id);
        line.visible = false;
        dot.visible = false;
      });
      ray.addEventListener("selectstart", () => this.pressStart(id));
      ray.addEventListener("selectend", () => this.pressEnd(id));
      ray.addEventListener("squeezestart", () => this.squeezeStart(id));
      ray.addEventListener("squeezeend", () => this.squeezeEnd(id));
    }
  }

  private setupMouse() {
    const el = this.renderer.domElement;
    const { line, dot } = this.makeRayVisual();
    line.visible = false;
    const ray = new THREE.Object3D();
    this.overlay.add(ray);
    const p: Pointer = {
      id: "mouse",
      kind: "mouse",
      handedness: "none",
      ray,
      line,
      dot,
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      hoverPanel: null,
      hoverHandle: null,
      hoverMap: null,
      press: null,
      squeezing: false,
      carry: null,
      buttons: [],
      snapped: false,
      turnPivot: null,
      resize: null,
      lastHapticId: null,
    };
    this.pointers.set("mouse", p);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      const dx = e.clientX - this.mouse.lastX;
      const dy = e.clientY - this.mouse.lastY;
      this.mouse.lastX = e.clientX;
      this.mouse.lastY = e.clientY;
      if (this.mouse.down < 0) return;
      if (Math.abs(dx) + Math.abs(dy) > 0) this.mouse.moved = true;
      // Right drag turns the map about its middle; left drag on open sky moves it.
      if (this.mouse.down === 2) {
        this.touched();
        const b = this.map.bounds();
        const pivot = b ? this.map.toWorld(b.center) : this.world.position.clone();
        this.rotateWorldAbout(pivot, dx * 0.006);
        const right = new THREE.Vector3(1, 0, 0);
        const qx = new THREE.Quaternion().setFromAxisAngle(right, dy * 0.004);
        this.world.position.sub(pivot).applyQuaternion(qx).add(pivot);
        this.world.quaternion.premultiply(qx);
      } else if (this.mouse.down === 0 && p.press?.kind === "grab") {
        this.touched();
        const d = pivotDistance(this.world, this.camera);
        const k = (d * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / r.height;
        this.world.position.add(new THREE.Vector3(dx * k, -dy * k, 0));
      }
    });
    el.addEventListener("pointerdown", (e) => {
      if (this.renderer.xr.isPresenting) return;
      el.setPointerCapture(e.pointerId);
      this.mouse.down = e.button;
      this.mouse.moved = false;
      this.mouse.lastX = e.clientX;
      this.mouse.lastY = e.clientY;
      if (e.button === 0) this.pressStart("mouse");
    });
    el.addEventListener("pointerup", (e) => {
      if (e.button === 0) this.pressEnd("mouse");
      this.mouse.down = -1;
    });
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const ptr = this.pointers.get("mouse")!;
        if (ptr.hoverPanel) return ptr.hoverPanel.panel.scrollBy(e.deltaY * 1.2);
        // A held body: the wheel pushes it away or pulls it in.
        if (ptr.press?.kind === "body") return void (ptr.press.dist *= Math.exp(-e.deltaY * 0.0015));
        // Zoom toward what's under the pointer, as the desktop does.
        const pivot = ptr.origin.clone().add(ptr.dir.clone().multiplyScalar(ptr.hoverMap ? this.hitDistanceM(ptr, ptr.hoverMap) : 2));
        this.scaleWorldAbout(pivot, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      this.mouse.keys.add(e.key.toLowerCase());
    });
    window.addEventListener("keyup", (e) => this.mouse.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.mouse.keys.clear());
  }

  private hitDistanceM(p: Pointer, hit: MapHit) {
    return hit.t * this.world.scale.x || p.origin.distanceTo(this.world.position);
  }

  private pressStart(id: string) {
    const p = this.pointers.get(id);
    if (!p) return;
    if (this.placing && this.reticle.visible) {
      this.placeAt(this.reticle.position.clone());
      return;
    }
    if (p.hoverHandle) {
      p.press = { kind: "handle" };
      this.pickUp(p, p.hoverHandle);
      return;
    }
    if (p.hoverPanel) {
      p.press = { kind: "panel", panel: p.hoverPanel.panel };
      p.hoverPanel.panel.pointer("down", p.hoverPanel.x, p.hoverPanel.y, p.id);
      this.haptic(p, 0.3, 20);
      return;
    }
    if (p.hoverMap) {
      p.press = { kind: "map", hit: p.hoverMap, from: p.origin.clone().add(p.dir) };
      return;
    }
    // Open sky: the trigger (or a pinch) grabs the map; let go without moving to clear.
    p.press = { kind: "grab", from: p.origin.clone().add(p.dir), moved: false };
    if (p.kind !== "mouse") this.beginGrab(p);
  }

  private pressEnd(id: string) {
    const p = this.pointers.get(id);
    if (!p?.press) return;
    const press = p.press;
    p.press = null;
    const moved = (from: THREE.Vector3) => from.distanceTo(p.origin.clone().add(p.dir)) > (p.kind === "mouse" ? 0.02 : 0.035);
    if (press.kind === "handle") {
      if (!p.squeezing) (p.carry = null), (p.resize = null);
    } else if (press.kind === "body") {
      // Thrown, not set down: hide it.
      const tr = press.trail;
      const first = tr.find((x) => performance.now() - x.t < 120) ?? tr[0];
      const last = tr.at(-1);
      const speed = first && last && last.t > first.t ? last.at.distanceTo(first.at) / ((last.t - first.t) / 1000) : 0;
      const thrown = this.settings.flick && speed > this.settings.flickSpeed && !!this.h.onFlick;
      this.map.release(press.id, press.pin && !thrown);
      if (thrown) {
        this.haptic(p, 0.8, 60);
        this.h.onFlick!(press.hit);
      } else this.haptic(p, press.pin ? 0.6 : 0.3, press.pin ? 40 : 20);
    } else if (press.kind === "panel") {
      const hp = p.hoverPanel?.panel === press.panel ? p.hoverPanel : null;
      press.panel.pointer("up", hp?.x ?? -1, hp?.y ?? -1, p.id);
    } else if (press.kind === "map") {
      const still = p.kind === "mouse" ? !this.mouse.moved : !moved(press.from);
      if (still) {
        this.haptic(p, 0.5, 30);
        this.h.onPick(press.hit);
      }
    } else {
      if (p.kind !== "mouse") this.endGrab(p);
      const wasMoved = p.kind === "mouse" ? this.mouse.moved : moved(press.from);
      if (!wasMoved) this.h.onBackground();
    }
  }

  private squeezeStart(id: string) {
    const p = this.pointers.get(id);
    if (!p) return;
    p.squeezing = true;
    // Holding a body: the grip pins it (or unpins it) where you'll let it go.
    if (p.press?.kind === "body") {
      p.press.pin = !p.press.pin;
      this.haptic(p, 0.5, p.press.pin ? 40 : 15);
      return;
    }
    // The grip on a panel (or its handle) picks it up; anywhere else it grabs the map.
    const panel = p.hoverHandle ?? p.hoverPanel?.panel;
    if (panel) return this.pickUp(p, panel);
    this.beginGrab(p);
  }

  /** A panel follows this pointer until it's let go. */
  private pickUp(p: Pointer, panel: Panel) {
    // The other hand already has it: this one stretches it.
    const holder = [...this.pointers.values()].find((o) => o !== p && o.carry?.panel === panel);
    if (holder && panel.resizable) {
      const { dx, dy } = this.handsApart(holder, p, panel);
      p.resize = { panel, holder, w0: panel.widthM, h0: panel.heightM, dx0: Math.max(0.15, dx), dy0: Math.max(0.15, dy), at: 0 };
      this.haptic(p, 0.4, 25);
      return;
    }
    p.ray.updateMatrixWorld();
    panel.mesh.updateMatrixWorld();
    p.carry = { panel, offset: tmpM.copy(p.ray.matrixWorld).invert().multiply(panel.mesh.matrixWorld).clone() };
    this.placed.add(panel);
    this.haptic(p, 0.4, 25);
  }

  /** How far apart two hands are across a panel and up it. */
  private handsApart(a: Pointer, b: Pointer, panel: Panel) {
    const v = this.grabPoint(b).sub(this.grabPoint(a));
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(panel.mesh.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(panel.mesh.quaternion);
    return { dx: Math.abs(v.dot(right)), dy: Math.abs(v.dot(up)) };
  }

  /** Two hands on a panel: its width follows how far apart they are across it, its height how far up. */
  private applyResize(p: Pointer) {
    const r = p.resize;
    if (!r) return;
    if (r.holder.carry?.panel !== r.panel || !r.panel.open) return void (p.resize = null);
    const now = performance.now();
    // A new canvas each step: a few a second is smooth enough.
    if (now - r.at < 90) return;
    const { dx, dy } = this.handsApart(r.holder, p, r.panel);
    const w = THREE.MathUtils.clamp((r.w0 * dx) / r.dx0, 0.4, 1.8);
    const h = THREE.MathUtils.clamp((r.h0 * dy) / r.dy0, 0.3, 1.5);
    if (Math.abs(w - r.panel.widthM) < 0.01 && Math.abs(h - r.panel.heightM) < 0.01) return;
    r.at = now;
    r.panel.resize(w, h);
    this.handles.get(r.panel)?.position.set(0, -h / 2 - 0.028, 0);
  }

  private squeezeEnd(id: string) {
    const p = this.pointers.get(id);
    if (!p) return;
    p.squeezing = false;
    if (p.resize) {
      if (p.press?.kind !== "handle") p.resize = null;
      return;
    }
    if (p.carry) {
      if (p.press?.kind !== "handle") p.carry = null;
      return;
    }
    this.endGrab(p);
  }

  private grabPoint(p: Pointer) {
    p.ray.updateMatrixWorld();
    return new THREE.Vector3().setFromMatrixPosition(p.ray.matrixWorld);
  }

  private beginGrab(p: Pointer) {
    if (this.grabs.some((g) => g.p === p)) return;
    this.touched();
    this.grabs.push({ p, at0: this.grabPoint(p) });
    this.resetGrab();
    this.haptic(p, 0.25, 15);
  }

  private endGrab(p: Pointer) {
    const before = this.grabs.length;
    this.grabs = this.grabs.filter((g) => g.p !== p);
    if (this.grabs.length !== before) this.resetGrab();
  }

  /** Grabs restart from where the world is now whenever a hand joins or leaves. */
  private resetGrab() {
    if (!this.grabs.length) return void (this.grabStart = null);
    for (const g of this.grabs) g.at0 = this.grabPoint(g.p);
    this.grabStart = {
      pos: this.world.position.clone(),
      quat: this.world.quaternion.clone(),
      scale: this.world.scale.x,
      a: this.grabs[0].at0.clone(),
      b: this.grabs[1]?.at0.clone(),
    };
  }

  private applyGrab() {
    const s0 = this.grabStart;
    if (!s0 || !this.grabs.length) return;
    this.userMovedAt = performance.now();
    this.drift = false;
    if (this.grabs.length === 1 || !s0.b) {
      // One hand: drag the map through the room.
      const now = this.grabPoint(this.grabs[0].p);
      this.world.position.copy(s0.pos).add(now.sub(s0.a));
      for (const g of this.grabs) if (g.p.press?.kind === "grab" && g.at0.distanceTo(this.grabPoint(g.p)) > 0.03) g.p.press.moved = true;
      return;
    }
    // Two hands: stretch to scale, turn to rotate, both about the midpoint.
    const a = this.grabPoint(this.grabs[0].p);
    const b = this.grabPoint(this.grabs[1].p);
    const d0 = s0.b.distanceTo(s0.a);
    const k = THREE.MathUtils.clamp(s0.scale * (a.distanceTo(b) / Math.max(0.01, d0)), MIN_SCALE, MAX_SCALE) / s0.scale;
    const yaw0 = Math.atan2(s0.b.x - s0.a.x, s0.b.z - s0.a.z);
    const yaw1 = Math.atan2(b.x - a.x, b.z - a.z);
    const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw1 - yaw0);
    const mid0 = s0.a.clone().add(s0.b).multiplyScalar(0.5);
    const mid1 = a.clone().add(b).multiplyScalar(0.5);
    this.world.scale.setScalar(s0.scale * k);
    this.world.quaternion.copy(q).multiply(s0.quat);
    this.world.position.copy(s0.pos).sub(mid0).multiplyScalar(k).applyQuaternion(q).add(mid1);
    for (const g of this.grabs) if (g.p.press?.kind === "grab") g.p.press.moved = true;
  }

  private rotateWorldAbout(pivot: THREE.Vector3, angle: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(Y, angle);
    this.world.position.sub(pivot).applyQuaternion(q).add(pivot);
    this.world.quaternion.premultiply(q);
  }

  private scaleWorldAbout(pivot: THREE.Vector3, k: number) {
    this.touched();
    const s = THREE.MathUtils.clamp(this.world.scale.x * k, MIN_SCALE, MAX_SCALE);
    const kk = s / this.world.scale.x;
    this.world.position.sub(pivot).multiplyScalar(kk).add(pivot);
    this.world.scale.setScalar(s);
  }

  private haptic(p: Pointer, intensity: number, ms: number) {
    const act = p.source?.gamepad?.hapticActuators?.[0] as unknown as { pulse?: (v: number, d: number) => void } | undefined;
    try {
      act?.pulse?.(intensity, ms);
    } catch {
      /* not every runtime has haptics */
    }
  }

  private placeAt(at: THREE.Vector3) {
    this.anchor = at;
    this.placing = false;
    this.reticle.visible = false;
    this.hitSource?.cancel();
    this.hitSource = null;
    this.overview(900);
    this.h.onPlaced?.();
  }

  /* --------------------------------- frame --------------------------------- */

  private frame = (_t: number, xrFrame?: XRFrame) => {
    if (!this.preview && !this.renderer.xr.isPresenting) return;
    // In a session, three binds the headset's framebuffer before calling us.
    const target = this.renderer.getRenderTarget();
    this.timer.update();
    const dt = Math.min(0.05, this.timer.getDelta());
    const now = performance.now();

    // A flight in progress eases the world to where it's going.
    if (this.flight) {
      const f = this.flight;
      const u = Math.min(1, (now - f.t0) / f.ms);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      this.world.position.lerpVectors(f.fromP, f.toP, e);
      this.world.quaternion.slerpQuaternions(f.fromQ, f.toQ, e);
      this.world.scale.setScalar(Math.exp(THREE.MathUtils.lerp(Math.log(f.fromS), Math.log(f.toS), e)));
      if (u >= 1) this.flight = null;
    }
    this.applyGrab();
    this.readGamepads(dt);
    this.flatKeys(dt);

    // The overview drifts round, slowly, until you touch it.
    const tu = this.map.tuning;
    if (this.drift && !this.flight && tu?.autoRotate && this.mode !== "vr" && !this.grabs.length) {
      const b = this.map.bounds();
      // OrbitControls' autoRotateSpeed: 1 is a turn a minute.
      if (b) this.rotateWorldAbout(this.map.toWorld(b.center), ((2 * Math.PI) / 60) * tu.autoRotateSpeed * dt);
    }

    // Pointers: what each ray lands on.
    for (const p of this.pointers.values()) this.updatePointer(p);
    for (const p of this.pointers.values()) this.updatePress(p);

    // A panel being carried follows its hand, still facing you (and a second hand stretches it).
    for (const p of this.pointers.values()) this.applyResize(p);
    const head = this.head();
    for (const p of this.pointers.values()) {
      if (!p.carry) continue;
      p.ray.updateMatrixWorld();
      const m = p.ray.matrixWorld.clone().multiply(p.carry.offset);
      p.carry.panel.mesh.position.setFromMatrixPosition(m);
      p.carry.panel.mesh.lookAt(head.pos);
    }

    // The dock can follow lazily (a setting): it only turns with you once you've looked well away.
    for (const [panel, slot] of this.slots) {
      if (!this.settings.dockFollows || slot !== "dock" || !panel.open || this.pointers.size === 0 || [...this.pointers.values()].some((p) => p.carry?.panel === panel)) continue;
      let d = head.yaw - this.dockYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > 0.6) this.place(panel, "dock");
    }

    // AR placement: the reticle sits where the ray meets a real surface.
    if (this.placing && xrFrame && this.hitSource) {
      const ref = this.renderer.xr.getReferenceSpace();
      const hit = ref ? xrFrame.getHitTestResults(this.hitSource)[0]?.getPose(ref) : undefined;
      this.reticle.visible = !!hit;
      if (hit) this.reticle.position.set(hit.transform.position.x, hit.transform.position.y, hit.transform.position.z);
    } else if (this.placing && !this.hitSource) {
      // No hit-testing on this device: place where the ray is, a metre out.
      const ptrs = [...this.pointers.values()].filter((x) => x.kind !== "mouse");
      const p = ptrs.find((x) => x.handedness === "right") ?? ptrs[0];
      if (p) {
        this.reticle.visible = true;
        this.reticle.position.copy(p.origin).addScaledVector(p.dir, 1);
      }
    }

    // The map, with names sized for the eye that's looking.
    this.world.updateMatrixWorld();
    const eyeLocal = this.map.root.worldToLocal(head.pos.clone());
    this.map.update(eyeLocal, now, 1 / this.world.scale.x);

    this.h.onFrame?.();
    for (const panel of this.panels) panel.render();
    for (const [panel, h] of this.handles) {
      const hot = [...this.pointers.values()].some((p) => p.hoverHandle === panel || p.carry?.panel === panel);
      h.material.opacity = hot ? 1 : 0.55;
    }
    this.applyRoom();
    this.draw(target);
  };

  /** The map (bloomed, if bloom is on) and the overlay over it. */
  private draw(target: THREE.WebGLRenderTarget | null) {
    const tu = this.map.tuning;
    const bloom = this.settings.bloom && !!tu && tu.bloomStrength > 0;
    this.map.setGlow(this.settings.bodyGlow, bloom);
    if (bloom) {
      this.bloom ??= new Bloom(this.renderer);
      this.bloom.render(this.renderer, this.scene, this.overlay, this.camera, target, { strength: tu.bloomStrength, radius: tu.bloomRadius, threshold: tu.bloomThreshold });
      return;
    }
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = false;
    this.renderer.render(this.overlay, this.camera);
    this.renderer.autoClear = true;
  }

  /**
   * A trigger held on the map. Held still, it's a pick (on release). Moved,
   * it drags the body it's on (the desktop's "Drag bodies"), or with that
   * knob off, moves the whole map as on open sky.
   */
  private updatePress(p: Pointer) {
    const press = p.press;
    if (press?.kind === "map") {
      const moved = p.kind === "mouse" ? this.mouse.moved : press.from.distanceTo(p.origin.clone().add(p.dir)) > 0.035;
      if (!moved) return;
      const id = this.map.tuning?.dragBodies ? this.map.bodyOf(press.hit) : null;
      const at = id ? this.map.positionOf(id) : null;
      if (id && at) {
        // Hold it where it is along the ray; from here on it rides the ray.
        const w = this.map.toWorld(at);
        p.press = { kind: "body", id, dist: Math.max(0.05, w.sub(p.origin).dot(p.dir)), hit: press.hit, trail: [], pin: false };
        this.haptic(p, 0.35, 20);
      } else {
        p.press = { kind: "grab", from: press.from, moved: true };
        if (p.kind !== "mouse") this.beginGrab(p);
      }
    }
    if (p.press?.kind === "body") {
      // Where the end of a metre of ray has been lately, to tell a throw from a drop.
      const now = performance.now();
      const tr = p.press.trail;
      tr.push({ t: now, at: p.origin.clone().add(p.dir) });
      while (tr.length > 2 && now - tr[0].t > 200) tr.shift();
      this.world.updateMatrixWorld();
      const w = p.origin.clone().addScaledVector(p.dir, p.press.dist);
      this.map.drag(p.press.id, this.map.root.worldToLocal(w));
    }
  }

  private updatePointer(p: Pointer) {
    if (p.kind === "mouse") {
      if (this.renderer.xr.isPresenting) return;
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(this.mouse.x, this.mouse.y), this.camera);
      p.origin.copy(rc.ray.origin);
      p.dir.copy(rc.ray.direction);
    } else {
      p.ray.updateMatrixWorld();
      p.origin.setFromMatrixPosition(p.ray.matrixWorld);
      p.dir.set(0, 0, -1).transformDirection(p.ray.matrixWorld);
    }

    // Panels first: they're in front of the map whenever they're in the way.
    const rc = new THREE.Raycaster(p.origin, p.dir, 0.01, 20);
    const openPanels = this.panels.filter((x) => x.open && x !== p.carry?.panel);
    const open = openPanels.map((x) => x.mesh);
    const hit = rc.intersectObjects(open, false)[0];
    // Their handles, just under them.
    const handleHit = rc.intersectObjects(openPanels.map((x) => this.handles.get(x)!), false)[0];
    p.hoverHandle = handleHit && (!hit || handleHit.distance <= hit.distance + 0.01) ? (handleHit.object.userData.handleOf as Panel) : null;
    let panelHit: Pointer["hoverPanel"] = null;
    if (hit?.uv) {
      const panel = hit.object.userData.panel as Panel;
      panelHit = { panel, x: hit.uv.x * panel.W, y: (1 - hit.uv.y) * panel.H };
    }
    // A press on a panel keeps talking to that panel until it's let go (a drag scrolls).
    if (p.press?.kind === "panel") {
      const pp = p.press.panel;
      if (panelHit?.panel === pp) pp.pointer("move", panelHit.x, panelHit.y, p.id);
    } else if (panelHit) {
      panelHit.panel.pointer("move", panelHit.x, panelHit.y, p.id);
    }
    if (p.hoverPanel && p.hoverPanel.panel !== panelHit?.panel && p.press?.kind !== "panel") {
      // Only clear the hover if no other pointer is on that panel.
      const other = [...this.pointers.values()].some((o) => o !== p && o.hoverPanel?.panel === p.hoverPanel!.panel);
      if (!other) p.hoverPanel.panel.pointer("leave", 0, 0, p.id);
    }
    p.hoverPanel = panelHit;

    let mapHit: MapHit | null = null;
    if (!panelHit && !p.hoverHandle && !p.carry && !(p.press?.kind === "grab" && this.grabs.length) && p.press?.kind !== "body") mapHit = this.map.pick(p.origin, p.dir);
    const hoverKey = (h: MapHit | null) => (h ? `${h.kind}:${h.id}` : null);
    if (hoverKey(mapHit) !== hoverKey(p.hoverMap) && mapHit) {
      if (p.lastHapticId !== hoverKey(mapHit)) this.haptic(p, 0.12, 8);
      p.lastHapticId = hoverKey(mapHit);
    }
    p.hoverMap = mapHit;

    // The ray stops at what it hits (or what it holds).
    const len = p.hoverHandle ? handleHit!.distance : panelHit ? hit!.distance : p.press?.kind === "body" ? p.press.dist : mapHit ? this.hitDistanceM(p, mapHit) : 3;
    p.line.scale.z = len;
    const aimed = !!(mapHit || panelHit || p.hoverHandle || p.press?.kind === "body");
    (p.line.material as THREE.LineBasicMaterial).color.set(p.press?.kind === "body" ? (p.press.pin ? C.runtime : C.course) : aimed ? "#ffffff" : C.static);
    p.dot.visible = aimed && (p.kind !== "mouse" || this.renderer.xr.isPresenting);
    p.dot.position.copy(p.origin).addScaledVector(p.dir, len);
    p.dot.scale.setScalar(Math.max(0.6, len * 0.8));

    this.updateHover();
  }

  /** The map hovers what the most recent pointer is on; its tag says what it is. */
  private updateHover() {
    const ptrs = [...this.pointers.values()].filter((p) => p.kind !== "mouse" || !this.renderer.xr.isPresenting);
    const hit = ptrs.find((p) => p.hoverMap)?.hoverMap ?? null;
    this.map.setHover(hit?.kind === "file" ? hit.id : null);
    if (!hit) return void (this.tag.sprite.visible = false);
    const at =
      hit.kind === "file" || hit.kind === "module" || hit.kind === "dir"
        ? this.map.positionOf(hit.kind === "file" ? hit.id : hit.kind === "module" ? (this.map.has(`mod:${hit.id}`) ? `mod:${hit.id}` : `grp:${hit.id}`) : `dir:${hit.id}`)
        : null;
    const owner = ptrs.find((p) => p.hoverMap === hit)!;
    const world = at ? this.map.toWorld(at) : owner.origin.clone().addScaledVector(owner.dir, this.hitDistanceM(owner, hit));
    const head = this.head();
    // Lift the tag a little above the body, in metres, toward the viewer.
    world.add(new THREE.Vector3(0, 1, 0).multiplyScalar(Math.max(0.02, world.distanceTo(head.pos) * 0.03)));
    this.tag.set(this.h.describe(hit));
    this.tag.place(world, head.pos, 0.11);
    this.tag.sprite.visible = true;
  }

  private readGamepads(dt: number) {
    for (const p of this.pointers.values()) {
      const gp = p.source?.gamepad;
      if (!gp || p.kind !== "controller") continue;
      const pressed = gp.buttons.map((b) => b.pressed);
      const edge = (i: number) => pressed[i] && !p.buttons[i];
      // xr-standard: 3 stick press, 4 A/X, 5 B/Y.
      if (p.handedness === "right") {
        if (edge(4)) this.h.onButton("menu");
        if (edge(5)) this.h.onButton("back");
        // On a body: focus on it, and again for its connections. On open sky: frame what's selected.
        if (edge(3)) {
          if (p.hoverMap && this.h.onFocus) this.h.onFocus(p.hoverMap);
          else this.h.onButton("frame");
        }
      } else {
        if (edge(4)) this.h.onButton("voice");
        if (edge(5)) this.h.onButton("overview");
        if (edge(3)) this.h.onButton("ask");
      }
      p.buttons = pressed;

      const ax = gp.axes[2] ?? 0;
      const ay = gp.axes[3] ?? 0;
      const dead = 0.18;
      const s = this.settings;
      // Carrying a panel, this hand's stick pushes it away or brings it closer.
      if (p.carry && Math.abs(ay) > dead) {
        const z = p.carry.offset.elements[14];
        const nz = THREE.MathUtils.clamp(z + ay * dt * 1.2, -4, -0.25);
        p.carry.offset.premultiply(tmpM.makeTranslation(0, 0, nz - z));
        continue;
      }
      // Holding a body, the stick pushes it away or reels it in.
      if (p.press?.kind === "body" && Math.abs(ay) > dead) {
        p.press.dist = THREE.MathUtils.clamp(p.press.dist * Math.exp(-ay * dt * 1.5), 0.05, 15);
        continue;
      }
      // Pointing at a panel, either stick scrolls it.
      if (p.hoverPanel && Math.abs(ay) > dead) {
        p.hoverPanel.panel.scrollBy(ay * dt * 1400);
        continue;
      }
      if (p.handedness === "left") {
        // Fly: push the stick and the map streams past, the way the controller points.
        if (Math.abs(ax) > dead || Math.abs(ay) > dead) {
          this.touched();
          const speed = 1.4 * s.flySpeed * (gp.buttons[1]?.pressed ? 3 : 1);
          // Where the controller points, or (a setting) where you look.
          const fwd = s.flyWhereLooking ? this.head().forward : p.dir.clone();
          const right = new THREE.Vector3().crossVectors(fwd, Y).normalize();
          const move = fwd.multiplyScalar(-ay).add(right.multiplyScalar(ax)).multiplyScalar(speed * dt);
          // You fly through the map, or (a setting) you push the map along.
          if (s.stickMovesMap) this.world.position.add(move);
          else this.world.position.sub(move);
        }
      } else if (p.handedness === "right") {
        // Turn on X (in steps, or smoothly), scale on Y (toward what you're pointing at).
        // About the middle of what you're looking at, or (a setting) about you.
        if (s.smoothTurn) {
          if (Math.abs(ax) > dead) {
            this.touched();
            p.turnPivot ??= this.turnPivot();
            this.rotateWorldAbout(p.turnPivot, -ax * dt * 1.6 * s.turnSpeed);
          } else p.turnPivot = null;
        } else if (Math.abs(ax) > 0.7 && !p.snapped) {
          p.snapped = true;
          this.touched();
          this.rotateWorldAbout(this.turnPivot(), THREE.MathUtils.degToRad(s.snapTurn) * (ax > 0 ? -1 : 1));
        } else if (Math.abs(ax) < 0.3) p.snapped = false;
        if (Math.abs(ay) > dead && Math.abs(ax) < 0.5) {
          const pivot = p.hoverMap ? p.origin.clone().addScaledVector(p.dir, this.hitDistanceM(p, p.hoverMap)) : p.origin.clone().addScaledVector(p.dir, 0.8);
          this.scaleWorldAbout(pivot, Math.exp(-ay * dt * 1.6 * s.scaleSpeed));
        }
      }
    }
  }

  /**
   * What a turn turns about: the focus if you can see it, else the body
   * you're looking at, else the map's middle if it's in front of you, else
   * you.
   */
  private turnPivot(): THREE.Vector3 {
    const head = this.head();
    if (this.settings.turnAroundMe) return head.pos;
    const seen = (w: THREE.Vector3) => w.clone().sub(head.pos).normalize().dot(head.forward) > Math.cos(THREE.MathUtils.degToRad(50));
    const f = this.map.focusBounds();
    if (f) {
      const w = this.map.toWorld(f.center);
      if (seen(w)) return w;
    }
    const hit = this.map.pick(head.pos, head.forward);
    const id = hit ? this.map.bodyOf(hit) : null;
    const at = id ? this.map.positionOf(id) : null;
    if (at) return this.map.toWorld(at);
    const b = this.map.bounds();
    if (b) {
      const w = this.map.toWorld(b.center);
      if (seen(w)) return w;
    }
    return head.pos;
  }

  /** Flat preview: the arrow keys fly (Shift for faster), Page Up/Down rise and sink. */
  private flatKeys(dt: number) {
    if (this.renderer.xr.isPresenting) return;
    const k = this.mouse.keys;
    if (!k.size) return;
    const v = new THREE.Vector3(
      (k.has("arrowright") ? 1 : 0) - (k.has("arrowleft") ? 1 : 0),
      (k.has("pageup") ? 1 : 0) - (k.has("pagedown") ? 1 : 0),
      (k.has("arrowdown") ? 1 : 0) - (k.has("arrowup") ? 1 : 0),
    );
    if (!v.lengthSq()) return;
    this.touched();
    this.world.position.sub(v.multiplyScalar(1.2 * dt * (k.has("shift") ? 3 : 1)).applyQuaternion(this.camera.quaternion));
  }
}

/** How far the map's middle is from the camera, for turning mouse pixels into metres. */
function pivotDistance(world: THREE.Group, camera: THREE.Camera) {
  return Math.max(0.3, world.position.distanceTo(tmpV.setFromMatrixPosition(camera.matrixWorld)));
}

/** A grid where your real floor is, fading out at its edge: somewhere to stand in the night sky. */
function makeFloor() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.5 }, uColor: { value: new THREE.Color(C.static).multiplyScalar(0.55) } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      varying vec2 vR;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vP = w.xz;
        vR = position.xz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3 uColor;
      varying vec2 vP;
      varying vec2 vR;
      float grid(vec2 p, float step) {
        vec2 g = abs(fract(p / step - 0.5) - 0.5) * step;
        vec2 l = 1.0 - smoothstep(vec2(0.0), fwidth(p) * 1.5, g);
        return max(l.x, l.y);
      }
      void main() {
        float fade = 1.0 - smoothstep(0.55, 1.0, length(vR));
        float a = grid(vP, 0.5) * 0.55 + grid(vP, 2.0) * 0.45;
        // A faint disc under the grid, so the floor reads as a surface and not just lines.
        float alpha = (a * 0.85 + 0.1) * fade * uOpacity;
        gl_FragColor = vec4(uColor * (0.4 + a), alpha);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2), mat);
  floor.renderOrder = -4;
  floor.visible = false;
  return floor;
}

/** The pill under each panel that carries it. */
let handleTex: THREE.CanvasTexture | null = null;
function handleTexture() {
  if (handleTex) return handleTex;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 42;
  const ctx = c.getContext("2d")!;
  roundRect(ctx, 4, 4, 248, 34, 17);
  ctx.fillStyle = "rgba(12, 20, 38, 0.92)";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = C.static;
  ctx.stroke();
  ctx.fillStyle = C.static;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.arc(128 + i * 22, 21, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  handleTex = new THREE.CanvasTexture(c);
  handleTex.colorSpace = THREE.SRGBColorSpace;
  return handleTex;
}
