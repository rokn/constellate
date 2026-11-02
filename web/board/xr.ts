import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { Board, ItemKind, Vec3 } from "../../shared/board";
import type { BoardPreset } from "../../shared/boardTune";
import { HandGestures } from "../xr/hands";
import { sfx } from "../xr/sound";
import type { Ctl } from "./ctl";
import { Callout, Captions, Dock, HoloPanel, Palette, TunePanel, faceHead, headFrame, type PaletteExtras } from "./hud";
import { LOOK } from "./look";
import type { BoardScene } from "./scene";
import { num, on, onTune } from "./tune";

/**
 * Hands and controllers in the workshop.
 *
 *  - Point and pinch (or pull the trigger): on an item, select it, and keep
 *    holding to drag it along the ray (the thumbstick pushes it away or pulls
 *    it in); on open table, hold to move the table, tap to clear the selection.
 *  - Grab (grip, or a pinch right on it): carry an item in your hand, turned
 *    as your hand turns. Throw it away to delete it.
 *  - Both hands on one item: stretch it — or, a hologram, pull it apart.
 *  - Both hands on open air: turn and scale the table.
 *  - The connect tool: pinch on one item, let go on another. The ink tool:
 *    pinch and draw in the air.
 *  - Panels: pinch (or grip) a panel's title bar to carry it; let go and it
 *    stays there, pinned. Unpinned panels drift after you as you turn.
 *
 * Buttons: A the palette, B undo, X voice, Y tune. Turn your left hand's palm
 * toward you for the wrist dock; left middle-finger pinch is the voice, the
 * right one undo.
 */

type Press =
  | { kind: "panel"; panel: HoloPanel }
  | { kind: "move"; panel: HoloPanel; dist: number }
  | { kind: "ray"; id: string; dist: number; offset: THREE.Vector3; moved: boolean; at0: THREE.Vector3 }
  | { kind: "empty"; at0: THREE.Vector3 }
  | { kind: "pull"; from: string }
  | { kind: "ink"; pts: THREE.Vector3[] };

type Carry = { id: string; offset: THREE.Matrix4; trail: { t: number; at: THREE.Vector3 }[] };

type Pointer = {
  i: number;
  ray: THREE.Group;
  grip: THREE.Group;
  hand: THREE.XRHandSpace;
  line: THREE.Line;
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
};

/** A panel that floats in front of you: where it sits beside your gaze, and whether it's drifting after you now. */
type Float = { panel: HoloPanel; side: number; following: boolean };

export class XRInput {
  private ptrs: Pointer[] = [];
  private dock: Dock;
  private palette: Palette;
  private tune: TunePanel;
  private callout: Callout;
  private captions: Captions;
  private floats: Float[];
  private panels: HoloPanel[];
  private leader: THREE.Line;
  private boardGrab: { a: THREE.Vector3; b: THREE.Vector3 | null; pos: THREE.Vector3; yaw: number; scale: number; mid: THREE.Vector3 } | null = null;
  private two: { id: string; d0: number; scale0: number; explode0: number; holo: boolean } | null = null;
  private dockShown = 0;
  private captionAt = new THREE.Vector3();
  private lastAnswer: { text: string; at: number } | null = null;
  private off: () => void;
  private offTune: () => void;
  private beltKey = "";
  private dirtyRig = false;

  constructor(
    private scene: BoardScene,
    private ctl: Ctl,
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
      isOpen: (n) => (n === "palette" ? this.palette.mesh.visible : this.tune.mesh.visible),
    });
    this.callout = new Callout(ctl);
    this.captions = new Captions();
    this.palette.onClose = () => this.close(this.palette);
    this.tune.onClose = () => this.close(this.tune);
    this.floats = [
      { panel: this.palette, side: -0.17, following: false },
      { panel: this.tune, side: 0.2, following: false },
    ];
    this.panels = [this.dock, this.palette, this.tune, this.callout];
    for (const p of [...this.panels, this.captions]) {
      p.mesh.material.opacity = 1;
      scene.overlay.add(p.mesh);
    }
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
    const sound = () => sfx.configure({ sfx: on("sfx"), sfxVolume: num("sfxVolume"), ambience: on("ambience"), ambienceVolume: num("ambienceVolume") });
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
  }

  setPresets(p: BoardPreset[]) {
    this.tune.presets = p;
    this.tune.invalidate();
  }

  /** A session started: nothing in your way; the dock is on your wrist. */
  entered() {
    for (const p of this.panels) p.mesh.visible = false;
    this.captions.mesh.visible = false;
    this.captionAt.set(0, 0, 0);
    sfx.play("enter");
  }

  left() {
    for (const p of [...this.panels, this.captions]) p.mesh.visible = false;
    this.leader.visible = false;
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
        const knee = edge.clone().add(new THREE.Vector3(0, 0, 0)).lerp(c, 0.25);
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
    if (left && on("wristMenu")) {
      if (this.isHand(left)) {
        const pose = left.gest.pose;
        if (pose) {
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
    const dockHot = this.ptrs.some((p) => p.hoverPanel?.panel === this.dock || (p.press?.kind === "panel" && p.press.panel === this.dock));
    if (dockAt) this.dockShown = performance.now();
    const showDock = !!dockAt || (dockHot && performance.now() - this.dockShown < 1500);
    this.dock.mesh.visible = showDock;
    if (dockAt) {
      this.dock.mesh.position.lerp(dockAt, this.dock.mesh.userData.was ? 0.5 : 1);
      faceHead(this.dock.mesh, head);
    }
    this.dock.mesh.userData.was = showDock;

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

    // Pointed at: full strength; otherwise they step back a little.
    for (const p of this.panels) {
      const hot = this.ptrs.some((q) => q.hoverPanel?.panel === p || ((q.press?.kind === "panel" || q.press?.kind === "move") && q.press.panel === p));
      const want = hot ? 1 : num("panelOpacity");
      const mat = p.mesh.material;
      mat.opacity += (want - mat.opacity) * Math.min(1, dt * 10);
    }

    const key = `${this.ctl.tool()}|${this.ctl.voiceState()}|${this.palette.mesh.visible}|${this.tune.mesh.visible}`;
    if (key !== this.beltKey) {
      this.beltKey = key;
      this.dock.invalidate();
    }
    for (const p of [...this.panels, this.captions]) p.render();
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
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: LOOK.cyan, transparent: true, opacity: 0.55, depthTest: false, toneMapped: false }),
      );
      line.renderOrder = 30;
      ray.add(line);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.005, 12, 8), new THREE.MeshBasicMaterial({ color: LOOK.cyan, depthTest: false, toneMapped: false }));
      dot.renderOrder = 31;
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

  private isHand(p: Pointer) {
    return !!p.source?.hand;
  }

  /** Where the hand (pinch point) or the controller's tip is, in the world. */
  private tip(p: Pointer): THREE.Vector3 {
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
      if (v.dying || v.item.kind === "frame" || v.hidden) continue;
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
    for (const panel of this.panels) {
      if (!panel.mesh.visible) continue;
      const h = rc.intersectObject(panel.mesh, false)[0];
      if (h?.uv && (!best || h.distance < best.dist)) best = { panel, x: h.uv.x * panel.W, y: (1 - h.uv.y) * panel.H, dist: h.distance };
    }
    return best;
  }

  private haptic(p: Pointer, v = 0.4, ms = 30) {
    if (!on("haptics")) return;
    const g = p.source?.gamepad as (Gamepad & { hapticActuators?: { pulse: (v: number, ms: number) => void }[] }) | undefined;
    g?.hapticActuators?.[0]?.pulse(v, ms);
  }

  /** On a panel's title bar (and not on a button there): a pinch carries the panel. */
  private onHeader(ph: { panel: HoloPanel; x: number; y: number }) {
    return ph.y < ph.panel.header && !ph.panel.regionAt(ph.x, ph.y);
  }

  /* -------------------------------- presses ------------------------------ */

  private selectStart(p: Pointer) {
    if (this.scene.mode === "flat") return;
    const ph = this.panelHit(p);
    if (ph) {
      if (this.onHeader(ph)) {
        p.press = { kind: "move", panel: ph.panel, dist: ph.dist };
        sfx.play("grab");
        return;
      }
      ph.panel.pointer("down", ph.x, ph.y, `p${p.i}`);
      p.press = { kind: "panel", panel: ph.panel };
      return;
    }
    const tool = this.ctl.tool();
    if (tool === "ink") {
      p.press = { kind: "ink", pts: [this.scene.toBoard(this.tip(p))] };
      return;
    }
    // A pinch right on an item takes it in hand.
    if (this.isHand(p) && tool === "select") {
      const near = this.nearItem(p);
      const other = this.ptrs.find((q) => q !== p && q.carry);
      if (near && other?.carry?.id === near) return this.startTwo(p, other);
      if (near) return this.startCarry(p, near);
    }
    const hit = this.scene.pick(p.origin, p.dir);
    if (hit?.kind === "item") {
      if (tool === "connect") {
        p.press = { kind: "pull", from: hit.id };
        sfx.play("pick", hit.point);
        return;
      }
      const v = this.scene.views.get(hit.id)!;
      p.press = { kind: "ray", id: hit.id, dist: hit.dist, offset: new THREE.Vector3(...v.item.pos).sub(this.scene.toBoard(hit.point)), moved: false, at0: hit.point.clone() };
      this.haptic(p, 0.3, 20);
      return;
    }
    if (hit?.kind === "link") {
      this.ctl.selectLink?.(hit.id);
      sfx.play("pick", hit.point);
      return;
    }
    // Open table or air: hold to move the table (both hands to turn and scale it); a tap clears the selection.
    p.press = { kind: "empty", at0: p.origin.clone() };
    if (on("pinchMovesTable")) {
      p.grabbing = true;
      this.beginBoardGrab();
    }
  }

  private selectEnd(p: Pointer) {
    const press = p.press;
    p.press = null;
    if (this.endTwo(p)) return;
    if (p.carry) return this.endCarry(p);
    if (!press) return;
    switch (press.kind) {
      case "panel": {
        const ph = this.panelHit(p);
        press.panel.pointer("up", ph?.panel === press.panel ? ph.x : -1, ph?.panel === press.panel ? ph.y : -1, `p${p.i}`);
        return;
      }
      case "move":
        sfx.play("drop");
        return;
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
      case "pull": {
        this.scene.showPull(null);
        const hit = this.scene.pick(p.origin, p.dir, { ignore: press.from });
        if (hit?.kind === "item") {
          this.ctl.link(press.from, hit.id);
          sfx.play("snap", hit.point);
          this.haptic(p, 0.5, 40);
        }
        return;
      }
      case "ray": {
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
    // A panel under the ray: carry it.
    const ph = this.panelHit(p);
    if (ph) {
      p.press = { kind: "move", panel: ph.panel, dist: ph.dist };
      sfx.play("grab");
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
    if (p.press?.kind === "move") {
      p.press = null;
      sfx.play("drop");
      return;
    }
    if (this.endTwo(p)) return;
    if (p.carry) return this.endCarry(p);
    if (p.grabbing) {
      p.grabbing = false;
      this.beginBoardGrab();
      if (!this.ptrs.some((q) => q.grabbing)) this.scene.saveRig();
    }
  }

  /* -------------------------------- carrying ----------------------------- */

  private startCarry(p: Pointer, id: string) {
    const v = this.scene.views.get(id);
    if (!v) return;
    this.scene.rig.updateMatrixWorld();
    v.root.updateMatrixWorld();
    const offset = this.holdPose(p).invert().multiply(v.root.matrixWorld);
    p.carry = { id, offset, trail: [] };
    this.ctl.select([id]);
    sfx.play("grab", v.center());
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
    // Blocks and notes stay upright: only their turn about the vertical follows the hand.
    const upright = v.item.kind !== "holo" && v.item.kind !== "ink";
    const patch: { pos: Vec3; quat?: [number, number, number, number]; rotY?: number } = { pos: [round(pos.x), round(Math.max(0, pos.y)), round(pos.z)] };
    if (upright) patch.rotY = round(THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(quat, "YXZ").y));
    else patch.quat = [round(quat.x), round(quat.y), round(quat.z), round(quat.w)];
    this.ctl.client.hold(c.id, patch);
    const at = new THREE.Vector3().setFromMatrixPosition(world);
    c.trail.push({ t: now, at });
    while (c.trail.length > 2 && now - c.trail[0].t > 120) c.trail.shift();
  }

  private endCarry(p: Pointer) {
    const c = p.carry!;
    p.carry = null;
    // Thrown: away it goes.
    const tr = c.trail;
    if (tr.length >= 2) {
      const a = tr[0];
      const b = tr[tr.length - 1];
      const speed = b.at.distanceTo(a.at) / Math.max(0.001, (b.t - a.t) / 1000);
      if (speed > num("flingSpeed")) {
        this.ctl.client.release(c.id);
        this.ctl.remove([c.id]);
        sfx.play("fling", b.at);
        this.haptic(p, 0.8, 60);
        return;
      }
    }
    this.ctl.client.release(c.id);
    sfx.play("drop");
  }

  /**
   * A hand let go while two were on one item. The helping hand: the item stays
   * in the other, at its new size. The holding hand: it's let go as usual.
   */
  private endTwo(p: Pointer): boolean {
    if (!this.two) return false;
    const holder = this.ptrs.find((q) => q.carry?.id === this.two!.id);
    this.two = null;
    return p !== holder;
  }

  private startTwo(p: Pointer, holder: Pointer) {
    const v = this.scene.views.get(holder.carry!.id);
    if (!v) return;
    this.two = {
      id: v.id,
      d0: Math.max(0.02, this.tip(p).distanceTo(this.tip(holder))),
      scale0: v.item.scale ?? 1,
      explode0: v.item.explode ?? 0,
      holo: v.item.kind === "holo" && !!v.item.holo?.parts?.length,
    };
    p.grabbing = false;
    this.haptic(p, 0.5, 30);
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
    const dyaw = yaw1 - yaw0;
    const scale = THREE.MathUtils.clamp(g.scale * k, 0.05, 3);
    // Turn and scale about the hands' midpoint, which follows the hands.
    const rel = g.pos.clone().sub(g.mid);
    rel.applyAxisAngle(new THREE.Vector3(0, 1, 0), dyaw).multiplyScalar(scale / g.scale);
    rig.position.copy(mid).add(rel);
    rig.rotation.y = g.yaw + dyaw;
    rig.scale.setScalar(scale);
  }

  /* --------------------------------- frame ------------------------------- */

  private cancel(p: Pointer) {
    if (p.carry) this.ctl.client.release(p.carry.id);
    if (p.press?.kind === "ray" && p.press.moved) this.ctl.client.release(p.press.id);
    p.carry = null;
    p.press = null;
    p.grabbing = false;
    this.scene.showInk(null);
    this.scene.showPull(null);
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
      (p.line.material as THREE.LineBasicMaterial).opacity = num("rayBrightness");
      p.grip.visible = on("controllerModels");
      p.hand.visible = on("handModels");
      if (!connected) {
        p.dot.visible = false;
        continue;
      }

      // Hand gestures: the voice, undo.
      if (this.isHand(p)) {
        const g = p.gest.update(p.hand, now);
        if (g.middlePinch) {
          if (p.side === "left") this.ctl.toggleVoice();
          else this.ctl.client.undo();
          sfx.play("tick");
        }
      }
      this.readButtons(p, dt);

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
        rayLen = press.dist;
      } else if (press?.kind === "ray") {
        const v = this.scene.views.get(press.id);
        const tipAt = p.origin.clone().addScaledVector(p.dir, press.dist);
        if (!press.moved && tipAt.distanceTo(press.at0) > 0.015) press.moved = true;
        if (press.moved && v) {
          const local = this.scene.toBoard(tipAt).add(press.offset);
          this.ctl.client.hold(press.id, { pos: [round(local.x), round(Math.max(0, local.y)), round(local.z)] });
        }
        rayLen = press.dist;
      } else if (press?.kind === "ink") {
        const at = this.scene.toBoard(this.tip(p));
        const last = press.pts[press.pts.length - 1];
        if (at.distanceTo(last) * this.scene.rig.scale.x > 0.003) press.pts.push(at);
        this.scene.showInk(press.pts, this.ctl.inkColor());
        rayLen = 0.04;
      } else if (press?.kind === "pull") {
        const v = this.scene.views.get(press.from);
        const hit = this.scene.pick(p.origin, p.dir, { ignore: press.from });
        if (hit) rayLen = hit.dist;
        if (v) this.scene.showPull(new THREE.Vector3(...v.item.pos).setY(v.midY), this.scene.toBoard(hit?.point ?? p.origin.clone().addScaledVector(p.dir, 0.6)));
        if (hit?.kind === "item") hovered.push(hit.id);
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
          const id = hit && hit.kind !== "table" ? hit.id : null;
          if (id && id !== p.hoverItem) {
            this.haptic(p, 0.15, 12);
            sfx.play("hover", hit!.point);
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
      (p.line.material as THREE.LineBasicMaterial).color.set(this.ctl.tool() === "ink" ? this.ctl.inkColor() : this.ctl.tool() === "connect" ? LOOK.accent : LOOK.cyan);
    }

    // Two hands on one item: stretch, or pull apart.
    if (this.two) {
      const holder = this.ptrs.find((q) => q.carry?.id === this.two!.id);
      const other = this.ptrs.find((q) => q !== holder && q.source);
      if (holder && other) {
        const d = this.tip(holder).distanceTo(this.tip(other));
        const k = d / this.two.d0;
        if (this.two.holo) this.ctl.client.hold(this.two.id, { explode: round(THREE.MathUtils.clamp(this.two.explode0 + (k - 1) * 1.3, 0, 1)) });
        else this.ctl.client.hold(this.two.id, { scale: round(THREE.MathUtils.clamp(this.two.scale0 * k, 0.1, 10)) });
      }
    }

    this.moveBoard();
    this.scene.setHover(hovered);
    this.updatePanels(dt);
    sfx.listen(new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld), cam.quaternion, now);
    void t;
  }

  /** A, B, X, Y and the sticks. */
  private readButtons(p: Pointer, dt: number) {
    const g = p.source?.gamepad;
    if (!g || this.isHand(p)) return;
    const pressed = g.buttons.map((b) => b.pressed);
    const edge = (i: number) => pressed[i] && !p.buttons[i];
    if (p.side === "right") {
      if (edge(4)) this.toggle(this.palette);
      if (edge(5)) this.ctl.client.undo();
      if (edge(3)) this.scene.resetRig();
    } else if (p.side === "left") {
      if (edge(4)) this.ctl.toggleVoice();
      if (edge(5)) this.toggle(this.tune);
    }
    p.buttons = pressed;

    const sx = g.axes[2] ?? 0;
    const sy = g.axes[3] ?? 0;
    const dead = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
    const k = num("stickSpeed");
    // Dragging along the ray: the stick pushes it away or pulls it in.
    if (p.press?.kind === "ray" && dead(sy)) {
      p.press.dist = THREE.MathUtils.clamp(p.press.dist - dead(sy) * dt * k, 0.08, 6);
      p.press.moved = true;
      return;
    }
    if (p.press?.kind === "move" && dead(sy)) {
      p.press.dist = THREE.MathUtils.clamp(p.press.dist - dead(sy) * dt * k * 0.5, 0.2, 2);
      return;
    }
    const rig = this.scene.rig;
    if (p.side === "right" && (dead(sx) || dead(sy)) && !p.carry) {
      // Turn the table about its middle; scale it up and down.
      rig.rotation.y -= dead(sx) * dt * k;
      rig.scale.setScalar(THREE.MathUtils.clamp(rig.scale.x * (1 - dead(sy) * dt * 0.7 * k), 0.05, 3));
      this.dirtyRig = true;
    } else if (p.side === "left" && (dead(sx) || dead(sy))) {
      // Slide it across the room, as you face.
      const { fwd, right } = headFrame(this.scene.renderer.xr.getCamera());
      rig.position.addScaledVector(right, dead(sx) * dt * 0.7 * k).addScaledVector(fwd, -dead(sy) * dt * 0.7 * k);
      this.dirtyRig = true;
    } else if (this.dirtyRig && p.side === "right") {
      this.dirtyRig = false;
      this.scene.saveRig();
    }
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
