import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import { DEFAULT_XR, type XRSettings } from "../lib/xrSettings";
import { Bloom } from "./bloom";
import { type Ell, HandGestures, inside } from "./hands";
import { MapView, type MapHit } from "./map";
import { sfx } from "./sound";
import { type Plane, type SavedTable, type Table, Surface, disc, facing, loadSurfaces, loadTable, mainAxis, overTable, planeThrough, saveSurfaces, saveTable, tableFrom, tableIn, tableInto, v3, vec } from "./surface";
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
 * Two scenes are drawn each frame: the map (with the stars, the floor, the
 * table it's set down on and the passthrough dimmer), which gets the desktop's
 * bloom (see bloom.ts), and the overlay over it (panels, hands, rays and
 * tags), which stays crisp.
 */

export type Mode = "flat" | "vr" | "ar";
export type Button = "menu" | "back" | "voice" | "overview" | "frame" | "ask" | "forward";
export type Slot = "left" | "right" | "center" | "low" | "dock" | "tune" | "hints" | "filter" | "focusbar" | "table" | "shelf" | "views" | "outline";
/** The slots that lie on the table when the map is on one: the strip along the front, the shelf on the right, the saved views on the left. */
const TABLE_SLOTS: Slot[] = ["table", "shelf", "views"];
/** Which kinds of hands are in: what the controls page lists. */
export type Inputs = { hands: boolean; controllers: boolean };

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
  /** A key pressed in the headset (a Bluetooth keyboard, say): true if it was used, so nothing else sees it. */
  onKey?: (e: KeyboardEvent) => boolean;
  /** Files picked out by hand: drawn round with a loop, or framed between two Ls. */
  onSelect?: (paths: string[], how: "lasso" | "frame") => void;
  /** Hands or controllers came or went. */
  onInputs?: (i: Inputs) => void;
  /** The map is (or no longer is) on a real table. */
  onTable?: (on: boolean) => void;
  /** Tracing the table (or a surface) by hand: how many corners so far, or null when done. */
  onOutline?: (o: { kind: "table" | "surface"; corners: number } | null) => void;
  /** How many surfaces of your own there are. */
  onSurfaces?: (n: number) => void;
};

export type { Table };

/** A wall the headset found (a vertical plane): its pose, and its extent in its own x and z. */
type Wall = { m: THREE.Matrix4; x0: number; x1: number; z0: number; z1: number };
/** A level surface the headset found (a horizontal plane): its pose, its outline in its own x and z, and its size. */
type Flat = { m: THREE.Matrix4; poly: [number, number][]; sx: number; sz: number };
/** Where a panel would land if let go now: flat on the table, flush on a wall, or on one of your surfaces (by its id). */
type Snap = { on: string; pos: THREE.Vector3; quat: THREE.Quaternion };
/**
 * A surface you traced: its plane, drawn like the table, and the headset's
 * anchor at its middle (made with its pose, so it brings the whole pose back
 * next session). Null `plane` until a restored anchor is found again.
 */
type Custom = { id: string; plane: Plane | null; poly: [number, number][]; top: Surface; anchor: XRAnchor | null; uuid: string | null; wanted: boolean };
/** How near a surface (m) a carried panel has to be let go for it to snap onto it. */
const SNAP_REACH = 0.14;

/** How long a pinch on open sky is held still before it draws a lasso instead of moving the map. */
const LASSO_HOLD = 450;
/** Where the headset's anchor for the table is kept between sessions. */
const ANCHOR_KEY = "constellate.xr.anchor";

type Grab = { p: Pointer; at0: THREE.Vector3; up0: THREE.Vector3 };
type Press =
  | { kind: "panel"; panel: Panel }
  | { kind: "map"; hit: MapHit; from: THREE.Vector3 }
  | { kind: "grab"; from: THREE.Vector3; moved: boolean; t0?: number }
  /** A hand's pinch held still on open sky, now drawing a loop round what to pick. */
  | { kind: "lasso"; pts: THREE.Vector3[] }
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
  carry: { panel: Panel; offset: THREE.Matrix4; trail: { t: number; at: THREE.Vector3 }[] } | null;
  buttons: boolean[];
  /** Thumbstick turned past the snap threshold, waiting for it to come back. */
  snapped: boolean;
  /** What a smooth turn turns about, fixed while the stick is held. */
  turnPivot: THREE.Vector3 | null;
  /** This hand stretching a panel the other hand is carrying. */
  resize: { panel: Panel; holder: Pointer; w0: number; h0: number; dx0: number; dy0: number; at: number } | null;
  lastHapticId: string | null;
  /** A tracked hand: its joints, and what it's doing with them. */
  hand?: THREE.XRHandSpace;
  gest?: HandGestures;
  /** The panel the index fingertip is pressing, as a touch, and where on it. */
  poke?: { panel: Panel; x: number; y: number } | null;
  /** The body the fingertip last touched, until it moves away. */
  pokeBody?: string | null;
};

const MIN_SCALE = 0.00015;
const MAX_SCALE = 0.25;
const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
/** Keys that fly in the headset: the preview's, and the desktop's WASD and Q / E. */
const FLY_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown", "w", "a", "s", "d", "q", "e", "shift"]);

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
  /** Panels the map stands in front of: drawn before the map, so it covers them. */
  readonly under = new THREE.Scene();
  private behind = new Set<Panel>();
  private sortedAt = 0;
  /** The scene's background while a frame is drawn in parts. */
  private sky: THREE.Scene["background"] = null;
  mode: Mode = "flat";
  settings: XRSettings = DEFAULT_XR;

  private stars: THREE.Points;
  private floor: THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>;
  /**
   * Where the map is set down, in the room: it holds still while you move the
   * map, and the overview puts the map back on it. Placed by `placeSurface`.
   */
  private surface = new Surface();
  private surfaceSet = false;
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
  /** The headset's own anchor at that spot, so the map stays on the table as tracking settles, and comes back to it next time. */
  private xrAnchor: XRAnchor | null = null;
  /** Where that anchor was last frame: when it moves, everything on the table moves with it. */
  private anchorLast: THREE.Vector3 | null = null;
  /** A spot just placed on, waiting for the next frame to anchor it. */
  private anchorWanted: THREE.Vector3 | null = null;
  /** Looking for the table under a spot, among the detected planes, until a little while has passed. */
  private tableFrom: { at: THREE.Vector3; t0: number } | null = null;
  table: Table | null = null;
  /** Panels set by the room: the one on your wrist, and the shelf a dragged body can be dropped on. */
  wrist: Panel | null = null;
  shelf: Panel | null = null;
  /** Close a panel thrown away; false for one that can't be closed (it just drops). */
  closePanel: ((p: Panel) => boolean) | null = null;
  /** Panels lying on a real surface: on the table they move with it, and a fingertip presses them against it. */
  private stuck = new Map<Panel, string>();
  /** The surfaces you traced, this session (kept by their anchors for the next). */
  private customs: Custom[] = [];
  /** The walls the headset has found, looked at again every so often. */
  private walls: Wall[] = [];
  /** The level surfaces the headset has found: where a table is looked for. */
  private flats: Flat[] = [];
  private planesAt = 0;
  /** The anchor's pose this session, once tracked: the table is kept relative to it. */
  private anchorPose: THREE.Matrix4 | null = null;
  /** Coming back in without the anchor: last time's table, looked for among the planes for a while. */
  private lookFor: { saved: SavedTable; t0: number } | null = null;
  /** Corners touched so far while tracing the table by hand; null when not tracing. */
  private outline: THREE.Vector3[] | null = null;
  /** What the outline being traced is for: the table, or a surface of your own. */
  private outlineFor: "table" | "surface" = "table";
  private outlineLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** The outline of where a carried panel would snap to. */
  private ghost: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** The snap the carried panel had last frame, to tick when one comes into reach. */
  private snapWas: string | null = null;
  private lasso: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** Both hands in an L: since when, and whether it has fired. */
  private framing = { since: 0, fired: false };
  private inputs: Inputs = { hands: false, controllers: false };
  private mouse = { x: 0, y: 0, down: -1, lastX: 0, lastY: 0, moved: false, keys: new Set<string>() };
  private dockYaw = 0;
  /** The drawn controllers and hands, shown or not by the settings. */
  private models: { controllers: THREE.Object3D[]; hands: THREE.Object3D[] } = { controllers: [], hands: [] };
  /** Controllers you've put down: still tracked, drawn where they lie, but no longer pointing. */
  private resting: { grip: THREE.Group; source: XRInputSource | null }[] = [];
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
    // Only drawn, never pointed at: rays, grabs and panels go straight through it.
    this.scene.add(this.surface.mesh);

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

    // The loop a lasso draws, and the frame two Ls make.
    const lassoGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(512 * 3), 3));
    this.lasso = new THREE.Line(lassoGeo, new THREE.LineBasicMaterial({ color: C.course, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
    this.lasso.frustumCulled = false;
    this.lasso.renderOrder = 31;
    this.lasso.visible = false;
    this.overlay.add(this.lasso);

    // Where a carried panel will land: its outline on the table or the wall.
    const ghostGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)]);
    this.ghost = new THREE.LineLoop(ghostGeo, new THREE.LineBasicMaterial({ color: C.good, transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
    this.ghost.renderOrder = 31;
    this.ghost.visible = false;
    this.overlay.add(this.ghost);

    // The table's outline as it's traced by hand.
    const outlineGeo = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(66 * 3), 3));
    this.outlineLine = new THREE.Line(outlineGeo, new THREE.LineBasicMaterial({ color: C.good, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false }));
    this.outlineLine.frustumCulled = false;
    this.outlineLine.renderOrder = 31;
    this.outlineLine.visible = false;
    this.overlay.add(this.outlineLine);

    // Now and then a body on the map chimes: one at random, in its top folder's note.
    sfx.chimeSource = () => {
      if (this.mode === "flat") return null;
      const files = this.map.files();
      const id = files[Math.floor(Math.random() * files.length)];
      const at = id ? this.map.positionOf(id) : null;
      return at ? { at: this.map.toWorld(at), key: id.split("/")[0] } : null;
    };

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
    sfx.configure(s);
    if (s.foveation !== was.foveation) this.renderer.xr.setFoveation(s.foveation);
    if (s.renderScale !== was.renderScale && !this.renderer.xr.isPresenting) this.renderer.xr.setFramebufferScaleFactor(s.renderScale);
    if (s.panelDistance !== was.panelDistance) this.recenterPanels();
    this.applyRoom();
  }

  /** The floor, the table, the passthrough dimmer and the stars, for this mode and these settings. */
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
    // While you're choosing a surface, the reticle says where; the old table would only confuse it.
    this.surface.mesh.visible = this.surfaceSet && this.mode !== "flat" && !this.placing && !this.outline && s.table && s.tableOpacity > 0;
    this.surface.opacity = s.tableOpacity;
    // On a real table it is the table, and follows it as tracking corrects where that is.
    if (this.mode === "ar" && this.table) this.surface.setPose(this.table.center.clone().addScaledVector(Y, 0.002), this.table.toward);
    for (const c of this.customs) {
      c.top.mesh.visible = this.mode === "ar" && !!c.plane && s.tableOpacity > 0;
      c.top.opacity = s.tableOpacity * 0.8;
    }
    for (const m of this.models.controllers) m.visible = s.controllerModels;
    for (const m of this.models.hands) m.visible = s.handModels;
  }

  /**
   * Put the table where the overview sets the map down: on the surface you
   * placed it on (AR), else under the overview's framing in front of you.
   */
  private placeSurface() {
    const f = this.overviewFrame();
    this.surfaceSet = true;
    // On the real table when one was found under the anchor: its own shape (see setTable).
    if (this.mode === "ar" && this.table) return this.surface.setShape(this.table.poly);
    // Else a disc at the anchor, or under the overview's framing in front of you.
    this.surface.setShape(disc(f.radiusM * 1.25));
    const { pos, yaw } = this.head();
    const at = this.mode === "ar" && this.anchor ? this.anchor.clone() : new THREE.Vector3(pos.x - Math.sin(yaw) * f.dist, Math.max(0.05, pos.y + f.dy - f.radiusM), pos.z - Math.cos(yaw) * f.dist);
    this.surface.setPose(at, new THREE.Vector3(0, 0, 1));
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
    // Audio starts on the press that took you in, while it still counts as one.
    sfx.start();
    const session = await navigator.xr.requestSession(mode === "vr" ? "immersive-vr" : "immersive-ar", {
      requiredFeatures: ["local-floor"],
      optionalFeatures: mode === "ar" ? ["hand-tracking", "tracked-sources", "hit-test", "plane-detection", "anchors"] : ["hand-tracking", "tracked-sources", "bounded-floor"],
    });
    // With one hand free and a controller in the other, the one you set down moves here.
    session.addEventListener("trackedsourceschange", (e) => this.trackedSourcesChange(e as XRInputSourcesChangeEvent));
    this.session = session;
    session.addEventListener("end", () => {
      if (this.session !== session) return;
      this.session = null;
      for (const r of this.resting) if (r.source) this.restingOff(r);
      this.hitSource?.cancel();
      this.hitSource = null;
      this.mouse.keys.clear();
      sfx.stop();
      this.setMode("flat");
    });
    await this.renderer.xr.setSession(session);
    // Keys typed in the headset are the room's: none should land in a desktop field you can't see.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // A new session is a new room: panels open in front of you again.
    this.placed.clear();
    this.stuck.clear();
    this.setMode(mode);
    sfx.play("enter");
    if (mode === "ar") {
      const saved = loadTable();
      this.lookFor = saved?.plane ? { saved, t0: performance.now() } : null;
      void this.restoreAnchor(session);
      void this.restoreSurfaces(session);
    }
    // Once the first poses are in, set the surface in front of you and frame what you were looking at (or the whole map).
    setTimeout(() => {
      this.placeSurface();
      if (this.h.onEntered) this.h.onEntered();
      else this.overview(900);
    }, 400);
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
    if (this.wrist) this.hide(this.wrist);
    if (!ar) {
      this.anchor = null;
      this.xrAnchor = null;
      this.anchorLast = null;
      this.anchorWanted = null;
      this.tableFrom = null;
      this.lookFor = null;
      this.anchorPose = null;
      this.walls = [];
      this.flats = [];
      this.setTable(null);
    }
    if (this.outline) this.cancelOutline();
    this.dropSurfaces();
    this.surfaceSet = false;
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
    // One you've stuck on a wall or the table stays there, seen or not.
    if (!was && (!this.placed.has(p) || (!this.inView(p) && !this.stuck.has(p)) || slot === "focusbar")) this.place(p, slot);
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
    this.stuck.clear();
    for (const [p, slot] of this.slots) if (p.open) this.place(p, slot);
  }

  private place(p: Panel, slot: Slot) {
    this.stuck.delete(p);
    if (TABLE_SLOTS.includes(slot) && this.table) {
      const { pos, quat } = this.tablePose(p, slot);
      p.mesh.position.copy(pos);
      p.mesh.quaternion.copy(quat);
      this.stuck.set(p, "table");
      this.placed.add(p);
      return;
    }
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
      table: { yaw: 0, dist: 0.7, dy: -0.45, tilt: 0.9 },
      shelf: { yaw: -0.5, dist: 0.8, dy: -0.4, tilt: 0.7 },
      views: { yaw: 0.5, dist: 0.85, dy: -0.3, tilt: 0.4 },
      outline: { yaw: 0, dist: 1.0, dy: 0.05, tilt: 0 },
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
    const f = this.overviewFrame();
    const at = this.mode === "ar" && this.anchor ? this.anchor.clone().add(new THREE.Vector3(0, f.radiusM, 0)) : undefined;
    this.frameAt(b.center, b.radius, { ...f, ms, at });
    // The map is set down again: the table goes under it.
    if (this.mode !== "flat") this.placeSurface();
    // Then it drifts, as the desktop's overview does (on the table or in the preview; turning the whole sky around you in VR is no comfort).
    this.drift = true;
  }

  /** How the overview frames the whole map: small on the table in AR, all around you in VR, further out in the preview. */
  private overviewFrame() {
    if (this.mode === "ar") return { radiusM: 0.38, dist: 0.95, dy: -0.4 };
    if (this.mode === "vr") return { radiusM: 1.1, dist: 2.0, dy: -0.1 };
    return { radiusM: 0.85, dist: 1.65, dy: 0.05 };
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
      const cm = controllerModels.createControllerModel(grip);
      const hm = handModels.createHandModel(hand, "mesh");
      grip.add(cm);
      hand.add(hm);
      this.models.controllers.push(cm);
      this.models.hands.push(hm);
      this.overlay.add(ray, grip, hand);
      const { line, dot } = this.makeRayVisual();
      ray.add(line);
      const id = `xr${i}`;
      ray.addEventListener("connected", (e) => {
        const source = (e as unknown as { data: XRInputSource }).data;
        const handedness = source.handedness === "left" ? "left" : source.handedness === "right" ? "right" : "none";
        this.pointers.set(id, {
          id,
          kind: source.hand ? "hand" : "controller",
          handedness,
          hand: source.hand ? hand : undefined,
          gest: source.hand ? new HandGestures(handedness) : undefined,
          poke: null,
          pokeBody: null,
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
        this.reportInputs();
      });
      ray.addEventListener("disconnected", () => {
        const p = this.pointers.get(id);
        if (p) {
          this.endGrab(p);
          this.endPoke(p);
          if (p.press?.kind === "lasso") this.lasso.visible = false;
        }
        this.pointers.delete(id);
        line.visible = false;
        dot.visible = false;
        this.reportInputs();
      });
      ray.addEventListener("selectstart", () => this.pressStart(id));
      ray.addEventListener("selectend", () => this.pressEnd(id));
      ray.addEventListener("squeezestart", () => this.squeezeStart(id));
      ray.addEventListener("squeezeend", () => this.squeezeEnd(id));
    }
    for (let i = 0; i < 2; i++) {
      const grip = new THREE.Group();
      grip.matrixAutoUpdate = false;
      grip.visible = false;
      const cm = controllerModels.createControllerModel(grip);
      grip.add(cm);
      this.models.controllers.push(cm);
      this.overlay.add(grip);
      this.resting.push({ grip, source: null });
    }
  }

  private trackedSourcesChange(e: XRInputSourcesChangeEvent) {
    for (const s of e.removed) {
      const r = this.resting.find((x) => x.source === s);
      if (r) this.restingOff(r);
    }
    for (const s of e.added) {
      // A hand that isn't pointing has nothing to show; a controller lying there does.
      if (s.hand || !s.gripSpace || this.resting.some((x) => x.source === s)) continue;
      const r = this.resting.find((x) => !x.source);
      if (!r) break;
      r.source = s;
      r.grip.dispatchEvent({ type: "connected", data: s } as never);
    }
  }

  private restingOff(r: { grip: THREE.Group; source: XRInputSource | null }) {
    r.grip.dispatchEvent({ type: "disconnected", data: r.source } as never);
    r.source = null;
    r.grip.visible = false;
  }

  private placeResting(xrFrame: XRFrame) {
    const ref = this.renderer.xr.getReferenceSpace();
    for (const r of this.resting) {
      const pose = r.source?.gripSpace && ref ? xrFrame.getPose(r.source.gripSpace, ref) : undefined;
      r.grip.visible = !!pose;
      if (!pose) continue;
      r.grip.matrix.fromArray(pose.transform.matrix);
      r.grip.matrixWorldNeedsUpdate = true;
    }
  }

  /** Tell the room whether hands, controllers or both are in, when that changes. */
  private reportInputs() {
    const ps = [...this.pointers.values()];
    const i = { hands: ps.some((p) => p.kind === "hand"), controllers: ps.some((p) => p.kind === "controller") };
    if (i.hands === this.inputs.hands && i.controllers === this.inputs.controllers) return;
    this.inputs = i;
    this.h.onInputs?.(i);
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
    // In the headset a keyboard is the room's: the panels have it first, then
    // it flies, and the desktop's shortcuts get only what's left. Captured, so
    // they don't see what was used.
    const ours = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener(
      "keydown",
      (e) => {
        const xr = this.renderer.xr.isPresenting;
        if (!xr && (e.target as HTMLElement)?.tagName === "INPUT") return;
        if (xr && this.h.onKey?.(e)) return ours(e);
        const key = e.key.toLowerCase();
        this.mouse.keys.add(key);
        if (xr && FLY_KEYS.has(key) && !e.ctrlKey && !e.metaKey && !e.altKey) ours(e);
      },
      true,
    );
    window.addEventListener(
      "keyup",
      (e) => {
        const key = e.key.toLowerCase();
        this.mouse.keys.delete(key);
        if (this.renderer.xr.isPresenting && FLY_KEYS.has(key)) ours(e);
      },
      true,
    );
    window.addEventListener("blur", () => this.mouse.keys.clear());
  }

  private hitDistanceM(p: Pointer, hit: MapHit) {
    return hit.t * this.world.scale.x || p.origin.distanceTo(this.world.position);
  }

  private pressStart(id: string) {
    const p = this.pointers.get(id);
    if (!p) return;
    sfx.resume();
    if (this.placing && this.reticle.visible) {
      this.placeAt(this.reticle.position.clone());
      return;
    }
    // Tracing the table: anywhere but a panel, the press marks a corner.
    if (this.outline && !p.hoverPanel && !p.hoverHandle) {
      if (this.outline.length < 64) this.outline.push(this.cornerAt(p));
      this.haptic(p, 0.5, 25);
      sfx.play("tick", this.cornerAt(p));
      this.h.onOutline?.({ kind: this.outlineFor, corners: this.outline.length });
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
    // A pinch held still there a moment draws a lasso instead (see updatePress).
    p.press = { kind: "grab", from: p.origin.clone().add(p.dir), moved: false, t0: p.kind === "hand" ? performance.now() : undefined };
    if (p.kind !== "mouse") this.beginGrab(p);
  }

  private pressEnd(id: string) {
    const p = this.pointers.get(id);
    if (!p?.press) return;
    const press = p.press;
    p.press = null;
    const moved = (from: THREE.Vector3) => from.distanceTo(p.origin.clone().add(p.dir)) > (p.kind === "mouse" ? 0.02 : 0.035);
    if (press.kind === "handle") {
      if (!p.squeezing) this.letGo(p);
    } else if (press.kind === "lasso") {
      this.lasso.visible = false;
      const pts = press.pts;
      let length = 0;
      for (let i = 1; i < pts.length; i++) length += pts[i].distanceTo(pts[i - 1]);
      if (pts.length >= 6 && length > 0.12) {
        const paths = this.within(pts);
        if (paths.length) {
          sfx.play("focus");
          this.h.onSelect?.(paths, "lasso");
        }
      } else this.h.onBackground();
    } else if (press.kind === "body") {
      // Thrown, not set down: hide it.
      const tr = press.trail;
      const first = tr.find((x) => performance.now() - x.t < 120) ?? tr[0];
      const last = tr.at(-1);
      const speed = first && last && last.t > first.t ? last.at.distanceTo(first.at) / ((last.t - first.t) / 1000) : 0;
      // Thrown, or dropped on the table's shelf: off the map.
      const shelved = !!this.shelf && p.hoverPanel?.panel === this.shelf && !!this.h.onFlick;
      const thrown = shelved || (this.settings.flick && speed > this.settings.flickSpeed && !!this.h.onFlick);
      const at = this.map.positionOf(press.id);
      const where = at ? this.map.toWorld(at) : null;
      this.map.release(press.id, press.pin && !thrown);
      if (thrown) {
        this.haptic(p, 0.8, 60);
        sfx.play(shelved ? "snap" : "fling", where);
        this.h.onFlick!(press.hit);
      } else {
        this.haptic(p, press.pin ? 0.6 : 0.3, press.pin ? 40 : 20);
        sfx.play("drop", where);
      }
    } else if (press.kind === "panel") {
      const hp = p.hoverPanel?.panel === press.panel ? p.hoverPanel : null;
      press.panel.pointer("up", hp?.x ?? -1, hp?.y ?? -1, p.id);
    } else if (press.kind === "map") {
      const still = p.kind === "mouse" ? !this.mouse.moved : !moved(press.from);
      if (still) {
        this.haptic(p, 0.5, 30);
        sfx.play("pick", this.hitPoint(p, press.hit), this.hitKey(press.hit));
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
    p.carry = { panel, offset: tmpM.copy(p.ray.matrixWorld).invert().multiply(panel.mesh.matrixWorld).clone(), trail: [] };
    this.placed.add(panel);
    this.stuck.delete(panel);
    this.snapWas = null;
    this.haptic(p, 0.4, 25);
    sfx.play("grab", panel.mesh.position);
  }

  /** A carried panel let go: near the table or a wall it snaps onto it, else it stays in the air where it is. */
  private letGo(p: Pointer) {
    const c = p.carry;
    p.carry = null;
    p.resize = null;
    if (!c) return;
    this.ghost.visible = false;
    this.snapWas = null;
    // Thrown away, not set down: it closes (those that can).
    const tr = c.trail;
    const first = tr.find((x) => performance.now() - x.t < 120) ?? tr[0];
    const last = tr.at(-1);
    const speed = first && last && last.t > first.t ? last.at.distanceTo(first.at) / ((last.t - first.t) / 1000) : 0;
    if (this.settings.flickPanels && speed > this.settings.flickSpeed && this.closePanel?.(c.panel)) {
      this.haptic(p, 0.8, 60);
      sfx.play("fling", c.panel.mesh.position);
      // Next time it opens in its usual place, not mid-air where it was let go.
      this.placed.delete(c.panel);
      return;
    }
    const snap = this.snapFor(c.panel);
    if (!snap) return void sfx.play("drop", c.panel.mesh.position);
    c.panel.mesh.position.copy(snap.pos);
    c.panel.mesh.quaternion.copy(snap.quat);
    this.stuck.set(c.panel, snap.on);
    this.haptic(p, 0.7, 35);
    sfx.play("snap", snap.pos);
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
      if (p.press?.kind !== "handle") this.letGo(p);
      return;
    }
    this.endGrab(p);
  }

  private grabPoint(p: Pointer) {
    p.ray.updateMatrixWorld();
    return new THREE.Vector3().setFromMatrixPosition(p.ray.matrixWorld);
  }

  /** Which way is up for the hand: twisting it turns this about the ray. */
  private grabUp(p: Pointer) {
    p.ray.updateMatrixWorld();
    return new THREE.Vector3(0, 1, 0).transformDirection(p.ray.matrixWorld);
  }

  private beginGrab(p: Pointer) {
    if (this.grabs.some((g) => g.p === p)) return;
    // The other hand reaching for the map: a lasso in progress is dropped.
    for (const o of this.pointers.values())
      if (o.press?.kind === "lasso") {
        o.press = null;
        this.lasso.visible = false;
      }
    this.touched();
    this.grabs.push({ p, at0: this.grabPoint(p), up0: this.grabUp(p) });
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
    for (const g of this.grabs) {
      g.at0 = this.grabPoint(g.p);
      g.up0 = this.grabUp(g.p);
    }
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
    // Two hands: stretch to scale, turn to rotate (any way: round, over, or
    // rolled by twisting both wrists), all about the midpoint.
    const a = this.grabPoint(this.grabs[0].p);
    const b = this.grabPoint(this.grabs[1].p);
    const d0 = s0.b.distanceTo(s0.a);
    const k = THREE.MathUtils.clamp(s0.scale * (a.distanceTo(b) / Math.max(0.01, d0)), MIN_SCALE, MAX_SCALE) / s0.scale;
    const axis0 = s0.b.clone().sub(s0.a).normalize();
    const axis = b.clone().sub(a).normalize();
    const swing = new THREE.Quaternion().setFromUnitVectors(axis0, axis);
    // The line between the hands can't say how far it rolled; the wrists can.
    let roll = 0;
    for (const g of this.grabs.slice(0, 2)) {
      const u0 = g.up0.clone().applyQuaternion(swing).projectOnPlane(axis);
      const u1 = this.grabUp(g.p).projectOnPlane(axis);
      if (u0.lengthSq() < 1e-4 || u1.lengthSq() < 1e-4) continue;
      roll += Math.atan2(new THREE.Vector3().crossVectors(u0, u1).dot(axis), u0.dot(u1)) / 2;
    }
    const q = new THREE.Quaternion().setFromAxisAngle(axis, roll).multiply(swing);
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
    // Anchored on the next frame (anchors are made from a frame), and the table under it looked for:
    // unless it's set down again on a table you traced by hand, which stays as you drew it.
    this.anchorWanted = at.clone();
    this.lookFor = null;
    if (this.table?.manual && overTable(this.table, at)) this.tableFrom = null;
    else this.tableFrom = { at: at.clone(), t0: performance.now() };
    sfx.play("place", at);
    this.overview(900);
    this.h.onPlaced?.();
  }

  /* --------------------------------- table --------------------------------- */

  /** Last session's table, if the headset kept its anchor: the map goes back on it. */
  private async restoreAnchor(session: XRSession) {
    let uuid: string | null = null;
    try {
      uuid = localStorage.getItem(ANCHOR_KEY);
    } catch {
      /* no storage: nothing to restore */
    }
    if (!uuid || !session.restorePersistentAnchor) return;
    try {
      const a = await session.restorePersistentAnchor(uuid);
      if (this.session !== session || this.anchor) return a.delete();
      this.xrAnchor = a;
      this.anchorLast = null;
    } catch {
      // Gone (the room was reset, or another app's space): forget it. The plane may still find the table.
      try {
        localStorage.removeItem(ANCHOR_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  /** A new anchor for the table: the old one goes, and this one is kept for next time where the headset allows. */
  private adoptAnchor(a: XRAnchor) {
    const session = this.session;
    this.xrAnchor?.delete();
    this.xrAnchor = a;
    this.anchorLast = null;
    this.anchorPose = null;
    let old: string | null = null;
    try {
      old = localStorage.getItem(ANCHOR_KEY);
    } catch {
      /* ignore */
    }
    if (old && session?.deletePersistentAnchor) void session.deletePersistentAnchor(old).catch(() => {});
    if (!a.requestPersistentHandle) return;
    void a
      .requestPersistentHandle()
      .then((uuid) => localStorage.setItem(ANCHOR_KEY, uuid))
      .catch(() => {});
  }

  /**
   * Once a frame in passthrough: make the wanted anchor, follow the anchor as
   * tracking corrects it, find the table. Coming back in, the map goes back on
   * last time's table: by the headset's anchor when it kept it, or else by
   * finding the same plane again (the same size, at the same height).
   */
  private trackTable(frame: XRFrame) {
    const ref = this.renderer.xr.getReferenceSpace();
    if (!ref) return;
    const now = performance.now();
    if (now - this.planesAt > 1000) {
      this.planesAt = now;
      this.findPlanes(frame, ref);
    }
    this.trackSurfaces(frame, ref);
    if (this.anchorWanted) {
      const w = this.anchorWanted;
      this.anchorWanted = null;
      void frame
        .createAnchor?.(new XRRigidTransform({ x: w.x, y: w.y, z: w.z }), ref)
        ?.then((a) => (this.mode === "ar" ? this.adoptAnchor(a) : a.delete()))
        .catch(() => {});
    }
    const a = this.xrAnchor;
    if (a && frame.trackedAnchors?.has(a)) {
      const pose = frame.getPose(a.anchorSpace, ref);
      if (pose) {
        const first = !this.anchorPose;
        this.anchorPose = new THREE.Matrix4().fromArray(pose.transform.matrix);
        const at = new THREE.Vector3().setFromMatrixPosition(this.anchorPose);
        if (!this.anchor) {
          // Restored from last time: the map goes back on that table, as it was.
          this.anchor = at.clone();
          this.anchorLast = at.clone();
          this.lookFor = null;
          const saved = loadTable();
          if (saved?.anchor) this.setTable(facing(tableIn(this.anchorPose, saved.anchor, saved.poly, saved.manual), this.head().pos));
          else this.tableFrom = { at: at.clone(), t0: now };
          this.overview(900);
          this.h.onPlaced?.();
        } else if (!this.anchorLast) this.anchorLast = at.clone();
        else {
          const d = at.clone().sub(this.anchorLast);
          // Tracking corrected where the table is: take the map and what's on the table along.
          if (d.lengthSq() > 1e-6) {
            this.anchorLast.copy(at);
            this.anchor.add(d);
            this.world.position.add(d);
            if (this.flight) this.flight.toP.add(d);
            this.grabStart?.pos.add(d);
            if (this.table) this.table.center.add(d);
            for (const [p, on] of this.stuck) if (on === "table") p.mesh.position.add(d);
          }
        }
        // A new anchor's first pose: the table is kept against it.
        if (first) this.persistTable();
      }
    }
    // No anchor came back: look for last time's plane, for a while.
    const lf = this.lookFor;
    if (lf && !this.anchor && now - lf.t0 > 2500) {
      if (now - lf.t0 > 20000) this.lookFor = null;
      else this.findSavedPlane(lf.saved);
    }
    if (this.tableFrom) {
      const t = this.fitTable(this.tableFrom.at);
      if (t) this.setTable(t);
      else if (now - this.tableFrom.t0 > 1500) this.setTable(this.guessTable(this.tableFrom.at));
      if (this.table) this.tableFrom = null;
    }
  }

  /** Last time's plane among those found now, by its size and height: the map goes back on it. */
  private findSavedPlane(saved: SavedTable) {
    const sp = saved.plane;
    if (!sp) return void (this.lookFor = null);
    const match = this.flats.find((f) => {
      const y = new THREE.Vector3().setFromMatrixPosition(f.m).y;
      return Math.abs(y - sp.y) < 0.05 && Math.abs(f.sx - sp.sx) < 0.08 && Math.abs(f.sz - sp.sz) < 0.08;
    });
    if (!match) return;
    this.lookFor = null;
    const spot = vec(sp.spot).applyMatrix4(match.m);
    this.anchor = spot;
    this.anchorWanted = spot.clone();
    this.setTable(facing(tableIn(match.m, sp, saved.poly, saved.manual), this.head().pos));
    this.overview(900);
    this.h.onPlaced?.();
  }

  /** The detected level surface under a spot, if any: the plane itself, a little above or below it. */
  private flatUnder(at: THREE.Vector3): Flat | null {
    for (const f of this.flats) {
      const local = at.clone().applyMatrix4(f.m.clone().invert());
      if (Math.abs(local.y) < 0.06 && inside(local.x, local.z, f.poly)) return f;
    }
    return null;
  }

  /** The detected horizontal plane under a spot, as a table: its own outline, its front the side nearest you. */
  private fitTable(at: THREE.Vector3): Table | null {
    const f = this.flatUnder(at);
    if (!f) return null;
    // The floor (or something as big): no table to fit; a mat round the spot instead.
    if (f.sx > 2.6 || f.sz > 2.6) return this.guessTable(at);
    const pts = f.poly.map(([x, z]) => new THREE.Vector3(x, 0, z).applyMatrix4(f.m));
    const y = new THREE.Vector3().setFromMatrixPosition(f.m).y;
    return facing(tableFrom(pts, new THREE.Vector3(0, 0, 1).transformDirection(f.m), y), this.head().pos);
  }

  /** No planes to go by: a table a little wider than deep, square to you, around the spot. */
  private guessTable(at: THREE.Vector3): Table {
    const toward = this.head().pos.sub(at).setY(0);
    if (toward.lengthSq() < 1e-4) toward.set(0, 0, 1);
    toward.normalize();
    const right = new THREE.Vector3().crossVectors(Y, toward).normalize();
    const corner = (x: number, z: number) => at.clone().addScaledVector(right, x).addScaledVector(toward, z);
    return tableFrom([corner(-0.45, -0.3), corner(0.45, -0.3), corner(0.45, 0.3), corner(-0.45, 0.3)], toward, at.y);
  }

  private setTable(t: Table | null) {
    const had = !!this.table;
    this.table = t;
    // The table's panels go on it (back to their edges, when it's a new table).
    for (const [p, slot] of this.slots) if (p.open && TABLE_SLOTS.includes(slot)) this.place(p, slot);
    if (!t) for (const [p, on] of this.stuck) if (on === "table") this.stuck.delete(p);
    if (t) {
      this.surface.setShape(t.poly);
      this.surfaceSet = true;
      this.persistTable();
    }
    if (had !== !!t || t) this.h.onTable?.(!!t);
  }

  /** The table as it is now, kept for next time: against the anchor, and against the plane it lies on. */
  private persistTable() {
    const t = this.table;
    if (!t || this.mode !== "ar") return;
    const saved: SavedTable = { poly: t.poly, manual: t.manual };
    if (this.anchorPose) saved.anchor = tableInto(this.anchorPose.clone().invert(), t);
    const f = this.flatUnder(t.center);
    if (f && this.anchor) {
      const inv = f.m.clone().invert();
      saved.plane = { sx: f.sx, sz: f.sz, y: new THREE.Vector3().setFromMatrixPosition(f.m).y, spot: v3(this.anchor.clone().applyMatrix4(inv)), ...tableInto(inv, t) };
    }
    saveTable(saved);
  }

  /* ------------------------- tracing the table by hand ------------------------- */

  /**
   * When the headset doesn't know the table (or knows it wrong): touch its
   * corners one by one, pinching (or pulling the trigger) at each, and the
   * outline becomes the table. Three corners make a rectangle; more trace
   * any shape.
   */
  startOutline(kind: "table" | "surface" = "table") {
    if (this.mode !== "ar") return;
    this.placing = false;
    this.reticle.visible = false;
    this.outline = [];
    this.outlineFor = kind;
    this.h.onOutline?.({ kind, corners: 0 });
  }

  undoOutline() {
    if (!this.outline) return;
    this.outline.pop();
    this.h.onOutline?.({ kind: this.outlineFor, corners: this.outline.length });
  }

  cancelOutline() {
    this.outline = null;
    this.outlineLine.visible = false;
    this.h.onOutline?.(null);
  }

  finishOutline() {
    const raw = this.outline;
    if (!raw || raw.length < 3) return;
    if (this.outlineFor === "surface") {
      this.cancelOutline();
      return this.addSurface(raw);
    }
    const y = raw.reduce((s, p) => s + p.y, 0) / raw.length;
    let pts = raw.map((p) => p.clone().setY(y));
    if (pts.length === 3) {
      // Three corners in a row: the fourth is where they square off.
      const [a, b, c] = pts;
      const ab = b.clone().sub(a);
      const bc = c.clone().sub(b);
      bc.sub(ab.clone().multiplyScalar(bc.dot(ab) / Math.max(1e-6, ab.lengthSq())));
      pts = [a, b, b.clone().add(bc), a.clone().add(bc)];
    }
    this.cancelOutline();
    const t = facing(tableFrom(pts, mainAxis(pts), y, true), this.head().pos);
    // The map goes on it, unless it's already there.
    if (!this.anchor || !overTable(t, this.anchor)) {
      this.anchor = t.center.clone();
      this.anchorWanted = t.center.clone();
    }
    this.tableFrom = null;
    this.lookFor = null;
    this.setTable(t);
    sfx.play("place", t.center);
    this.overview(900);
    this.h.onPlaced?.();
  }

  /* ------------------------------ your surfaces ------------------------------ */

  /** A surface from traced corners: drawn now, anchored on the next frame, and kept for next time. */
  private addSurface(pts: THREE.Vector3[]) {
    const plane = planeThrough(pts, this.head().pos);
    if (!plane) return;
    const c = this.makeCustom(`s${Date.now().toString(36)}`, plane.poly);
    c.plane = plane;
    c.wanted = true;
    this.placeCustom(c);
    sfx.play("place", new THREE.Vector3().setFromMatrixPosition(plane.m));
  }

  private makeCustom(id: string, poly: [number, number][]): Custom {
    const top = new Surface();
    top.setShape(poly);
    this.scene.add(top.mesh);
    const c: Custom = { id, plane: null, poly, top, anchor: null, uuid: null, wanted: false };
    this.customs.push(c);
    this.h.onSurfaces?.(this.customs.length);
    return c;
  }

  /** Draw a surface where its plane is, a hair out of it. */
  private placeCustom(c: Custom) {
    if (!c.plane) return;
    const n = new THREE.Vector3().setFromMatrixColumn(c.plane.m, 1);
    c.top.setMatrix(c.plane.m.clone().setPosition(new THREE.Vector3().setFromMatrixPosition(c.plane.m).addScaledVector(n, 0.002)));
  }

  /** Last session's surfaces, by their anchors: each comes back once the headset finds its anchor again. */
  private async restoreSurfaces(session: XRSession) {
    if (!session.restorePersistentAnchor) return;
    const saved = loadSurfaces();
    const kept: typeof saved = [];
    for (const sv of saved) {
      try {
        const a = await session.restorePersistentAnchor(sv.uuid);
        if (this.session !== session) return void a.delete();
        const c = this.makeCustom(sv.uuid, sv.poly);
        c.anchor = a;
        c.uuid = sv.uuid;
        kept.push(sv);
      } catch {
        // Gone with the room: forget it.
      }
    }
    if (kept.length !== saved.length) saveSurfaces(kept);
  }

  /** Each frame: anchor new surfaces, and follow their anchors (taking the panels on them along). */
  private trackSurfaces(frame: XRFrame, ref: XRReferenceSpace) {
    for (const c of this.customs) {
      if (c.wanted && c.plane) {
        c.wanted = false;
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        c.plane.m.decompose(p, q, new THREE.Vector3());
        void frame
          .createAnchor?.(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), ref)
          ?.then((a) => {
            if (this.mode !== "ar" || !this.customs.includes(c)) return a.delete();
            c.anchor = a;
            return a.requestPersistentHandle?.().then((uuid) => {
              c.uuid = uuid;
              saveSurfaces([...loadSurfaces().filter((x) => x.uuid !== uuid), { uuid, poly: c.poly }]);
            });
          })
          .catch(() => {});
      }
      const a = c.anchor;
      if (!a || !frame.trackedAnchors?.has(a)) continue;
      const pose = frame.getPose(a.anchorSpace, ref);
      if (!pose) continue;
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const was = c.plane ? new THREE.Vector3().setFromMatrixPosition(c.plane.m) : null;
      const at = new THREE.Vector3().setFromMatrixPosition(m);
      if (was && was.distanceToSquared(at) < 1e-6) continue;
      if (was) for (const [p, on] of this.stuck) if (on === c.id) p.mesh.position.add(at.clone().sub(was));
      const xs = c.poly.map((q) => q[0]);
      const zs = c.poly.map((q) => q[1]);
      c.plane = { m, poly: c.poly, halfX: (Math.max(...xs) - Math.min(...xs)) / 2, halfZ: (Math.max(...zs) - Math.min(...zs)) / 2 };
      this.placeCustom(c);
    }
  }

  /** Every surface of yours goes (the panels on them stay where they are, in the air). */
  clearSurfaces() {
    const session = this.session;
    for (const c of this.customs) {
      c.anchor?.delete();
      if (c.uuid && session?.deletePersistentAnchor) void session.deletePersistentAnchor(c.uuid).catch(() => {});
      this.scene.remove(c.top.mesh);
      c.top.mesh.geometry.dispose();
      for (const [p, on] of this.stuck) if (on === c.id) this.stuck.delete(p);
    }
    this.customs = [];
    saveSurfaces([]);
    this.h.onSurfaces?.(0);
  }

  /** This session's surfaces put away (the next session restores them). */
  private dropSurfaces() {
    for (const c of this.customs) {
      this.scene.remove(c.top.mesh);
      c.top.mesh.geometry.dispose();
    }
    if (this.customs.length) this.h.onSurfaces?.(0);
    this.customs = [];
  }

  /** Where a pointer marks a corner: between a hand's pinching fingertips, or the controller's tip. */
  private cornerAt(p: Pointer) {
    if (p.kind === "hand") return p.gest?.pinchPoint() ?? p.origin.clone();
    if (p.kind === "mouse") return p.origin.clone().addScaledVector(p.dir, 1);
    return p.origin.clone();
  }

  /** The outline so far, and a line from its last corner to where you'd put the next. */
  private drawOutline() {
    const pts = this.outline;
    if (!pts) return;
    const ptr = [...this.pointers.values()].filter((x) => x.kind !== "mouse" || this.mode === "flat");
    const p = ptr.find((x) => x.handedness === "right") ?? ptr[0];
    const all = p ? [...pts, this.cornerAt(p)] : pts;
    if (pts.length >= 2) all.push(pts[0]);
    const attr = this.outlineLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    const n = Math.min(all.length, attr.count);
    for (let i = 0; i < n; i++) attr.setXYZ(i, all[i].x, all[i].y, all[i].z);
    attr.needsUpdate = true;
    this.outlineLine.geometry.setDrawRange(0, n);
    this.outlineLine.visible = n >= 2;
  }

  /**
   * Where a table panel lies: flat on the table top, where a fingertip can
   * press it against the wood, with its top edge away from you so it reads.
   * The controls along the front edge, the shelf along the right, the saved
   * views along the left.
   */
  private tablePose(p: Panel, slot: Slot): { pos: THREE.Vector3; quat: THREE.Quaternion } {
    const t = this.table!;
    const quat = flatOn(t.toward.clone().negate());
    const pos = t.center.clone().addScaledVector(Y, LIFT);
    const front = Math.max(0, t.halfD - p.heightM / 2 - 0.03);
    const side = Math.max(0, t.halfW - p.widthM / 2 - 0.03);
    const back = Math.min(0.1, Math.max(0, t.halfD - p.heightM / 2 - 0.2));
    if (slot === "table") pos.addScaledVector(t.toward, front);
    else if (slot === "shelf") pos.addScaledVector(t.right, side).addScaledVector(t.toward, back);
    else pos.addScaledVector(t.right, -side).addScaledVector(t.toward, back);
    return { pos, quat };
  }

  /**
   * Where a carried panel would land if let go now: flat on the table when
   * it's held just over it (back on its own edge when it's near there), or
   * flush against a wall when it's held up to one. Null in the open air.
   */
  private snapFor(panel: Panel): Snap | null {
    const at = panel.mesh.position;
    const head = this.head().pos;
    let best: (Snap & { d: number }) | null = null;
    const t = this.table;
    if (t) {
      const rel = at.clone().sub(t.center);
      const up = rel.y;
      const x = rel.dot(t.right);
      const z = rel.dot(t.toward);
      if (up > -0.05 && up < SNAP_REACH + 0.1 && Math.abs(x) < t.halfW + 0.1 && Math.abs(z) < t.halfD + 0.1) {
        // Its own edge, if it's a table panel let go near there.
        const slot = this.slots.get(panel);
        const home = slot && TABLE_SLOTS.includes(slot) ? this.tablePose(panel, slot) : null;
        if (home && home.pos.distanceTo(at.clone().setY(home.pos.y)) < 0.15) best = { on: "table", ...home, d: Math.max(0, up) };
        else {
          // Square to the table, the top edge whichever of its sides faces most away from you.
          const away = at.clone().sub(head).setY(0).normalize();
          const axes = [t.toward, t.toward.clone().negate(), t.right, t.right.clone().negate()];
          const top = axes.reduce((a, b) => (b.dot(away) > a.dot(away) ? b : a));
          const clamp = (v: number, half: number, size: number) => THREE.MathUtils.clamp(v, -Math.max(0, half - size / 2), Math.max(0, half - size / 2));
          // Kept on the table: across its width and depth, whichever way round the panel lies.
          const sideways = Math.abs(top.dot(t.right)) > 0.5;
          const cx = clamp(x, t.halfW, sideways ? panel.heightM : panel.widthM);
          const cz = clamp(z, t.halfD, sideways ? panel.widthM : panel.heightM);
          const pos = t.center.clone().addScaledVector(t.right, cx).addScaledVector(t.toward, cz).addScaledVector(Y, LIFT);
          best = { on: "table", pos, quat: flatOn(top), d: Math.max(0, up) };
        }
      }
    }
    // Your own surfaces: flat on one when it's held just off it.
    for (const c of this.customs) {
      const pl = c.plane;
      if (!pl || this.mode !== "ar") continue;
      const x = new THREE.Vector3().setFromMatrixColumn(pl.m, 0);
      const n = new THREE.Vector3().setFromMatrixColumn(pl.m, 1);
      const z = new THREE.Vector3().setFromMatrixColumn(pl.m, 2);
      const rel = at.clone().sub(new THREE.Vector3().setFromMatrixPosition(pl.m));
      const d = rel.dot(n);
      if (d < -0.05 || d > SNAP_REACH || (best && Math.max(0, d) >= best.d)) continue;
      const lx = rel.dot(x);
      const lz = rel.dot(z);
      if (Math.abs(lx) > pl.halfX + 0.1 || Math.abs(lz) > pl.halfZ + 0.1) continue;
      // Its top edge: up, on an upright surface; away from you, on one lying down.
      const top = Math.abs(n.y) < 0.7 ? Y.clone().projectOnPlane(n).normalize() : at.clone().sub(head).projectOnPlane(n).normalize();
      const right = new THREE.Vector3().crossVectors(top, n).normalize();
      // Kept on it, whichever way round the panel lies on it.
      const across = Math.abs(right.dot(x)) > 0.5;
      const w = across ? panel.widthM : panel.heightM;
      const h = across ? panel.heightM : panel.widthM;
      const cx = THREE.MathUtils.clamp(lx, -Math.max(0, pl.halfX - w / 2), Math.max(0, pl.halfX - w / 2));
      const cz = THREE.MathUtils.clamp(lz, -Math.max(0, pl.halfZ - h / 2), Math.max(0, pl.halfZ - h / 2));
      const pos = new THREE.Vector3().setFromMatrixPosition(pl.m).addScaledVector(x, cx).addScaledVector(z, cz).addScaledVector(n, LIFT);
      const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, top, n));
      best = { on: c.id, pos, quat, d: Math.max(0, d) };
    }
    for (const w of this.walls) {
      const inv = w.m.clone().invert();
      const local = at.clone().applyMatrix4(inv);
      // A plane lies in its own x-z; its y is out of it.
      const d = Math.abs(local.y);
      if (d > SNAP_REACH || (best && d >= best.d)) continue;
      if (local.x < w.x0 - 0.1 || local.x > w.x1 + 0.1 || local.z < w.z0 - 0.1 || local.z > w.z1 + 0.1) continue;
      const normal = new THREE.Vector3(0, 1, 0).transformDirection(w.m);
      // Out of the wall on your side of it.
      const origin = new THREE.Vector3().setFromMatrixPosition(w.m);
      if (head.clone().sub(origin).dot(normal) < 0) normal.negate();
      normal.setY(0);
      if (normal.lengthSq() < 0.5) continue;
      normal.normalize();
      const onWall = new THREE.Vector3(THREE.MathUtils.clamp(local.x, w.x0, w.x1), 0, THREE.MathUtils.clamp(local.z, w.z0, w.z1)).applyMatrix4(w.m);
      // Keep the panel's height where you held it; only its depth snaps.
      const pos = at.clone().sub(normal.clone().multiplyScalar(at.clone().sub(onWall).dot(normal))).addScaledVector(normal, 0.006);
      const right = new THREE.Vector3().crossVectors(Y, normal).normalize();
      const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, Y, normal));
      best = { on: "wall", pos, quat, d };
    }
    return best;
  }

  /** The planes the headset knows about: the walls (vertical), with their extents, and the level surfaces (horizontal), with their outlines. */
  private findPlanes(frame: XRFrame, ref: XRReferenceSpace) {
    let planes: XRPlaneSet | undefined;
    try {
      planes = frame.detectedPlanes;
    } catch {
      return;
    }
    const walls: Wall[] = [];
    const flats: Flat[] = [];
    for (const plane of planes ?? []) {
      if (plane.polygon.length < 3) continue;
      const pose = frame.getPose(plane.planeSpace, ref);
      if (!pose) continue;
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const xs = plane.polygon.map((q) => q.x);
      const zs = plane.polygon.map((q) => q.z);
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      if (plane.orientation === "vertical") walls.push({ m, x0, x1, z0, z1 });
      else flats.push({ m, poly: plane.polygon.map((q) => [q.x, q.z]), sx: x1 - x0, sz: z1 - z0 });
    }
    this.walls = walls;
    this.flats = flats;
  }

  /** While a panel is carried: its landing spot outlined, and a tick when one comes into reach. */
  private showSnap(p: Pointer) {
    const snap = p.carry ? this.snapFor(p.carry.panel) : null;
    const key = snap ? snap.on : null;
    if (key !== this.snapWas) {
      this.snapWas = key;
      if (snap) {
        this.haptic(p, 0.25, 12);
        sfx.play("tick", snap.pos);
      }
    }
    if (!snap || !p.carry) return void (this.ghost.visible = false);
    this.ghost.position.copy(snap.pos);
    this.ghost.quaternion.copy(snap.quat);
    this.ghost.scale.set(p.carry.panel.widthM, p.carry.panel.heightM, 1);
    this.ghost.visible = true;
  }

  /** Where on the map a hit is, in the room, for a sound to come from. */
  private hitPoint(p: Pointer, hit: MapHit) {
    const id = this.map.bodyOf(hit);
    const at = id ? this.map.positionOf(id) : null;
    return at ? this.map.toWorld(at) : p.origin.clone().addScaledVector(p.dir, this.hitDistanceM(p, hit));
  }

  /** A hit's top folder (or module): its note. */
  private hitKey(hit: MapHit) {
    return hit.kind === "file" ? hit.id.split("/")[0] : `${hit.kind}:${hit.id}`;
  }

  /* --------------------------------- hands --------------------------------- */

  /**
   * Gestures past the pinch, for tracked hands: the thumb on the middle
   * finger (right: forward, left: back), the fingertip as a touch, the left
   * palm turned up for the wrist menu, and two Ls framing part of the map.
   */
  private readHands(now: number) {
    const hands = [...this.pointers.values()].filter((p) => p.kind === "hand" && p.hand && p.gest);
    for (const p of hands) {
      const { middlePinch } = p.gest!.update(p.hand!, now);
      if (middlePinch && !p.press) {
        sfx.play("back");
        this.h.onButton(p.handedness === "left" ? "back" : "forward");
      }
      this.poke(p);
    }
    this.updateWrist(hands);
    this.updateFraming(hands, now);
  }

  /** The index fingertip as a finger on a touchscreen: on a panel it presses; pointed at a body, a touch picks it. */
  private poke(p: Pointer) {
    const pose = p.gest?.pose;
    if (!pose || p.press || p.carry) return this.endPoke(p);
    const tip = pose.indexTip;
    let touched: { panel: Panel; x: number; y: number } | null = null;
    for (const panel of this.panels) {
      if (!panel.open || (panel === this.wrist && p.handedness === "left")) continue;
      panel.mesh.updateMatrixWorld();
      const local = panel.mesh.worldToLocal(tip.clone());
      // In front of the face by a centimetre counts as touching; once touching, a little more.
      // One lying on the table is pressed against it: the real top can sit a little off the
      // detected one, so it starts a touch higher and goes on through the wood.
      const flat = this.stuck.has(panel);
      const depth = p.poke?.panel === panel ? (flat ? 0.03 : 0.025) : flat ? 0.016 : 0.01;
      if (local.z > depth || local.z < (flat ? -0.07 : -0.04)) continue;
      if (Math.abs(local.x) > panel.widthM / 2 || Math.abs(local.y) > panel.heightM / 2) continue;
      touched = { panel, x: (local.x / panel.widthM + 0.5) * panel.W, y: (0.5 - local.y / panel.heightM) * panel.H };
      break;
    }
    const who = `${p.id}:poke`;
    const was = p.poke;
    if (was && was.panel !== touched?.panel) was.panel.pointer("up", was.x, was.y, who);
    if (touched) {
      if (was?.panel !== touched.panel) sfx.resume();
      touched.panel.pointer(was?.panel === touched.panel ? "move" : "down", touched.x, touched.y, who);
      p.poke = touched;
      p.pokeBody = null;
      return;
    }
    p.poke = null;

    // A body: only with a pointing finger (the others folded), so a hand passing through the map picks nothing.
    const pointing = pose.middleTip.distanceTo(pose.wrist) < 0.11 && pose.indexTip.distanceTo(pose.wrist) > 0.13;
    if (!pointing) return void (p.pokeBody = null);
    const k = 1 / this.map.root.getWorldScale(tmpV).x;
    const near = this.map.nearest(this.map.root.worldToLocal(tip.clone()), 0.025 * k);
    if (!near) return void (p.pokeBody = null);
    // Still on the last one (or only near something): wait for a fresh touch.
    if (p.pokeBody || near.gap > 0.008 * k) return;
    p.pokeBody = near.hit.id;
    sfx.play("pick", tip, this.hitKey(near.hit));
    this.h.onPick(near.hit);
  }

  private endPoke(p: Pointer) {
    if (p.poke) p.poke.panel.pointer("leave", 0, 0, `${p.id}:poke`);
    p.poke = null;
    p.pokeBody = null;
  }

  /** The left palm turned up: the wrist menu floats just above it, facing you. */
  private updateWrist(hands: Pointer[]) {
    const w = this.wrist;
    if (!w) return;
    const left = hands.find((p) => p.handedness === "left" && p.gest?.palmUp && p.gest.pose);
    if (!left) {
      if (w.open) this.hide(w);
      return;
    }
    const pose = left.gest!.pose!;
    if (!w.open) {
      w.mesh.visible = true;
      w.invalidate();
    }
    w.mesh.position.copy(pose.palmCenter).addScaledVector(pose.palmNormal, 0.08);
    w.mesh.lookAt(this.head().pos);
  }

  /**
   * Both hands in an L, apart: a frame between them. Held a moment, it picks
   * what's inside; framing nothing, or nearly everything, is the whole map.
   */
  private updateFraming(hands: Pointer[], now: number) {
    const l = hands.find((p) => p.handedness === "left");
    const r = hands.find((p) => p.handedness === "right");
    const a = l?.gest?.ell && !l.press ? l.gest.ellPoints() : null;
    const b = r?.gest?.ell && !r.press ? r.gest.ellPoints() : null;
    if (!a || !b || a.corner.distanceTo(b.corner) < 0.12) {
      if (this.framing.since && ![...this.pointers.values()].some((p) => p.press?.kind === "lasso")) this.lasso.visible = false;
      this.framing = { since: 0, fired: false };
      return;
    }
    this.framing.since ||= now;
    if (this.framing.fired) return;
    const rect = this.frameRect(a, b);
    this.drawLine(rect, true);
    if (now - this.framing.since < 350) return;
    this.framing.fired = true;
    this.lasso.visible = false;
    const paths = this.within(rect);
    if (!paths.length || paths.length >= this.map.files().length * 0.85) this.h.onButton("overview");
    else {
      sfx.play("focus");
      this.h.onSelect?.(paths, "frame");
    }
  }

  /**
   * The rectangle two Ls span, as you see it: upright, square to your view, at
   * their depth, its edges through both corners. Worked out in your view, as
   * directions from your eye, so it lines up with your hands whatever their
   * depths. Along each axis, fingers pointing at each other across the gap (the
   * usual diagonal frame) leave the corners as its two sides; corners held
   * level, or one above the other, with the fingers both pointing the same way,
   * would make a sliver, so its far side is where those fingertips reach.
   */
  private frameRect(a: Ell, b: Ell) {
    const cam = this.eye();
    const view = cam.matrixWorld.clone().invert();
    const see = (w: THREE.Vector3) => {
      const v = w.clone().applyMatrix4(view);
      const d = Math.max(0.01, -v.z);
      return { x: v.x / d, y: v.y / d, d };
    };
    const ells = [a, b].map((e) => {
      const c = see(e.corner);
      const arms = [see(e.index), see(e.thumb)].map((t) => ({ x: t.x - c.x, y: t.y - c.y }));
      // Along each axis, how far (and which way) the finger running most that way reaches.
      const reach = (k: "x" | "y") => arms.reduce((m, arm) => (Math.abs(arm[k]) > Math.abs(m) ? arm[k] : m), 0);
      return { c, reach: { x: reach("x"), y: reach("y") } };
    });
    const span = (k: "x" | "y") => {
      const [p, q] = ells[0].c[k] <= ells[1].c[k] ? ells : [ells[1], ells[0]];
      const lo = p.c[k];
      const hi = q.c[k];
      const tips = (p.c[k] + p.reach[k] + q.c[k] + q.reach[k]) / 2;
      if (p.reach[k] > 0 && q.reach[k] > 0) return [lo, Math.max(hi, tips)];
      if (p.reach[k] < 0 && q.reach[k] < 0) return [Math.min(lo, tips), hi];
      return [lo, hi];
    };
    const [x0, x1] = span("x");
    const [y0, y1] = span("y");
    const d = Math.max(0.1, (ells[0].c.d + ells[1].c.d) / 2);
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map(([x, y]) => new THREE.Vector3(x * d, y * d, -d).applyMatrix4(cam.matrixWorld));
  }

  private eye() {
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    cam.updateMatrixWorld();
    return cam;
  }

  /** The files whose bodies sit inside a loop drawn in the air, as seen from your eyes. */
  private within(loop: THREE.Vector3[]) {
    const cam = this.eye();
    const view = cam.matrixWorld.clone().invert();
    const proj = (w: THREE.Vector3): [number, number] | null => {
      const v = w.applyMatrix4(view);
      return v.z < -0.01 ? [v.x / -v.z, v.y / -v.z] : null;
    };
    const poly = loop.map((p) => proj(p.clone())).filter((q): q is [number, number] => !!q);
    if (poly.length < 3) return [];
    this.map.root.updateWorldMatrix(true, false);
    const m = this.map.root.matrixWorld;
    const out: string[] = [];
    for (const id of this.map.files()) {
      const at = this.map.positionOf(id);
      const q = at && proj(at.applyMatrix4(m));
      if (q && inside(q[0], q[1], poly)) out.push(id);
    }
    return out;
  }

  /** The lasso's line (closed, for a frame). */
  private drawLine(pts: THREE.Vector3[], closed: boolean) {
    const attr = this.lasso.geometry.getAttribute("position") as THREE.BufferAttribute;
    const n = Math.min(pts.length, 511);
    for (let i = 0; i < n; i++) attr.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
    const ring = closed && n > 2;
    if (ring) attr.setXYZ(n, pts[0].x, pts[0].y, pts[0].z);
    attr.needsUpdate = true;
    this.lasso.geometry.setDrawRange(0, ring ? n + 1 : n);
    this.lasso.visible = n > 1;
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
    this.readHands(now);
    this.keyFlight(dt);

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
      const tr = p.carry.trail;
      tr.push({ t: now, at: p.carry.panel.mesh.position.clone() });
      while (tr.length > 2 && now - tr[0].t > 200) tr.shift();
    }
    const carrier = [...this.pointers.values()].find((p) => p.carry);
    if (carrier) this.showSnap(carrier);
    else this.ghost.visible = false;
    if (this.mode !== "flat") sfx.listen(head.pos, head.quat, now);

    // The dock can follow lazily (a setting): it only turns with you once you've looked well away.
    for (const [panel, slot] of this.slots) {
      if (!this.settings.dockFollows || slot !== "dock" || !panel.open || this.stuck.has(panel) || this.pointers.size === 0 || [...this.pointers.values()].some((p) => p.carry?.panel === panel)) continue;
      let d = head.yaw - this.dockYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > 0.6) this.place(panel, "dock");
    }

    // The table: its anchor followed, and its edges found.
    if (xrFrame && this.mode === "ar") this.trackTable(xrFrame);
    if (xrFrame) this.placeResting(xrFrame);
    this.drawOutline();

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
    this.sortPanels(eyeLocal, now);

    this.h.onFrame?.();
    for (const panel of this.panels) panel.render();
    for (const [panel, h] of this.handles) {
      const hot = [...this.pointers.values()].some((p) => p.hoverHandle === panel || p.carry?.panel === panel);
      h.material.opacity = hot ? 1 : 0.55;
      // Under the panel, however tall it has grown.
      h.position.y = -panel.heightM / 2 - 0.028;
    }
    this.applyRoom();
    this.draw(target);
  };

  /**
   * Which open panels the map stands in front of. One goes behind the map
   * once a few of the lit bodies over it are nearer you than it is, and comes
   * back in front once (almost) none are, so one body passing by doesn't make
   * it flicker. A panel in your hand is always in front: you're using it.
   * Worked in the map's own space, where the bodies are.
   */
  private sortPanels(eye: THREE.Vector3, now: number) {
    if (now - this.sortedAt < 150) return;
    this.sortedAt = now;
    const toMap = new THREE.Matrix4().copy(this.map.root.matrixWorld).invert();
    const held = new Set([...this.pointers.values()].map((o) => o.carry?.panel));
    const m = new THREE.Matrix4();
    const c = new THREE.Vector3();
    const r = new THREE.Vector3();
    const u = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const p of this.panels) {
      let back = false;
      if (p.open && !held.has(p)) {
        p.mesh.updateMatrixWorld();
        m.multiplyMatrices(toMap, p.mesh.matrixWorld);
        c.setFromMatrixPosition(m);
        // The panel's own axes, a metre long in its own units.
        r.setFromMatrixColumn(m, 0);
        u.setFromMatrixColumn(m, 1);
        n.crossVectors(r, u);
        const r2 = r.lengthSq();
        const u2 = u.lengthSq();
        const hw = p.widthM / 2;
        const hh = p.heightM / 2;
        const cn = (c.x - eye.x) * n.x + (c.y - eye.y) * n.y + (c.z - eye.z) * n.z;
        let over = 0;
        let nearer = 0;
        this.map.litBodies((x, y, z) => {
          const bx = x - eye.x, by = y - eye.y, bz = z - eye.z;
          const bn = bx * n.x + by * n.y + bz * n.z;
          // Where the line from your eye to the body crosses the panel's plane: t of the way there.
          const t = cn / bn;
          if (!(t > 0) || !Number.isFinite(t)) return;
          const px = eye.x + bx * t - c.x, py = eye.y + by * t - c.y, pz = eye.z + bz * t - c.z;
          if (Math.abs((px * r.x + py * r.y + pz * r.z) / r2) > hw || Math.abs((px * u.x + py * u.y + pz * u.z) / u2) > hh) return;
          over++;
          // Past the body before reaching the panel: the body is nearer.
          if (t > 1) nearer++;
        });
        back = this.behind.has(p) ? nearer > Math.max(1, over * 0.05) : nearer >= Math.max(3, over * 0.1);
      }
      if (back === this.behind.has(p)) continue;
      if (back) this.behind.add(p);
      else this.behind.delete(p);
      (back ? this.under : this.hud).add(p.mesh);
    }
  }

  /** The room (sky, floor, table) without the map, or the map without the room. */
  private only(part: "room" | "map") {
    const room = part === "room";
    this.world.visible = !room;
    for (const o of [this.backdrop, this.floor, this.surface.mesh, this.stars]) o.userData.shown ??= o.visible;
    for (const o of [this.backdrop, this.floor, this.surface.mesh, this.stars]) o.visible = room && (o.userData.shown as boolean);
    this.scene.background = room ? this.sky : null;
  }

  /** Back to the whole scene, as the rest of the engine knows it. */
  private whole() {
    this.world.visible = true;
    for (const o of [this.backdrop, this.floor, this.surface.mesh, this.stars]) {
      o.visible = o.userData.shown as boolean;
      delete o.userData.shown;
    }
    this.scene.background = this.sky;
  }

  /**
   * In order: the room, the panels the map is in front of, the map (bloomed,
   * if bloom is on) over them, and the overlay (the rest of the panels,
   * hands, rays) over everything.
   */
  private draw(target: THREE.WebGLRenderTarget | null) {
    const tu = this.map.tuning;
    const bloom = this.settings.bloom && !!tu && tu.bloomStrength > 0;
    this.map.setGlow(this.settings.bodyGlow, bloom);
    const r = this.renderer;
    this.sky = this.scene.background;
    const under = () => {
      r.setRenderTarget(target);
      this.only("room");
      r.render(this.scene, this.camera);
      r.autoClear = false;
      if (this.under.children.length) r.render(this.under, this.camera);
      this.only("map");
    };
    const over = () => {
      r.setRenderTarget(target);
      r.autoClear = false;
      r.clearDepth();
      r.render(this.overlay, this.camera);
      r.autoClear = true;
    };
    if (bloom) {
      this.bloom ??= new Bloom(r);
      this.only("map");
      this.bloom.render(r, this.scene, this.camera, target, { strength: tu.bloomStrength, radius: tu.bloomRadius, threshold: tu.bloomThreshold }, under);
    } else {
      under();
      r.render(this.scene, this.camera);
    }
    this.whole();
    over();
  }

  /**
   * A trigger held on the map. Held still, it's a pick (on release). Moved,
   * it drags the body it's on (the desktop's "Drag bodies"), or with that
   * knob off, moves the whole map as on open sky.
   */
  private updatePress(p: Pointer) {
    const press = p.press;
    // A pinch held still on open sky, the only hand on the map: it becomes a lasso.
    if (press?.kind === "grab" && press.t0 && !press.moved && performance.now() - press.t0 > LASSO_HOLD && this.grabs.length === 1 && this.grabs[0].p === p) {
      const s0 = this.grabStart;
      this.endGrab(p);
      // The hand's tremble while holding still moved the map a little: put it back.
      if (s0) this.world.position.copy(s0.pos);
      p.press = { kind: "lasso", pts: [] };
    }
    if (p.press?.kind === "lasso") {
      const at = p.gest?.pinchPoint() ?? p.origin.clone();
      const pts = p.press.pts;
      if (!pts.length || pts.at(-1)!.distanceTo(at) > 0.004) {
        if (pts.length < 511) pts.push(at);
        this.drawLine(pts, true);
      }
      return;
    }
    if (press?.kind === "map") {
      const moved = p.kind === "mouse" ? this.mouse.moved : press.from.distanceTo(p.origin.clone().add(p.dir)) > 0.035;
      if (!moved) return;
      const id = this.map.tuning?.dragBodies ? this.map.bodyOf(press.hit) : null;
      const at = id ? this.map.positionOf(id) : null;
      if (id && at) {
        // Hold it where it is along the ray; from here on it rides the ray.
        const w = this.map.toWorld(at);
        sfx.play("grab", w);
        p.press = { kind: "body", id, dist: Math.max(0.05, w.clone().sub(p.origin).dot(p.dir)), hit: press.hit, trail: [], pin: false };
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

    // Panels first, even one a body hides part of: pointing at a panel means using it.
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
    if (!panelHit && !p.hoverHandle && !p.carry && !(p.press?.kind === "grab" && this.grabs.length) && p.press?.kind !== "body" && p.press?.kind !== "lasso") mapHit = this.map.pick(p.origin, p.dir);
    const hoverKey = (h: MapHit | null) => (h ? `${h.kind}:${h.id}` : null);
    if (hoverKey(mapHit) !== hoverKey(p.hoverMap) && mapHit) {
      if (p.lastHapticId !== hoverKey(mapHit)) {
        this.haptic(p, 0.12, 8);
        sfx.play("hover", this.hitPoint(p, mapHit), this.hitKey(mapHit));
      }
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

  /**
   * The arrow keys fly (Shift for faster), Page Up/Down rise and sink. In the
   * headset (a Bluetooth keyboard) WASD and Q / E do too, as on the desktop.
   */
  private keyFlight(dt: number) {
    const k = this.mouse.keys;
    if (!k.size) return;
    const xr = this.renderer.xr.isPresenting;
    const on = (key: string, letter: string) => k.has(key) || (xr && k.has(letter));
    const v = new THREE.Vector3(
      (on("arrowright", "d") ? 1 : 0) - (on("arrowleft", "a") ? 1 : 0),
      (on("pageup", "e") ? 1 : 0) - (on("pagedown", "q") ? 1 : 0),
      (on("arrowdown", "s") ? 1 : 0) - (on("arrowup", "w") ? 1 : 0),
    );
    if (!v.lengthSq()) return;
    this.touched();
    const fast = k.has("shift") ? 3 : 1;
    if (!xr) return void this.world.position.sub(v.multiplyScalar(1.2 * dt * fast).applyQuaternion(this.camera.quaternion));
    // Level, the way you're facing, at the left stick's speed and with its settings.
    const move = v.multiplyScalar(1.4 * this.settings.flySpeed * fast * dt).applyAxisAngle(Y, this.head().yaw);
    if (this.settings.stickMovesMap) this.world.position.add(move);
    else this.world.position.sub(move);
  }
}

/** How far over the table top a panel lies on it: enough not to flicker into it. */
const LIFT = 0.004;

/** Lying flat, face up, its top edge pointing `top` (level). */
function flatOn(top: THREE.Vector3) {
  const up = top.clone().setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(up, Y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, Y));
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
