import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import { colorOf, nameOf, type Board, type ItemKind, type Vec3 } from "../../shared/board";
import { actionById } from "../../shared/boardActions";
import type { BoardPreset } from "../../shared/boardTune";
import { HandGestures } from "../xr/hands";
import { sfx } from "../xr/sound";
import { makeRay, type RayLine } from "../xr/ui";
import type { Ctl } from "./ctl";
import { Callout, Captions, Dock, HoloPanel, Palette, TunePanel, faceHead, headFrame, type PaletteExtras } from "./hud";
import { LOOK } from "./look";
import { magnet } from "./magnet";
import type { BoardScene } from "./scene";
import { num, on, onTune, pick, setTune } from "./tune";
import { Hints, Toast, Wheel } from "./wheel";

/**
 * Hands and controllers in the workshop.
 *
 *  - Point and pinch (or pull the trigger): on an item, select it, and keep
 *    holding to drag it along the ray (the stick pushes it away or pulls it
 *    in, and turns it); a pinch held still on it talks about it. On open table,
 *    hold to move the table, tap to clear the selection.
 *  - Grab (grip, or a pinch right on it): carry an item in your hand. Throw
 *    it away to delete it; close your fist on it (or pull the trigger while
 *    gripping) to crumple it.
 *  - Both hands on one item: stretch it, pull a hologram apart, or (spread
 *    wide) dive inside it. The other hand's trigger or middle pinch swaps
 *    which.
 *  - Tools: connect (pull, or draw, a link from one item to another), ink
 *    (draw in the air), lasso and eraser (sweep the ray across items).
 *  - Panels: point and pinch, or poke them with a fingertip. Pinch (or grip)
 *    a title bar to carry one.
 *
 * Buttons and the wheel are Tune knobs (Headset · Controller buttons): a tap
 * and a held press each run an action; holding the right stick in opens the
 * command wheel around the controller. An upturned palm opens it too.
 */

type Press =
  | { kind: "panel"; panel: HoloPanel }
  | { kind: "move"; panel: HoloPanel; dist: number; trail: { t: number; at: THREE.Vector3 }[] }
  | { kind: "ray"; id: string; dist: number; offset: THREE.Vector3; moved: boolean; at0: THREE.Vector3; t0: number; talked: boolean; yaw: number; rot0: number }
  | { kind: "empty"; at0: THREE.Vector3 }
  | { kind: "pull"; from: string; path: THREE.Vector3[] }
  | { kind: "ink"; pts: THREE.Vector3[] }
  | { kind: "sweep"; erase: boolean; ids: string[] };

/** `locked`: taken while items are locked, so it's only borrowed: let go, it springs back. */
type Carry = { id: string; offset: THREE.Matrix4; trail: { t: number; at: THREE.Vector3 }[]; yaw: number; fistSince: number; locked: boolean };

export type Pointer = {
  i: number;
  ray: THREE.Group;
  grip: THREE.Group;
  hand: THREE.XRHandSpace;
  line: RayLine;
  dot: THREE.Mesh;
  source: XRInputSource | null;
  side: "left" | "right" | "none";
  gest: HandGestures;
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  hoverPanel: { panel: HoloPanel; x: number; y: number } | null;
  hoverItem: string | null;
  press: Press | null;
  carry: Carry | null;
  /** Holding open air: moving the table. */
  grabbing: boolean;
  buttons: boolean[];
  /** When each button went down, and whether its held action already ran. */
  downAt: number[];
  heldFired: boolean[];
  /** A fingertip on a panel. */
  poke: { panel: HoloPanel; down: boolean } | null;
  snapLatch: boolean;
  /** The thumbstick is tilted (moving or turning something). */
  tilted?: boolean;
  lastSnap: string;
  /** A pinch or grab that began while typing: its end is ignored too. */
  hushed?: boolean;
};

/** What other parts of the headset (the room, the shelf, history, snapshots, gestures) plug in. */
export interface XRPlugin {
  /** Panels the hands can point at. */
  panels?(): HoloPanel[];
  frame?(dt: number, now: number): void;
  /** An action it carries out; true when it did. */
  handle?(action: string, p?: Pointer): boolean;
  /** A press it takes before the board does; true when it did. */
  press?(p: Pointer, kind: "select" | "squeeze"): boolean;
  release?(p: Pointer, kind: "select" | "squeeze"): boolean;
  /** An item thrown (world space): true when it caught it (stuck to a wall, say). */
  throwItem?(id: string, at: THREE.Vector3, vel: THREE.Vector3): boolean;
  throwPanel?(panel: HoloPanel, at: THREE.Vector3, vel: THREE.Vector3): boolean;
  /** The connect tool let go somewhere off this board: true when it made a link there. */
  linkAcross?(from: string, origin: THREE.Vector3, dir: THREE.Vector3): boolean;
  entered?(): void;
  left?(): void;
  dispose?(): void;
  /** Any action run (a button, the wheel, a key, a gesture): for the guide to notice. */
  acted?(id: string): void;
}

/** A panel that floats in front of you: where it sits beside your gaze, and whether it's drifting after you now. */
type Float = { panel: HoloPanel; side: number; following: boolean };

type Two = { id: string; d0: number; scale0: number; explode0: number; mode: "scale" | "explode" | "open"; holo: boolean; k: number };

const BUTTONS: Record<"left" | "right", Record<number, [string, string | null]>> = {
  right: { 4: ["btnA", "btnAHold"], 5: ["btnB", "btnBHold"], 3: ["btnRStick", null] },
  left: { 4: ["btnX", "btnXHold"], 5: ["btnY", "btnYHold"], 3: ["btnLStick", null] },
};

export class XRInput {
  readonly ptrs: Pointer[] = [];
  private dock: Dock;
  private palette: Palette;
  private tune: TunePanel;
  private callout: Callout;
  private captions: Captions;
  private wheel: Wheel;
  /** Who opened the wheel: a controller's stick (tilt to choose), a palm, or a button (point to choose). */
  private wheelBy: { p: Pointer; via: "stick" | "palm" | "button"; btn: number } | null = null;
  private toast = new Toast();
  private twoTag = new Toast();
  private hints: Record<"left" | "right", Hints> = { left: new Hints("left"), right: new Hints("right") };
  private floats: Float[];
  private panels: HoloPanel[];
  readonly plugins: XRPlugin[] = [];
  private leader: THREE.Line;
  private boardGrab: { a: THREE.Vector3; b: THREE.Vector3 | null; pos: THREE.Vector3; yaw: number; scale: number; mid: THREE.Vector3 } | null = null;
  /** Whether two hands on open air turn the table (not on a wall). */
  boardTurns = true;
  private two: Two | null = null;
  private dockShown = 0;
  private captionAt = new THREE.Vector3();
  private lastAnswer: { text: string; at: number } | null = null;
  private off: () => void;
  private offTune: () => void;
  private beltKey = "";
  private dirtyRig = false;

  /** The table is being moved by hand or by stick right now: its anchor lets go of it meanwhile. */
  get movingTable() {
    return this.dirtyRig || this.ptrs.some((q) => q.grabbing);
  }

  constructor(
    readonly scene: BoardScene,
    readonly ctl: Ctl,
    private activity: () => Board["activity"],
    o: { extras: () => PaletteExtras; presets: () => BoardPreset[]; onPreset: (p: BoardPreset) => void },
  ) {
    this.palette = new Palette(ctl, (k) => this.spawn(k), o.extras);
    this.tune = new TunePanel(o.onPreset);
    this.dock = new Dock(ctl, {
      palette: () => this.toggle(this.palette),
      tune: () => this.toggle(this.tune),
      recenter: () => scene.resetRig(),
      exit: () => scene.exit(),
      passthrough: () => (scene.mode !== "ar" ? null : scene.covered ? "off" : "on"),
      isOpen: (n) => (n === "palette" ? this.palette.mesh.visible : this.tune.mesh.visible),
      run: (a) => this.act(a),
    });
    this.callout = new Callout(ctl);
    this.captions = new Captions();
    this.wheel = new Wheel((a) => {
      const by = this.wheelBy;
      this.closeWheel();
      this.act(a, by?.p);
    });
    this.palette.onClose = () => this.close(this.palette);
    this.tune.onClose = () => this.close(this.tune);
    this.floats = [
      { panel: this.palette, side: -0.17, following: false },
      { panel: this.tune, side: 0.2, following: false },
    ];
    this.panels = [this.dock, this.palette, this.tune, this.callout, this.wheel];
    for (const p of [...this.panels, this.captions, this.toast, this.twoTag, this.hints.left, this.hints.right]) {
      p.mesh.material.opacity = 1;
      scene.overlay.add(p.mesh);
    }
    this.toast.mesh.renderOrder = 40;
    this.twoTag.mesh.renderOrder = 40;
    this.leader = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: LOOK.cyan, transparent: true, opacity: 0.7, depthTest: false, toneMapped: false }),
    );
    this.leader.frustumCulled = false;
    this.leader.renderOrder = 9;
    this.leader.visible = false;
    scene.overlay.add(this.leader);
    this.tune.presets = o.presets();
    this.setup();
    this.off = scene.onFrame((t, dt) => this.frame(t, dt));
    // Each item printed in, heard where it appears: big ones low, small ones high.
    scene.onItemBorn = (v) => {
      if (scene.mode !== "flat") sfx.play("materialise", v.center(), v.id, this.sizeOf(v.id));
    };
    const sound = () =>
      sfx.configure({ sfx: on("sfx"), sfxVolume: num("sfxVolume"), ambience: on("ambience"), ambienceVolume: num("ambienceVolume"), hum: on("hum"), humVolume: num("humVolume"), pitchBySize: on("pitchBySize"), rich: on("richSfx") });
    sound();
    this.offTune = onTune(() => {
      sound();
      this.tune.presets = o.presets();
      for (const p of this.panels) p.invalidate();
    });
  }

  dispose() {
    this.off();
    this.offTune();
    for (const pl of this.plugins) pl.dispose?.();
  }

  setPresets(p: BoardPreset[]) {
    this.tune.presets = p;
    this.tune.invalidate();
  }

  /** The hands (or controllers) and where their rays land, for the other screens on the board (world space). */
  presenceHands(): { at: THREE.Vector3; to?: THREE.Vector3 }[] {
    return this.ptrs.filter((p) => p.source).map((p) => ({ at: this.tip(p), to: p.dot.visible ? p.dot.position.clone() : undefined }));
  }

  /** A session started: nothing in your way; the dock is on your wrist. */
  entered() {
    for (const p of this.panels) p.mesh.visible = false;
    this.captions.mesh.visible = false;
    this.captionAt.set(0, 0, 0);
    sfx.play("enter");
    for (const pl of this.plugins) pl.entered?.();
  }

  left() {
    for (const p of [...this.panels, this.captions, this.toast, this.twoTag, this.hints.left, this.hints.right]) p.mesh.visible = false;
    this.leader.visible = false;
    for (const pl of this.plugins) pl.left?.();
  }

  /* ------------------------------- actions ------------------------------- */

  /** Run an action from a button, the wheel, a gesture: said by the hand that did it. */
  act(id: string, p?: Pointer | null) {
    if (!id || id === "none") return;
    for (const pl of this.plugins) pl.acted?.(id);
    const label = actionById(id)?.label ?? id;
    if (on("actionToasts") && id !== "wheel") this.say(label, p ?? undefined);
    this.ctl.run?.(id, "button");
  }

  /** The headset's own actions (the page asks here first); true when done here. */
  handle(id: string, p?: Pointer): boolean {
    for (const pl of this.plugins) if (pl.handle?.(id, p)) return true;
    switch (id) {
      case "palette":
        this.toggle(this.palette);
        return true;
      case "tune":
        this.toggle(this.tune);
        return true;
      case "wheel": {
        const by = p ?? this.ptrs.find((q) => q.side === "right" && q.source) ?? this.ptrs.find((q) => q.source);
        if (this.wheel.mesh.visible) this.closeWheel();
        else if (by) this.openWheel(by, "button", -1);
        return true;
      }
      case "recenter":
        this.scene.resetRig();
        return true;
      case "dock": {
        const show = !on("wristMenu");
        setTune({ wristMenu: show });
        this.say(show ? "Left-hand menu on" : "Left-hand menu off · left stick click brings it back", p);
        sfx.play(show ? "pick" : "back");
        return true;
      }
      case "lock": {
        const lock = !on("lockItems");
        setTune({ lockItems: lock });
        if (lock) this.ctl.select([]);
        this.say(lock ? "Items locked · grab one, it springs back" : "Items unlocked", p);
        sfx.play(lock ? "snap" : "pick");
        this.dock.invalidate();
        return true;
      }
      case "passthrough":
        if (this.scene.mode !== "ar") {
          this.say("Passthrough: leave and enter with Passthrough", p);
          return true;
        }
        this.scene.setCovered(!this.scene.covered);
        this.say(this.scene.covered ? "Passthrough off" : "Passthrough on", p);
        return true;
      case "exit":
        this.scene.exit();
        return true;
      case "two-hand-mode": {
        const order = ["auto", "scale", "explode"];
        const next = order[(order.indexOf(pick("twoHandMode")) + 1) % order.length];
        setTune({ twoHandMode: next });
        this.say(`Two hands: ${next}`, p);
        return true;
      }
    }
    return false;
  }

  /** A chip of light by a hand (or before you), saying what happened. */
  say(text: string, p?: Pointer) {
    const cam = this.scene.renderer.xr.getCamera();
    const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const at = p?.source ? this.tip(p).add(new THREE.Vector3(0, 0.07, 0)) : head.clone().add(new THREE.Vector3(0, -0.15, -0.5).applyQuaternion(cam.quaternion));
    this.toast.show(text, at, head);
  }

  /* ------------------------------- panels -------------------------------- */

  private toggle(p: HoloPanel) {
    if (p.mesh.visible) this.close(p);
    else this.open(p);
  }

  private open(p: HoloPanel) {
    const f = this.floats.find((x) => x.panel === p);
    p.mesh.visible = true;
    p.pinned = false;
    p.invalidate();
    if (f) this.placeFloat(f, true);
    sfx.play("pick");
  }

  private close(p: HoloPanel) {
    p.mesh.visible = false;
    sfx.play("back");
  }

  private openWheel(p: Pointer, via: "stick" | "palm" | "button", btn: number) {
    this.wheel.refresh();
    this.wheel.setHot(-1);
    this.wheelBy = { p, via, btn };
    this.wheel.mesh.visible = true;
    this.placeWheel();
    sfx.play("wheel");
    this.haptic(p, 0.3, 20);
  }

  private closeWheel() {
    this.wheelBy = null;
    this.wheel.mesh.visible = false;
    this.wheel.setHot(-1);
  }

  /** The wheel: over the controller that opened it, or blooming from the palm. */
  private placeWheel() {
    const by = this.wheelBy;
    if (!by) return;
    const cam = this.scene.renderer.xr.getCamera();
    const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    let at: THREE.Vector3;
    if (by.via === "palm" && by.p.gest.pose) at = by.p.gest.pose.palmCenter.clone().add(new THREE.Vector3(0, 0.13, 0));
    else if (by.via === "button") {
      if (this.wheel.mesh.userData.placed) return;
      at = this.tip(by.p).lerp(head, 0.25).add(new THREE.Vector3(0, 0.08, 0));
      this.wheel.mesh.userData.placed = true;
    } else {
      by.p.grip.updateMatrixWorld();
      at = new THREE.Vector3().setFromMatrixPosition(by.p.grip.matrixWorld).add(new THREE.Vector3(0, 0.1, 0));
    }
    if (by.via !== "button") this.wheel.mesh.userData.placed = false;
    this.wheel.mesh.position.lerp(at, this.wheel.mesh.userData.was ? 0.5 : 1);
    this.wheel.mesh.userData.was = true;
    this.wheel.mesh.lookAt(head);
  }

  /** Where a floating panel wants to be: low in front of you, to one side. */
  private floatGoal(f: Float) {
    const cam = this.scene.renderer.xr.getCamera();
    const { head, fwd, right } = headFrame(cam);
    const s = num("panelScale");
    return head
      .clone()
      .addScaledVector(fwd, num("panelDistance"))
      .addScaledVector(right, f.side * s)
      .add(new THREE.Vector3(0, -num("panelDrop"), 0));
  }

  private placeFloat(f: Float, now = false) {
    const goal = this.floatGoal(f);
    const m = f.panel.mesh;
    if (now) m.position.copy(goal);
    faceHead(m, new THREE.Vector3().setFromMatrixPosition(this.scene.renderer.xr.getCamera().matrixWorld));
  }

  /** Every panel a hand can point at, the plugins' too. */
  private allPanels(): HoloPanel[] {
    return [...this.panels, ...this.plugins.flatMap((pl) => pl.panels?.() ?? [])];
  }

  private updatePanels(dt: number) {
    const cam = this.scene.renderer.xr.getCamera();
    const { head, fwd, right } = headFrame(cam);
    const s = num("panelScale");
    for (const p of [...this.panels, this.captions]) p.mesh.scale.setScalar(s);

    // Floating panels drift after you once you've turned well away, then stop: never jittering at your every move.
    for (const f of this.floats) {
      const m = f.panel.mesh;
      if (!m.visible || f.panel.pinned || !on("panelFollow")) continue;
      const goal = this.floatGoal(f);
      const to = m.position.clone().sub(head).setY(0).normalize();
      const off = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(to.dot(fwd), -1, 1)));
      if (!f.following && (off > 38 || m.position.distanceTo(goal) > 0.4)) f.following = true;
      if (f.following) {
        m.position.lerp(goal, 1 - Math.exp(-dt * num("followSpeed")));
        faceHead(m, head);
        if (m.position.distanceTo(goal) < 0.015) f.following = false;
      }
    }

    // The callout stands beside the selected item, with a line of light back to it.
    const sel = this.ctl.selected();
    this.callout.set(this.ctl.client.board, sel);
    const v = sel.length === 1 ? this.scene.views.get(sel[0]) : null;
    if (sel.length) {
      this.callout.mesh.visible = true;
      let goal: THREE.Vector3;
      if (v && on("callout")) {
        const c = v.center();
        const r = v.radius * v.root.scale.x * this.scene.rig.scale.x;
        const toHead = head.clone().sub(c).setY(0).normalize();
        const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), toHead).normalize();
        goal = c.clone().addScaledVector(side, r + 0.17 * s).addScaledVector(toHead, 0.06).add(new THREE.Vector3(0, 0.06, 0));
        // Never further than arm's reach: nearer you when the item's far away.
        const d = goal.distanceTo(head);
        if (d > 0.85) goal = head.clone().lerp(goal, 0.85 / d);
      } else goal = head.clone().addScaledVector(fwd, num("panelDistance")).addScaledVector(right, 0.24 * s).add(new THREE.Vector3(0, -num("panelDrop"), 0));
      const m = this.callout.mesh;
      if (m.userData.fresh !== sel.join()) {
        m.userData.fresh = sel.join();
        m.position.copy(goal);
      } else m.position.lerp(goal, 1 - Math.exp(-dt * 6));
      faceHead(m, head);
      if (v && on("callout")) {
        const edge = m.localToWorld(new THREE.Vector3(-this.callout.widthM / 2, 0, 0));
        const c = v.center();
        const knee = edge.clone().lerp(c, 0.25);
        knee.y = edge.y;
        const pos = this.leader.geometry.getAttribute("position") as THREE.BufferAttribute;
        pos.setXYZ(0, c.x, c.y, c.z);
        pos.setXYZ(1, knee.x, knee.y, knee.z);
        pos.setXYZ(2, edge.x, edge.y, edge.z);
        pos.needsUpdate = true;
        this.leader.visible = true;
      } else this.leader.visible = false;
    } else {
      this.callout.mesh.visible = false;
      this.leader.visible = false;
    }

    // The dock: on the left wrist, when the palm's turned toward you (a hand), or above the left controller.
    const left = this.ptrs.find((p) => p.side === "left" && p.source);
    let dockAt: THREE.Vector3 | null = null;
    if (left && on("wristMenu") && !this.handsQuiet(left) && !(this.wheelBy?.via === "palm" && this.wheelBy.p === left)) {
      if (this.isHand(left)) {
        const pose = left.gest.pose;
        if (pose && !left.gest.palmUp) {
          const toHead = head.clone().sub(pose.palmCenter).normalize();
          const facing = pose.palmNormal.dot(toHead);
          if (facing > (this.dockShown ? 0.25 : 0.55)) dockAt = pose.palmCenter.clone().addScaledVector(pose.palmNormal, 0.05).add(new THREE.Vector3(0, 0.07, 0));
        }
      } else {
        left.grip.updateMatrixWorld();
        dockAt = new THREE.Vector3().setFromMatrixPosition(left.grip.matrixWorld).add(new THREE.Vector3(0, 0.09, 0));
      }
    }
    // Something on the dock in use (a ray on it) keeps it up while the wrist wobbles.
    const dockHot = this.ptrs.some((p) => p.hoverPanel?.panel === this.dock || (p.press?.kind === "panel" && p.press.panel === this.dock) || p.poke?.panel === this.dock);
    if (dockAt) this.dockShown = performance.now();
    const showDock = !!dockAt || (dockHot && performance.now() - this.dockShown < 1500);
    this.dock.mesh.visible = showDock;
    if (dockAt) {
      this.dock.mesh.position.lerp(dockAt, this.dock.mesh.userData.was ? 0.5 : 1);
      faceHead(this.dock.mesh, head);
    }
    this.dock.mesh.userData.was = showDock;

    // The palm menu: the wheel, blooming from an upturned palm.
    const palmSide = pick("palmMenu");
    if (palmSide !== "off") {
      const hand = this.ptrs.find((p) => p.side === palmSide && p.source && this.isHand(p));
      const up = !!hand?.gest.palmUp && !hand.carry && !hand.press && !this.handsQuiet(hand);
      const using = this.ptrs.some((q) => q.hoverPanel?.panel === this.wheel || q.poke?.panel === this.wheel || (q.press?.kind === "panel" && q.press.panel === this.wheel));
      if (up && hand && !this.wheelBy) this.openWheel(hand, "palm", -1);
      else if (this.wheelBy?.via === "palm" && !up && !using) this.closeWheel();
    }
    if (this.wheel.mesh.visible) {
      this.wheel.refresh();
      this.placeWheel();
    } else this.wheel.mesh.userData.was = false;

    // Captions: subtitles low in your view, there only while there's something to say.
    const a = this.activity();
    if (a?.answer && !a.busy && a.at !== this.lastAnswer?.at) this.lastAnswer = { text: a.answer, at: a.at };
    const cap = this.ctl.caption();
    const text = !on("captions")
      ? ""
      : a?.busy
        ? `◆ ${a.line ?? "Working"}…`
        : a?.error && Date.now() - a.at < 8000
          ? `Builder: ${a.error}`
          : cap
            ? cap
            : this.lastAnswer && Date.now() - this.lastAnswer.at < 9000
              ? this.lastAnswer.text
              : "";
    this.captions.show(text, a?.busy ? LOOK.accent : a?.error ? LOOK.danger : "#dff6ff");
    this.captions.mesh.visible = !!text;
    if (text) {
      const want = head.clone().addScaledVector(fwd, 0.95).add(new THREE.Vector3(0, -0.3, 0));
      if (this.captionAt.lengthSq() === 0 || this.captionAt.distanceTo(want) > 0.6) this.captionAt.copy(want);
      else this.captionAt.lerp(want, 1 - Math.exp(-dt * 2.5));
      this.captions.mesh.position.copy(this.captionAt);
      faceHead(this.captions.mesh, head);
    }

    // Controller labels: over a controller while you look at it.
    for (const side of ["left", "right"] as const) {
      const h = this.hints[side];
      const p = this.ptrs.find((q) => q.side === side && q.source && !this.isHand(q));
      let show = false;
      if (p && on("buttonHints") && !this.wheelBy) {
        p.grip.updateMatrixWorld();
        const g = new THREE.Vector3().setFromMatrixPosition(p.grip.matrixWorld);
        const look = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
        const to = g.clone().sub(head);
        const d = to.length();
        show = d < 0.6 && to.normalize().dot(look) > Math.cos(THREE.MathUtils.degToRad(22));
        if (show) {
          h.refresh();
          h.mesh.position.lerp(g.add(new THREE.Vector3(0, 0.075, 0)), h.mesh.visible ? 0.4 : 1);
          h.mesh.lookAt(head);
        }
      }
      h.mesh.visible = show;
      h.render();
    }

    // Pointed at: full strength; otherwise they step back a little.
    for (const p of this.panels) {
      const hot = this.ptrs.some((q) => q.hoverPanel?.panel === p || q.poke?.panel === p || ((q.press?.kind === "panel" || q.press?.kind === "move") && q.press.panel === p));
      const want = hot || p === this.wheel ? 1 : num("panelOpacity");
      const mat = p.mesh.material;
      mat.opacity += (want - mat.opacity) * Math.min(1, dt * 10);
    }

    const key = `${this.ctl.tool()}|${this.ctl.voiceState()}|${this.palette.mesh.visible}|${this.tune.mesh.visible}|${this.ctl.client.board?.id}|${this.scene.covered}|${on("lockItems")}`;
    if (key !== this.beltKey) {
      this.beltKey = key;
      this.dock.invalidate();
    }
    this.toast.tick();
    for (const p of [...this.panels, this.captions, this.toast, this.twoTag]) p.render();
  }

  /** A component from the palette: on the table where you're looking. */
  private spawn(k: ItemKind) {
    const at = this.scene.focusPoint();
    const id = this.ctl.add(k, at);
    this.ctl.select([id]);
    sfx.play("place");
  }

  /* -------------------------------- setup -------------------------------- */

  private setup() {
    const r = this.scene.renderer;
    const ctrlModels = new XRControllerModelFactory();
    const handModels = new XRHandModelFactory();
    for (let i = 0; i < 2; i++) {
      const ray = r.xr.getController(i);
      const grip = r.xr.getControllerGrip(i);
      const hand = r.xr.getHand(i);
      grip.add(ctrlModels.createControllerModel(grip));
      hand.add(handModels.createHandModel(hand, "mesh"));
      const { line, dot } = makeRay(LOOK.cyan, "#ffffff");
      ray.add(line);
      dot.visible = false;
      this.scene.overlay.add(ray, grip, hand, dot);
      const p: Pointer = {
        i,
        ray,
        grip,
        hand,
        line,
        dot,
        source: null,
        side: "none",
        gest: new HandGestures("none"),
        origin: new THREE.Vector3(),
        dir: new THREE.Vector3(0, 0, -1),
        hoverPanel: null,
        hoverItem: null,
        press: null,
        carry: null,
        grabbing: false,
        buttons: [],
        downAt: [],
        heldFired: [],
        poke: null,
        snapLatch: false,
        lastSnap: "",
      };
      ray.addEventListener("connected", (e) => {
        const src = (e as unknown as { data: XRInputSource }).data;
        p.source = src;
        p.side = src.handedness;
        p.gest = new HandGestures(src.handedness);
      });
      ray.addEventListener("disconnected", () => {
        this.cancel(p);
        p.source = null;
      });
      ray.addEventListener("selectstart", () => this.selectStart(p));
      ray.addEventListener("selectend", () => this.selectEnd(p));
      ray.addEventListener("squeezestart", () => this.squeezeStart(p));
      ray.addEventListener("squeezeend", () => this.squeezeEnd(p));
      this.ptrs.push(p);
    }
  }

  /* ------------------------------- helpers ------------------------------- */

  isHand(p: Pointer) {
    return !!p.source?.hand;
  }

  /** What two hands on one item are doing now (scale, explode, open), if they are. */
  get twoHandsMode() {
    return this.two?.mode ?? null;
  }

  get wheelOpen() {
    return this.wheel.mesh.visible;
  }

  get dockOpen() {
    return this.dock.mesh.visible;
  }

  /** Until when tracked hands are ignored: they rest on a keyboard while you type. */
  private handsQuietUntil = 0;

  /** Typing: the hands rest a moment (pinches, pokes, palm menus and gestures don't fire). */
  hushHands() {
    if (!on("typingHushesHands")) return;
    this.handsQuietUntil = performance.now() + num("typingHandsBackMs");
    for (const p of this.ptrs) {
      if (!this.isHand(p) || p.carry) continue;
      if (p.press?.kind === "panel") p.press.panel.pointer("up", -1, -1, `p${p.i}`);
      if (p.press) p.hushed = true;
      p.press = null;
      if (p.poke?.down) p.poke.panel.pointer("up", -1, -1, `k${p.i}`);
      p.poke = null;
    }
  }

  /** Whether this hand is resting (typing just now). Controllers never are. */
  handsQuiet(p?: Pointer) {
    return performance.now() < this.handsQuietUntil && (!p || this.isHand(p));
  }

  /** How big an item is in the room (m): for its pitch. */
  sizeOf(id: string) {
    const v = this.scene.views.get(id);
    return v ? v.radius * v.root.scale.x * this.scene.rig.scale.x * 2 : 0.1;
  }

  /** Where the hand (pinch point) or the controller's tip is, in the world. */
  tip(p: Pointer): THREE.Vector3 {
    if (this.isHand(p)) {
      const pp = p.gest.pinchPoint();
      if (pp) return pp;
    }
    return p.origin.clone().addScaledVector(p.dir, 0.035);
  }

  /** The pose an item carried in this hand follows: the grip for a controller, the pinch for a hand. */
  private holdPose(p: Pointer): THREE.Matrix4 {
    if (this.isHand(p)) {
      const pos = p.gest.pinchPoint() ?? p.origin;
      return new THREE.Matrix4().compose(pos, p.ray.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1));
    }
    p.grip.updateMatrixWorld();
    return p.grip.matrixWorld.clone();
  }

  /** The item within reach of this hand, if any (for taking it directly). */
  private nearItem(p: Pointer): string | null {
    const at = this.isHand(p) ? this.tip(p) : new THREE.Vector3().setFromMatrixPosition(p.grip.matrixWorld);
    let best: string | null = null;
    let bestD = Infinity;
    const s = this.scene.rig.scale.x;
    const reach = num("grabReach");
    for (const v of this.scene.views.values()) {
      if (v.dying || v.item.kind === "frame" || v.hidden || v.crush) continue;
      const d = v.center().distanceTo(at) - v.radius * v.root.scale.x * s;
      if (d < reach && d < bestD) {
        best = v.id;
        bestD = d;
      }
    }
    return best;
  }

  private panelHit(p: Pointer): { panel: HoloPanel; x: number; y: number; dist: number } | null {
    const rc = new THREE.Raycaster(p.origin, p.dir, 0, 5);
    let best: { panel: HoloPanel; x: number; y: number; dist: number } | null = null;
    for (const panel of this.allPanels()) {
      if (!panel.mesh.visible) continue;
      const h = rc.intersectObject(panel.mesh, false)[0];
      if (h?.uv && (!best || h.distance < best.dist)) best = { panel, x: h.uv.x * panel.W, y: (1 - h.uv.y) * panel.H, dist: h.distance };
    }
    return best;
  }

  haptic(p: Pointer, v = 0.4, ms = 30) {
    if (!on("haptics")) return;
    const g = p.source?.gamepad as (Gamepad & { hapticActuators?: { pulse: (v: number, ms: number) => void }[] }) | undefined;
    g?.hapticActuators?.[0]?.pulse(Math.min(1, v * num("hapticStrength") * 1.6), ms);
  }

  /** On a panel's title bar (and not on a button there): a pinch carries the panel. */
  private onHeader(ph: { panel: HoloPanel; x: number; y: number }) {
    return ph.y < ph.panel.header && !ph.panel.regionAt(ph.x, ph.y);
  }

  private head() {
    return new THREE.Vector3().setFromMatrixPosition(this.scene.renderer.xr.getCamera().matrixWorld);
  }

  /* -------------------------------- presses ------------------------------ */

  private selectStart(p: Pointer) {
    if (this.scene.mode === "flat") return;
    if (this.handsQuiet(p)) {
      p.hushed = true;
      return;
    }
    sfx.resume();
    // Two hands on an item: the helping hand's trigger swaps stretching for pulling apart.
    if (this.two && !p.carry && this.ptrs.some((q) => q !== p && q.carry?.id === this.two!.id)) {
      this.cycleTwo(p);
      return;
    }
    // A controller gripping an item: the trigger crumples it.
    if (p.carry && !this.isHand(p) && on("crumple") && !p.carry.locked) return this.crumple(p);
    // The wheel, opened by a button: the trigger picks the slice the ray is on (handled as a panel press below).
    for (const pl of this.plugins) if (pl.press?.(p, "select")) return;
    const ph = this.panelHit(p);
    // The wheel left open, and the trigger pulled elsewhere: it goes, and the press does what it would.
    if (this.wheelBy && this.wheelBy.via !== "palm" && ph?.panel !== this.wheel) this.closeWheel();
    if (ph) {
      if (this.onHeader(ph) && ph.panel !== this.wheel) {
        p.press = { kind: "move", panel: ph.panel, dist: ph.dist, trail: [] };
        sfx.play("grab");
        return;
      }
      ph.panel.pointer("down", ph.x, ph.y, `p${p.i}`);
      p.press = { kind: "panel", panel: ph.panel };
      return;
    }
    const tool = this.ctl.tool();
    if (on("lockItems")) {
      // Locked, a hand can still take an item (a pinch right on it): it springs back when let go.
      if (this.isHand(p) && this.grabNear(p)) return;
      return this.pressTable(p);
    }
    if (tool === "ink") {
      p.press = { kind: "ink", pts: [this.scene.toBoard(this.tip(p))] };
      return;
    }
    if (tool === "lasso" || tool === "erase") {
      p.press = { kind: "sweep", erase: tool === "erase", ids: [] };
      if (tool === "lasso") this.ctl.select([]);
      sfx.play("tick");
      return;
    }
    // A pinch right on an item takes it in hand.
    if (this.isHand(p) && tool === "select") {
      const near = this.nearItem(p);
      const other = this.ptrs.find((q) => q !== p && q.carry);
      if (near && other?.carry?.id === near) return this.startTwo(p, other);
      if (near) return this.startCarry(p, near);
    }
    // Connect, by hand: pinch on (or right by) an item and draw the link through the air.
    if (tool === "connect" && this.isHand(p)) {
      const near = this.nearItem(p);
      if (near) {
        p.press = { kind: "pull", from: near, path: [] };
        sfx.play("pick");
        return;
      }
    }
    const hit = this.scene.pick(p.origin, p.dir);
    if (hit?.kind === "item") {
      if (tool === "connect") {
        p.press = { kind: "pull", from: hit.id, path: [] };
        sfx.play("pick", hit.point);
        return;
      }
      const v = this.scene.views.get(hit.id)!;
      p.press = {
        kind: "ray",
        id: hit.id,
        dist: hit.dist,
        offset: new THREE.Vector3(...v.item.pos).sub(this.scene.toBoard(hit.point)),
        moved: false,
        at0: hit.point.clone(),
        t0: performance.now(),
        talked: false,
        yaw: 0,
        rot0: v.item.rotY ?? 0,
      };
      this.haptic(p, 0.3, 20);
      return;
    }
    if (hit?.kind === "link") {
      this.ctl.selectLink?.(hit.id);
      sfx.play("pick", hit.point);
      return;
    }
    this.pressTable(p);
  }

  /** Open table or air (or anything, items locked): hold to move the table (both hands to turn and scale it); a tap clears the selection. */
  private pressTable(p: Pointer) {
    p.press = { kind: "empty", at0: p.origin.clone() };
    if (on("pinchMovesTable") || on("lockItems")) {
      p.grabbing = true;
      this.beginBoardGrab();
    }
  }

  private selectEnd(p: Pointer) {
    if (p.hushed) {
      p.hushed = false;
      return;
    }
    const press = p.press;
    p.press = null;
    for (const pl of this.plugins) if (pl.release?.(p, "select")) return;
    if (this.endTwo(p)) return;
    if (p.carry && this.isHand(p)) return this.endCarry(p);
    if (!press) return;
    switch (press.kind) {
      case "panel": {
        const ph = this.panelHit(p);
        press.panel.pointer("up", ph?.panel === press.panel ? ph.x : -1, ph?.panel === press.panel ? ph.y : -1, `p${p.i}`);
        return;
      }
      case "move":
        return this.dropPanel(press);
      case "ink": {
        this.scene.showInk(null);
        if (press.pts.length < 2) return;
        const base = press.pts[0];
        const s = this.scene.rig.scale.x;
        this.ctl.add("ink", [round(base.x), round(base.y), round(base.z)], {
          points: press.pts.map((q) => [round(q.x - base.x), round(q.y - base.y), round(q.z - base.z)] as Vec3),
          color: this.ctl.inkColor(),
          width: round(0.004 / s),
        });
        sfx.play("place");
        return;
      }
      case "sweep": {
        this.scene.setHover([]);
        if (!press.ids.length) return;
        if (press.erase) {
          for (const id of press.ids) {
            const v = this.scene.views.get(id);
            if (v) this.scene.fx.burst(v.root.position.clone().setY(v.midY * v.root.scale.x + v.root.position.y), LOOK.danger, 24, 0.35);
          }
          this.ctl.remove(press.ids);
          sfx.play("erase");
          this.say(`Erased ${press.ids.length}`, p);
        } else {
          this.ctl.select(press.ids);
          sfx.play("pick");
          this.say(`${press.ids.length} selected`, p);
        }
        this.haptic(p, 0.6, 50);
        return;
      }
      case "pull": {
        this.scene.showPull(null);
        const target = this.isHand(p) ? this.nearItem(p) : null;
        const hit = target ? { kind: "item" as const, id: target, point: this.tip(p) } : this.scene.pick(p.origin, p.dir, { ignore: press.from });
        if (hit?.kind === "item" && hit.id !== press.from) {
          this.ctl.link(press.from, hit.id, on("drawnLinks") ? { via: simplifyPath(press.path) } : undefined);
          sfx.play("snap", hit.point);
          this.haptic(p, 0.5, 40);
        } else for (const pl of this.plugins) if (pl.linkAcross?.(press.from, p.origin, p.dir)) return void this.haptic(p, 0.5, 40);
        return;
      }
      case "ray": {
        this.scene.showGuides(null);
        if (press.talked) return;
        if (press.moved) {
          this.ctl.client.release(press.id);
          sfx.play("drop");
        } else {
          this.ctl.select([press.id]);
          sfx.play("pick");
        }
        return;
      }
      case "empty":
        if (p.grabbing) {
          p.grabbing = false;
          this.beginBoardGrab();
        }
        if (p.origin.distanceTo(press.at0) < 0.03) this.ctl.select([]);
        else this.scene.saveRig();
        return;
    }
  }

  private squeezeStart(p: Pointer) {
    if (this.scene.mode === "flat") return;
    if (this.handsQuiet(p)) {
      p.hushed = true;
      return;
    }
    for (const pl of this.plugins) if (pl.press?.(p, "squeeze")) return;
    // A panel under the ray: carry it.
    const ph = this.panelHit(p);
    if (ph && ph.panel !== this.wheel) {
      p.press = { kind: "move", panel: ph.panel, dist: ph.dist, trail: [] };
      sfx.play("grab");
      return;
    }
    if (on("lockItems")) {
      // Locked: a grip right on an item borrows it (it springs back); anywhere else moves the table.
      if (this.grabNear(p)) return;
      p.grabbing = true;
      this.beginBoardGrab();
      return;
    }
    // Already carrying with the other hand: this one joins in on the same item.
    const other = this.ptrs.find((q) => q !== p && q.carry);
    const near = this.nearItem(p);
    const hit = this.scene.pick(p.origin, p.dir);
    const target = near ?? (hit?.kind === "item" ? hit.id : null);
    if (other && target === other.carry!.id) return this.startTwo(p, other);
    if (target) return this.startCarry(p, target);
    p.grabbing = true;
    this.beginBoardGrab();
  }

  private squeezeEnd(p: Pointer) {
    if (p.hushed) {
      p.hushed = false;
      return;
    }
    for (const pl of this.plugins) if (pl.release?.(p, "squeeze")) return;
    if (p.press?.kind === "move") {
      const press = p.press;
      p.press = null;
      return this.dropPanel(press);
    }
    if (this.endTwo(p)) return;
    if (p.carry) return this.endCarry(p);
    if (p.grabbing) {
      p.grabbing = false;
      this.beginBoardGrab();
      if (!this.ptrs.some((q) => q.grabbing)) this.scene.saveRig();
    }
  }

  /** A panel let go: where it is, or (thrown) wherever a plugin catches it — a wall. */
  private dropPanel(press: Extract<Press, { kind: "move" }>) {
    const v = velocity(press.trail);
    if (v && v.speed > num("flingSpeed") * 0.7 && on("throwToWall")) {
      for (const pl of this.plugins) if (pl.throwPanel?.(press.panel, v.at, v.vel)) return;
    }
    sfx.play("drop");
  }

  /* -------------------------------- carrying ----------------------------- */

  /** An item right at the hand: take it (or, the other hand has it, both on it). True when there was one. */
  private grabNear(p: Pointer) {
    const near = this.nearItem(p);
    if (!near) return false;
    const other = this.ptrs.find((q) => q !== p && q.carry);
    if (other?.carry?.id === near) this.startTwo(p, other);
    else this.startCarry(p, near);
    return true;
  }

  /** Let go of a carried item: where it is now stays, or (borrowed while locked) back it goes. */
  private letGo(c: Carry, extra?: Parameters<Ctl["client"]["release"]>[1]) {
    if (c.locked) this.ctl.client.drop(c.id);
    else this.ctl.client.release(c.id, extra);
  }

  private startCarry(p: Pointer, id: string) {
    const v = this.scene.views.get(id);
    if (!v) return;
    this.scene.rig.updateMatrixWorld();
    v.root.updateMatrixWorld();
    const offset = this.holdPose(p).invert().multiply(v.root.matrixWorld);
    const locked = on("lockItems");
    if (locked) this.ctl.client.ghost(id);
    p.carry = { id, offset, trail: [], yaw: 0, fistSince: 0, locked };
    this.ctl.select([id]);
    sfx.play("grab", v.center(), id, this.sizeOf(id));
    this.haptic(p, 0.6, 40);
  }

  private moveCarry(p: Pointer, now: number) {
    const c = p.carry!;
    const v = this.scene.views.get(c.id);
    if (!v) return;
    const world = this.holdPose(p).multiply(c.offset);
    const local = this.scene.rig.matrixWorld.clone().invert().multiply(world);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    local.decompose(pos, quat, scl);
    if (c.yaw) quat.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw));
    // Blocks and notes stay upright: only their turn about the vertical follows the hand.
    const upright = v.item.kind !== "holo" && v.item.kind !== "ink";
    let at: Vec3 = [round(pos.x), round(Math.max(0, pos.y - v.lift)), round(pos.z)];
    const m = magnet(this.ctl.client.board, c.id, at);
    at = m.pos;
    this.scene.showGuides(m.guides);
    if (m.snapped && m.snapped !== p.lastSnap) this.haptic(p, 0.25, 15);
    p.lastSnap = m.snapped;
    const patch: { pos: Vec3; quat?: [number, number, number, number]; rotY?: number } = { pos: at };
    if (upright) patch.rotY = round(THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(quat, "YXZ").y));
    else patch.quat = [round(quat.x), round(quat.y), round(quat.z), round(quat.w)];
    this.ctl.client.hold(c.id, patch);
    const w = new THREE.Vector3().setFromMatrixPosition(world);
    c.trail.push({ t: now, at: w });
    while (c.trail.length > 2 && now - c.trail[0].t > 120) c.trail.shift();

    // A fist closing on it: crumpled.
    if (this.isHand(p) && on("crumple") && !c.locked && p.gest.pose) {
      const g = p.gest.pose;
      const curled = (tip: THREE.Vector3, r: number) => tip.distanceTo(g.palmCenter) < r;
      const fist = curled(g.middleTip, 0.06) && curled(g.ringTip, 0.06) && curled(g.indexTip, 0.075);
      if (fist) {
        c.fistSince ||= now;
        if (now - c.fistSince > 180) this.crumple(p);
      } else c.fistSince = 0;
    }
  }

  /** Crushed in the hand: it crumples, sparks, and is gone (one step to undo). */
  private crumple(p: Pointer) {
    const c = p.carry;
    if (!c) return;
    p.carry = null;
    this.scene.showGuides(null);
    const v = this.scene.views.get(c.id);
    this.ctl.client.release(c.id);
    if (v) {
      v.crush = 0.01;
      const at = v.root.position.clone().add(new THREE.Vector3(0, v.midY * v.root.scale.x, 0));
      setTimeout(() => this.scene.fx.burst(at, colorOf(v.item.color), 70, 0.45), 260);
    }
    sfx.play("crumple", v?.center(), c.id, this.sizeOf(c.id));
    this.haptic(p, 1, 120);
    setTimeout(() => this.ctl.remove([c.id]), 340);
  }

  private endCarry(p: Pointer) {
    const c = p.carry!;
    p.carry = null;
    this.scene.showGuides(null);
    const v = velocity(c.trail);
    if (v && v.speed > num("flingSpeed")) {
      // Thrown: at a wall it sticks (a plugin catches it); otherwise away it goes.
      if (on("throwToWall")) for (const pl of this.plugins) if (pl.throwItem?.(c.id, v.at, v.vel)) return void this.letGo(c);
      // Locked items aren't thrown away: they fly home.
      if (on("flingDeletes") && !c.locked) {
        this.ctl.client.release(c.id);
        this.ctl.remove([c.id]);
        sfx.play("fling", v.at);
        this.haptic(p, 0.8, 60);
        return;
      }
    }
    this.letGo(c);
    sfx.play(c.locked ? "back" : "drop", this.scene.views.get(c.id)?.center(), c.id, this.sizeOf(c.id));
  }

  /**
   * A hand let go while two were on one item. The helping hand: the item stays
   * in the other, at its new size — or, spread wide enough, you dive inside it.
   * The holding hand: it's let go as usual.
   */
  private endTwo(p: Pointer): boolean {
    const two = this.two;
    if (!two) return false;
    const holder = this.ptrs.find((q) => q.carry?.id === two.id);
    this.two = null;
    this.twoTag.mesh.visible = false;
    if (two.mode === "open" && two.k > 2.2 && this.ctl.inside) {
      // Back to its size; through it, inside.
      if (holder?.carry) {
        const c = holder.carry;
        holder.carry = null;
        this.letGo(c, { scale: two.scale0 });
      }
      this.ctl.inside(two.id);
      sfx.play("focus");
      return true;
    }
    return p !== holder;
  }

  private startTwo(p: Pointer, holder: Pointer) {
    const v = this.scene.views.get(holder.carry!.id);
    if (!v) return;
    const holo = v.item.kind === "holo" && !!v.item.holo?.parts?.length;
    const want = pick("twoHandMode");
    this.two = {
      id: v.id,
      d0: Math.max(0.02, this.tip(p).distanceTo(this.tip(holder))),
      scale0: v.item.scale ?? 1,
      explode0: v.item.explode ?? 0,
      holo,
      mode: want === "explode" && holo ? "explode" : want === "scale" ? "scale" : holo ? "explode" : v.item.sub && on("spreadOpens") ? "open" : "scale",
      k: 1,
    };
    p.grabbing = false;
    this.haptic(p, 0.5, 30);
  }

  /** The helping hand swaps what stretching does: scale → pull apart (a hologram) → dive inside → scale. */
  private cycleTwo(p: Pointer) {
    const t = this.two;
    if (!t) return;
    const order: Two["mode"][] = ["scale", ...(t.holo ? (["explode"] as const) : []), ...(on("spreadOpens") && this.ctl.inside ? (["open"] as const) : [])];
    t.mode = order[(order.indexOf(t.mode) + 1) % order.length];
    // Start the new one from here.
    const holder = this.ptrs.find((q) => q.carry?.id === t.id);
    const v = this.scene.views.get(t.id);
    if (holder && v) {
      t.d0 = Math.max(0.02, this.tip(p).distanceTo(this.tip(holder)));
      t.scale0 = v.item.scale ?? 1;
      t.explode0 = v.item.explode ?? 0;
    }
    sfx.play("tick");
    this.haptic(p, 0.4, 25);
  }

  /* ---------------------------- the whole table --------------------------- */

  private beginBoardGrab() {
    const hs = this.ptrs.filter((q) => q.grabbing);
    if (!hs.length) {
      this.boardGrab = null;
      return;
    }
    const rig = this.scene.rig;
    const a = this.tip(hs[0]);
    const b = hs[1] ? this.tip(hs[1]) : null;
    this.boardGrab = { a, b, pos: rig.position.clone(), yaw: rig.rotation.y, scale: rig.scale.x, mid: b ? a.clone().lerp(b, 0.5) : a.clone() };
  }

  private moveBoard() {
    const g = this.boardGrab;
    if (!g) return;
    const hs = this.ptrs.filter((q) => q.grabbing);
    if (!hs.length) return;
    const rig = this.scene.rig;
    if (hs.length === 1 || !g.b) {
      const now = this.tip(hs[0]);
      rig.position.copy(g.pos).add(now.sub(g.a));
      return;
    }
    const a = this.tip(hs[0]);
    const b = this.tip(hs[1]);
    const mid = a.clone().lerp(b, 0.5);
    const k = THREE.MathUtils.clamp(a.distanceTo(b) / Math.max(0.02, g.a.distanceTo(g.b)), 0.2, 5);
    const yaw0 = Math.atan2(g.b.x - g.a.x, g.b.z - g.a.z);
    const yaw1 = Math.atan2(b.x - a.x, b.z - a.z);
    const dyaw = this.boardTurns ? yaw1 - yaw0 : 0;
    const scale = THREE.MathUtils.clamp(g.scale * k, 0.05, 10);
    // Turn and scale about the hands' midpoint, which follows the hands.
    const rel = g.pos.clone().sub(g.mid);
    rel.applyAxisAngle(new THREE.Vector3(0, 1, 0), dyaw).multiplyScalar(scale / g.scale);
    rig.position.copy(mid).add(rel);
    if (this.boardTurns) rig.rotation.y = g.yaw + dyaw;
    rig.scale.setScalar(scale);
  }

  /** Two hands on open air right now (the table being turned and scaled). */
  get scalingBoard() {
    return this.ptrs.filter((q) => q.grabbing).length >= 2;
  }

  /* --------------------------------- frame ------------------------------- */

  private cancel(p: Pointer) {
    if (p.carry) this.letGo(p.carry);
    if (p.press?.kind === "ray" && p.press.moved) this.ctl.client.release(p.press.id);
    if (p.poke?.down) p.poke.panel.pointer("up", -1, -1, `k${p.i}`);
    p.poke = null;
    p.carry = null;
    p.press = null;
    p.grabbing = false;
    this.scene.showInk(null);
    this.scene.showPull(null);
    this.scene.showGuides(null);
  }

  private frame(t: number, dt: number) {
    if (this.scene.mode === "flat") return;
    const now = performance.now();
    const cam = this.scene.renderer.xr.getCamera();
    const hovered: string[] = [];

    for (const p of this.ptrs) {
      p.ray.updateMatrixWorld();
      p.origin.setFromMatrixPosition(p.ray.matrixWorld);
      p.dir.set(0, 0, -1).transformDirection(p.ray.matrixWorld);
      const connected = !!p.source;
      p.line.visible = connected && on("rays");
      p.line.material.opacity = num("rayBrightness");
      p.grip.visible = on("controllerModels");
      p.hand.visible = on("handModels");
      if (!connected) {
        p.dot.visible = false;
        continue;
      }

      // Hand gestures: the middle pinches, and a fingertip on a panel.
      if (this.isHand(p)) {
        const g = p.gest.update(p.hand, now);
        // Resting on a keyboard: no ray, no pinches, no pokes (one carrying something keeps it).
        if (this.handsQuiet(p) && !p.carry) {
          p.line.visible = false;
          p.dot.visible = false;
          p.hoverPanel = null;
          p.hoverItem = null;
          continue;
        }
        if (g.middlePinch) {
          if (this.two && !p.carry) this.cycleTwo(p);
          else this.act(pick(p.side === "left" ? "leftMiddlePinch" : "rightMiddlePinch"), p);
        }
        this.pokePanels(p);
      }
      this.readButtons(p, dt, now);

      if (p.carry) this.moveCarry(p, now);

      const press = p.press;
      let rayLen = 1.2;
      p.dot.visible = false;
      if (press?.kind === "panel") {
        const ph = this.panelHit(p);
        if (ph?.panel === press.panel) press.panel.pointer("move", ph.x, ph.y, `p${p.i}`);
      } else if (press?.kind === "move") {
        // Carrying a panel on the end of the ray: it faces you, and stays where it's let go.
        const m = press.panel.mesh;
        m.position.copy(p.origin).addScaledVector(p.dir, press.dist);
        faceHead(m, new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld));
        press.panel.pinned = true;
        const f = this.floats.find((x) => x.panel === press.panel);
        if (f) f.following = false;
        press.panel.invalidate();
        press.trail.push({ t: now, at: m.position.clone() });
        while (press.trail.length > 2 && now - press.trail[0].t > 120) press.trail.shift();
        rayLen = press.dist;
      } else if (press?.kind === "ray") {
        const v = this.scene.views.get(press.id);
        const tipAt = p.origin.clone().addScaledVector(p.dir, press.dist);
        if (!press.moved && tipAt.distanceTo(press.at0) > 0.015) press.moved = true;
        // Talking about it, then moved off after all: it's a drag (the trigger never goes dead on an item).
        if (press.talked && tipAt.distanceTo(press.at0) > 0.04) {
          press.talked = false;
          press.moved = true;
        }
        // A pinch held still on it (a hand, not a controller's trigger): it's selected and the voice listens — talk about it.
        if (!press.moved && !press.talked && this.isHand(p) && on("pinchToVoice") && now - press.t0 > num("holdToVoiceMs") && v) {
          press.talked = true;
          this.ctl.select([press.id]);
          this.ctl.run?.("ask-selection", "button");
          this.say(`Listening · ${nameOf(v.item).slice(0, 22)}`, p);
          this.haptic(p, 0.5, 60);
          sfx.play("focus", v.center(), v.id);
        }
        if (press.moved && v && !press.talked) {
          const local = this.scene.toBoard(tipAt).add(press.offset);
          const m = magnet(this.ctl.client.board, press.id, [round(local.x), round(Math.max(0, local.y)), round(local.z)]);
          this.scene.showGuides(m.guides);
          if (m.snapped && m.snapped !== p.lastSnap) this.haptic(p, 0.25, 15);
          p.lastSnap = m.snapped;
          this.ctl.client.hold(press.id, press.yaw ? { pos: m.pos, rotY: round(press.rot0 + THREE.MathUtils.radToDeg(press.yaw)) } : { pos: m.pos });
        }
        rayLen = press.dist;
      } else if (press?.kind === "ink") {
        const at = this.scene.toBoard(this.tip(p));
        const last = press.pts[press.pts.length - 1];
        if (at.distanceTo(last) * this.scene.rig.scale.x > 0.003) press.pts.push(at);
        this.scene.showInk(press.pts, this.ctl.inkColor());
        rayLen = 0.04;
      } else if (press?.kind === "sweep") {
        const hit = this.scene.pick(p.origin, p.dir);
        if (hit?.kind === "item" && !press.ids.includes(hit.id)) {
          press.ids.push(hit.id);
          this.haptic(p, 0.3, 15);
          sfx.play("hover", hit.point, hit.id);
          if (!press.erase) this.ctl.select([...press.ids]);
        }
        if (hit) {
          rayLen = hit.dist;
          p.dot.position.copy(hit.point);
          p.dot.visible = true;
        }
        hovered.push(...press.ids);
      } else if (press?.kind === "pull") {
        const v = this.scene.views.get(press.from);
        const handTarget = this.isHand(p) ? this.nearItem(p) : null;
        const hit = handTarget && handTarget !== press.from ? null : this.scene.pick(p.origin, p.dir, { ignore: press.from });
        const end = this.isHand(p) ? this.tip(p) : hit?.point ?? p.origin.clone().addScaledVector(p.dir, 0.6);
        if (hit) rayLen = hit.dist;
        // The path drawn, for a link that keeps its shape.
        const local = this.scene.toBoard(end);
        const lastP = press.path[press.path.length - 1];
        if (!lastP || lastP.distanceTo(local) * this.scene.rig.scale.x > 0.01) press.path.push(local);
        if (v) this.scene.showPull(new THREE.Vector3(...v.item.pos).setY(v.midY), local, on("drawnLinks") && this.isHand(p) ? press.path : undefined);
        if (handTarget && handTarget !== press.from) hovered.push(handTarget);
        else if (hit?.kind === "item") hovered.push(hit.id);
      } else if (!p.carry) {
        // Hovering: panels first, then the board.
        const ph = this.panelHit(p);
        if (p.hoverPanel && p.hoverPanel.panel !== ph?.panel) p.hoverPanel.panel.pointer("leave", 0, 0, `p${p.i}`);
        p.hoverPanel = ph;
        if (ph) {
          ph.panel.pointer("move", ph.x, ph.y, `p${p.i}`);
          rayLen = ph.dist;
          p.dot.position.copy(p.origin).addScaledVector(p.dir, ph.dist);
          p.dot.visible = true;
        } else {
          const hit = this.scene.pick(p.origin, p.dir);
          // Locked: items don't light up under the ray; it's all board.
          const id = hit && hit.kind !== "table" && !on("lockItems") ? hit.id : null;
          if (id && id !== p.hoverItem) {
            this.haptic(p, 0.15, 12);
            sfx.play("hover", hit!.point, id);
          }
          p.hoverItem = id;
          if (id) hovered.push(id);
          if (hit) {
            rayLen = hit.dist;
            p.dot.position.copy(hit.point);
            p.dot.visible = true;
          }
          // A hand near an item lights it: a pinch there will take it.
          if (this.isHand(p)) {
            const n = this.nearItem(p);
            if (n) hovered.push(n);
          }
        }
      }
      p.line.scale.z = rayLen;
      const tool = this.ctl.tool();
      // On a panel: white, so it reads against the cyan glass.
      p.line.material.color.set(p.hoverPanel || p.press?.kind === "panel" ? "#ffffff" : tool === "ink" ? this.ctl.inkColor() : tool === "connect" ? LOOK.accent : tool === "erase" ? LOOK.danger : tool === "lasso" ? LOOK.select : LOOK.cyan);
    }

    // The sticks let go of the table: it stays (and is anchored) where they left it.
    if (this.dirtyRig && !this.ptrs.some((q) => q.source && q.tilted)) {
      this.dirtyRig = false;
      this.scene.saveRig();
    }

    // Two hands on one item: stretch, pull apart, or spread wide to go inside.
    if (this.two) {
      const two = this.two;
      const holder = this.ptrs.find((q) => q.carry?.id === two.id);
      const other = this.ptrs.find((q) => q !== holder && q.source);
      if (holder && other) {
        const a = this.tip(holder);
        const b = this.tip(other);
        const k = a.distanceTo(b) / two.d0;
        two.k = k;
        let label = "";
        if (two.mode === "explode") {
          const e = round(THREE.MathUtils.clamp(two.explode0 + (k - 1) * 1.3, 0, 1));
          this.ctl.client.hold(two.id, { explode: e });
          label = `Pull apart ${Math.round(e * 100)}%`;
        } else if (two.mode === "open") {
          const s = THREE.MathUtils.clamp(two.scale0 * Math.min(k, 2.6), 0.1, 10);
          this.ctl.client.hold(two.id, { scale: round(s) });
          label = k > 2.2 ? "Let go: inside" : `Spread to go inside`;
          if (k > 2.2) this.haptic(other, 0.2, 10);
        } else {
          const s = round(THREE.MathUtils.clamp(two.scale0 * k, 0.1, 10));
          this.ctl.client.hold(two.id, { scale: s });
          label = `Scale ${Math.round(s * 100)}%`;
        }
        const head = this.head();
        this.twoTag.show(label, a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 0.06, 0)), head, 200);
      }
    }
    this.twoTag.tick();

    this.moveBoard();
    // The board hums from its middle.
    const rig = this.scene.rig;
    sfx.humAt(on("hum") ? rig.localToWorld(new THREE.Vector3(0, 0.08, 0)) : null);
    for (const pl of this.plugins) pl.frame?.(dt, now);
    this.scene.setHover(hovered);
    this.updatePanels(dt);
    sfx.listen(new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld), cam.quaternion, now);
    void t;
  }

  /** A fingertip on a panel: hover as it nears, press as it touches, let go as it leaves. */
  private pokePanels(p: Pointer) {
    const tipAt = p.gest.pose?.indexTip;
    if (!on("poke") || !tipAt || p.press || p.carry) {
      if (p.poke?.down) p.poke.panel.pointer("up", -1, -1, `k${p.i}`);
      p.poke = null;
      return;
    }
    let best: { panel: HoloPanel; x: number; y: number; z: number } | null = null;
    for (const panel of this.allPanels()) {
      if (!panel.mesh.visible) continue;
      const local = panel.mesh.worldToLocal(tipAt.clone());
      const sc = panel.mesh.scale.x;
      const z = local.z * sc;
      if (Math.abs(local.x) > panel.widthM / 2 || Math.abs(local.y) > panel.heightM / 2 || z > 0.05 || z < -0.04) continue;
      if (!best || Math.abs(z) < Math.abs(best.z)) best = { panel, x: (local.x / panel.widthM + 0.5) * panel.W, y: (0.5 - local.y / panel.heightM) * panel.H, z };
    }
    const who = `k${p.i}`;
    if (p.poke && p.poke.panel !== best?.panel) {
      if (p.poke.down) p.poke.panel.pointer("up", -1, -1, who);
      p.poke.panel.pointer("leave", 0, 0, who);
      p.poke = null;
    }
    if (!best) return;
    p.poke ??= { panel: best.panel, down: false };
    if (!p.poke.down && best.z < 0.008) {
      p.poke.down = true;
      best.panel.pointer("down", best.x, best.y, who);
      this.haptic(p, 0.3, 15);
    } else if (p.poke.down && best.z > 0.02) {
      p.poke.down = false;
      best.panel.pointer("up", best.x, best.y, who);
    } else best.panel.pointer("move", best.x, best.y, who);
  }

  /** A, B, X, Y, the stick presses and the sticks: each a Tune knob. */
  private readButtons(p: Pointer, dt: number, now: number) {
    const g = p.source?.gamepad;
    if (!g || this.isHand(p) || (p.side !== "left" && p.side !== "right")) return;
    const pressed = g.buttons.map((b) => b.pressed);
    const map = BUTTONS[p.side];
    for (const [is, [tapKey, holdKey]] of Object.entries(map)) {
      const i = Number(is);
      const tap = pick(tapKey);
      const hold = holdKey ? pick(holdKey) : "none";
      const down = !!pressed[i];
      const was = !!p.buttons[i];
      if (down && !was) {
        sfx.resume();
        p.downAt[i] = now;
        p.heldFired[i] = false;
        // A stick press for the wheel opens it now: tilt, let go.
        if (tap === "wheel" && i === 3) {
          // Clicked while pushed over (turning the table hard): not a call for the wheel.
          if (Math.hypot(g.axes[2] ?? 0, g.axes[3] ?? 0) > 0.6) p.heldFired[i] = true;
          else if (this.wheelBy?.p === p) this.closeWheel();
          else this.openWheel(p, "stick", i);
          p.heldFired[i] = true;
        } else if (hold === "none") {
          this.act(tap, p);
          p.heldFired[i] = true;
        }
        this.haptic(p, 0.2, 12);
      } else if (down && was && !p.heldFired[i] && hold !== "none" && now - p.downAt[i] > num("holdMs")) {
        p.heldFired[i] = true;
        this.act(hold, p);
        this.haptic(p, 0.5, 40);
      } else if (!down && was) {
        if (this.wheelBy?.p === p && this.wheelBy.via === "stick" && this.wheelBy.btn === i) {
          // Let go of the stick: the slice it's on runs; none, and the wheel stays for pointing at.
          const a = this.wheel.hotAction();
          if (a) {
            this.closeWheel();
            this.act(a, p);
          } else if (now - p.downAt[i] > 350) this.closeWheel();
          else this.wheelBy.via = "button";
        } else if (!p.heldFired[i]) this.act(tap, p);
      }
    }
    p.buttons = pressed;

    const sx = g.axes[2] ?? 0;
    const sy = g.axes[3] ?? 0;
    const dead = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
    p.tilted = !!(dead(sx) || dead(sy));
    const k = num("stickSpeed");
    // The wheel opened by this stick: the stick picks the slice.
    if (this.wheelBy?.p === p && this.wheelBy.via === "stick") {
      this.wheel.setHot(this.wheel.sliceOf(sx, sy));
      return;
    }
    // Holding something: the stick pushes it away or pulls it in, and turns it.
    if (p.press?.kind === "ray" && (dead(sy) || dead(sx))) {
      p.press.dist = THREE.MathUtils.clamp(p.press.dist - dead(sy) * dt * k, 0.08, 6);
      if (on("carryStickTurns")) p.press.yaw -= dead(sx) * dt * 2.2;
      p.press.moved = true;
      return;
    }
    if (p.carry && on("carryStickTurns") && (dead(sx) || dead(sy))) {
      p.carry.yaw -= dead(sx) * dt * 2.2;
      // Push and pull along the hand's pointing direction, in the hand's own space.
      if (dead(sy)) p.carry.offset.premultiply(new THREE.Matrix4().makeTranslation(0, 0, dead(sy) * dt * 0.5 * k));
      return;
    }
    if (p.press?.kind === "move" && dead(sy)) {
      p.press.dist = THREE.MathUtils.clamp(p.press.dist - dead(sy) * dt * k * 0.5, 0.2, 2);
      return;
    }
    const rig = this.scene.rig;
    if (p.side === "right" && !p.carry) {
      const mode = pick("rightStick");
      if (mode === "table" && (dead(sx) || dead(sy))) {
        // Turn the table about its middle; scale it up and down.
        if (this.boardTurns) rig.rotation.y -= dead(sx) * dt * k;
        rig.scale.setScalar(THREE.MathUtils.clamp(rig.scale.x * (1 - dead(sy) * dt * 0.7 * k), 0.05, 10));
        this.dirtyRig = true;
        return;
      }
      if (mode === "snap-turn") {
        if (!p.snapLatch && Math.abs(sx) > 0.75 && this.boardTurns) {
          p.snapLatch = true;
          rig.rotation.y -= Math.sign(sx) * (Math.PI / 6);
          this.dirtyRig = true;
          sfx.play("tick");
          this.haptic(p, 0.3, 20);
        } else if (Math.abs(sx) < 0.3) p.snapLatch = false;
      }
    } else if (p.side === "left" && pick("leftStick") === "move" && (dead(sx) || dead(sy))) {
      // Slide it across the room, as you face.
      const { fwd, right } = headFrame(this.scene.renderer.xr.getCamera());
      rig.position.addScaledVector(right, dead(sx) * dt * 0.7 * k).addScaledVector(fwd, -dead(sy) * dt * 0.7 * k);
      this.dirtyRig = true;
    }
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** How fast a trail was moving at its end (world space): a throw. */
function velocity(trail: { t: number; at: THREE.Vector3 }[]) {
  if (trail.length < 2) return null;
  const a = trail[0];
  const b = trail[trail.length - 1];
  const s = Math.max(0.001, (b.t - a.t) / 1000);
  const vel = b.at.clone().sub(a.at).divideScalar(s);
  return { speed: vel.length(), vel, at: b.at.clone() };
}

/** A drawn path, thinned to a few points it passes through — or nothing, when it was nearly straight. */
function simplifyPath(path: THREE.Vector3[]): Vec3[] | undefined {
  if (path.length < 4) return undefined;
  const a = path[0];
  const b = path[path.length - 1];
  const line = new THREE.Line3(a, b);
  const far = Math.max(...path.map((p) => line.closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p)));
  if (far < 0.03) return undefined;
  const n = Math.min(8, Math.max(2, Math.round(path.length / 6)));
  const out: Vec3[] = [];
  for (let i = 1; i <= n; i++) {
    const p = path[Math.round((i / (n + 1)) * (path.length - 1))];
    out.push([round(p.x), round(Math.max(0, p.y)), round(p.z)]);
  }
  return out;
}
