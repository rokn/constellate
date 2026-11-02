import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { Board, ItemKind, Vec3 } from "../../shared/board";
import { HandGestures } from "../xr/hands";
import { sfx } from "../xr/sound";
import type { Panel } from "../xr/ui";
import type { Ctl } from "./ctl";
import { Inspector, Strip, Toolbelt, placeBeforeHead } from "./hud";
import { LOOK } from "./look";
import type { BoardScene } from "./scene";

/**
 * Hands and controllers in the workshop.
 *
 *  - Point and pinch (or pull the trigger): on an item, select it, and keep
 *    holding to drag it along the ray (the thumbstick pushes it away or pulls
 *    it in); on open table, let go to clear the selection.
 *  - Grab (grip, or a pinch right on it): carry an item in your hand, turned
 *    as your hand turns. Throw it away to delete it.
 *  - Both hands on one item: stretch it bigger — or, a hologram, pull it
 *    apart.
 *  - Grab open air with one hand to move the whole table; with both, turn
 *    and scale it.
 *  - The connect tool: pinch on one item, let go on another. The ink tool:
 *    pinch and draw in the air.
 *
 * Buttons: A the toolbelt, B undo, X voice, Y redo. Hands: palm up (left)
 * for the toolbelt, left middle-finger pinch for the voice, right one undo.
 */

type Press =
  | { kind: "panel"; panel: Panel }
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
  hoverPanel: { panel: Panel; x: number; y: number } | null;
  hoverItem: string | null;
  press: Press | null;
  carry: Carry | null;
  /** Gripping open air: moving the table. */
  grabbing: boolean;
  buttons: boolean[];
};

const FLING = 2.4;
const NEAR = 0.06;

export class XRInput {
  private ptrs: Pointer[] = [];
  private toolbelt: Toolbelt;
  private inspector: Inspector;
  private strip: Strip;
  private panels: Panel[];
  private beltOpen = false;
  private boardGrab: { a: THREE.Vector3; b: THREE.Vector3 | null; pos: THREE.Vector3; yaw: number; scale: number; mid: THREE.Vector3 } | null = null;
  private two: { id: string; d0: number; scale0: number; explode0: number; holo: boolean } | null = null;
  private stripAt = new THREE.Vector3();
  private off: () => void;

  constructor(
    private scene: BoardScene,
    private ctl: Ctl,
    activity: () => Board["activity"],
  ) {
    this.toolbelt = new Toolbelt(ctl, {
      spawn: (k) => this.spawn(k),
      reset: () => scene.resetRig(),
      exit: () => scene.exit(),
      close: () => this.setBelt(false),
    });
    this.inspector = new Inspector(ctl);
    this.strip = new Strip(ctl, activity);
    this.panels = [this.toolbelt, this.inspector, this.strip];
    for (const p of this.panels) scene.overlay.add(p.mesh);
    this.setup();
    this.off = scene.onFrame((t, dt) => this.frame(t, dt));
  }

  dispose() {
    this.off();
  }

  /** Called when a session starts: panels in front of you, the strip under your gaze. */
  entered() {
    this.setBelt(false);
    this.strip.mesh.visible = true;
    this.stripAt.set(0, 0, 0);
    sfx.play("enter");
  }

  left() {
    for (const p of this.panels) p.mesh.visible = false;
    sfx.stop();
  }

  private setBelt(open: boolean) {
    this.beltOpen = open;
    const cam = this.scene.renderer.xr.getCamera();
    this.toolbelt.mesh.visible = open;
    this.inspector.mesh.visible = open;
    if (open) {
      placeBeforeHead(this.toolbelt, cam, { dist: 0.55, drop: 0.3, side: -0.24 });
      placeBeforeHead(this.inspector, cam, { dist: 0.55, drop: 0.3, side: 0.24 });
      this.toolbelt.invalidate();
      this.inspector.invalidate();
      sfx.play("pick");
    }
  }

  /** A component from the toolbelt: on the table where you're looking. */
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
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), new THREE.MeshBasicMaterial({ color: LOOK.cyan, depthTest: false, toneMapped: false }));
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

  /** The item within reach of this hand, if any (for grabbing it directly). */
  private nearItem(p: Pointer): string | null {
    const at = this.isHand(p) ? this.tip(p) : new THREE.Vector3().setFromMatrixPosition(p.grip.matrixWorld);
    let best: string | null = null;
    let bestD = Infinity;
    const s = this.scene.rig.scale.x;
    for (const v of this.scene.views.values()) {
      if (v.dying || v.item.kind === "frame") continue;
      const d = v.center().distanceTo(at) - v.radius * v.root.scale.x * s;
      if (d < NEAR && d < bestD) {
        best = v.id;
        bestD = d;
      }
    }
    return best;
  }

  private panelHit(p: Pointer): { panel: Panel; x: number; y: number; dist: number } | null {
    const rc = new THREE.Raycaster(p.origin, p.dir, 0, 5);
    let best: { panel: Panel; x: number; y: number; dist: number } | null = null;
    for (const panel of this.panels) {
      if (!panel.mesh.visible) continue;
      const h = rc.intersectObject(panel.mesh, false)[0];
      if (h?.uv && (!best || h.distance < best.dist)) best = { panel, x: h.uv.x * panel.W, y: (1 - h.uv.y) * panel.H, dist: h.distance };
    }
    return best;
  }

  private haptic(p: Pointer, v = 0.4, ms = 30) {
    const g = p.source?.gamepad as (Gamepad & { hapticActuators?: { pulse: (v: number, ms: number) => void }[] }) | undefined;
    g?.hapticActuators?.[0]?.pulse(v, ms);
  }

  /* -------------------------------- presses ------------------------------ */

  private selectStart(p: Pointer) {
    if (this.scene.mode === "flat") return;
    const ph = this.panelHit(p);
    if (ph) {
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
    // Open table or air: hold to move the table (both hands to turn and scale it); a tap clears the selection.
    p.press = { kind: "empty", at0: p.origin.clone() };
    p.grabbing = true;
    this.beginBoardGrab();
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
        p.grabbing = false;
        this.beginBoardGrab();
        if (p.origin.distanceTo(press.at0) < 0.03) this.ctl.select([]);
        else this.scene.saveRig();
        return;
    }
  }

  private squeezeStart(p: Pointer) {
    if (this.scene.mode === "flat") return;
    // Already carrying with the other hand: this one joins in on the same item.
    const other = this.ptrs.find((q) => q !== p && q.carry);
    const near = this.nearItem(p);
    const hit = this.scene.pick(p.origin, p.dir);
    const target = near ?? (hit?.kind === "item" ? hit.id : null);
    if (other && target === other.carry!.id) return this.startTwo(p, other);
    if (target) return this.startCarry(p, target);
    // Open air: the table.
    p.grabbing = true;
    this.beginBoardGrab();
  }

  private squeezeEnd(p: Pointer) {
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
      if (speed > FLING) {
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
      p.line.visible = connected;
      if (!connected) {
        p.dot.visible = false;
        continue;
      }

      // Hand gestures: the wrist menu, voice, undo.
      if (this.isHand(p)) {
        const g = p.gest.update(p.hand, now);
        if (g.middlePinch) {
          if (p.side === "left") this.ctl.toggleVoice();
          else this.ctl.client.undo();
          sfx.play("tick");
        }
        // Turning the left palm up opens the toolbelt, or closes it if it's open.
        if (p.side === "left") {
          if (p.gest.palmUp && !this.palmWas) this.setBelt(!this.beltOpen);
          this.palmWas = p.gest.palmUp;
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
      const hs = this.ptrs.filter((q) => q.carry?.id === this.two!.id || q.source);
      const holder = this.ptrs.find((q) => q.carry?.id === this.two!.id);
      const other = this.ptrs.find((q) => q !== holder && q.source);
      if (holder && other && hs.length >= 1) {
        const d = this.tip(holder).distanceTo(this.tip(other));
        const k = d / this.two.d0;
        if (this.two.holo) this.ctl.client.hold(this.two.id, { explode: round(THREE.MathUtils.clamp(this.two.explode0 + (k - 1) * 1.3, 0, 1)) });
        else this.ctl.client.hold(this.two.id, { scale: round(THREE.MathUtils.clamp(this.two.scale0 * k, 0.1, 10)) });
      }
    }

    this.moveBoard();
    this.scene.setHover(hovered);

    // The strip follows your gaze lazily, low and out of the way.
    const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld).setY(0).normalize();
    const want = head.clone().addScaledVector(fwd, 0.8).setY(head.y - 0.38);
    if (this.stripAt.lengthSq() === 0 || this.stripAt.distanceTo(want) > 0.5) this.stripAt.copy(want);
    else this.stripAt.lerp(want, Math.min(1, dt * 1.5));
    this.strip.mesh.position.copy(this.stripAt);
    this.strip.mesh.lookAt(head.x, this.stripAt.y + 0.2, head.z);
    this.strip.refresh();

    this.inspector.set(this.ctl.client.board, this.ctl.selected());
    for (const panel of this.panels) panel.render();
    // The toolbelt shows the tool and the voice: repainted when either changes.
    const beltKey = `${this.ctl.tool()}|${this.ctl.voiceState()}`;
    if (beltKey !== this.beltKey) {
      this.beltKey = beltKey;
      this.toolbelt.invalidate();
    }
    sfx.listen(head, cam.quaternion, now);
  }

  /** A, B, X, Y and the right stick. */
  private readButtons(p: Pointer, dt: number) {
    const g = p.source?.gamepad;
    if (!g || this.isHand(p)) return;
    const pressed = g.buttons.map((b) => b.pressed);
    const edge = (i: number) => pressed[i] && !p.buttons[i];
    if (p.side === "right") {
      if (edge(4)) this.setBelt(!this.beltOpen);
      if (edge(5)) this.ctl.client.undo();
      if (edge(3)) this.scene.resetRig();
    } else if (p.side === "left") {
      if (edge(4)) this.ctl.toggleVoice();
      if (edge(5)) this.ctl.client.redo();
    }
    p.buttons = pressed;

    const sx = g.axes[2] ?? 0;
    const sy = g.axes[3] ?? 0;
    const dead = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
    // Dragging along the ray: the stick pushes it away or pulls it in.
    if (p.press?.kind === "ray" && dead(sy)) {
      p.press.dist = THREE.MathUtils.clamp(p.press.dist - dead(sy) * dt * 1.2, 0.08, 6);
      p.press.moved = true;
      return;
    }
    const rig = this.scene.rig;
    if (p.side === "right" && (dead(sx) || dead(sy)) && !p.carry) {
      // Turn the table about its middle; scale it up and down.
      rig.rotation.y -= dead(sx) * dt * 1.2;
      rig.scale.setScalar(THREE.MathUtils.clamp(rig.scale.x * (1 - dead(sy) * dt * 0.8), 0.05, 3));
      this.dirtyRig = true;
    } else if (p.side === "left" && (dead(sx) || dead(sy))) {
      // Slide it across the room, as you face.
      const cam = this.scene.renderer.xr.getCamera();
      const fwd = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld).setY(0).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
      rig.position.addScaledVector(right, dead(sx) * dt * 0.8).addScaledVector(fwd, -dead(sy) * dt * 0.8);
      this.dirtyRig = true;
    } else if (this.dirtyRig && p.side === "right") {
      this.dirtyRig = false;
      this.scene.saveRig();
    }
  }
  private dirtyRig = false;
  private beltKey = "";
  private palmWas = false;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
