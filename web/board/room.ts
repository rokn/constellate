import * as THREE from "three";
import { nameOf, newId, type Board } from "../../shared/board";
import { inside } from "../xr/hands";
import { sfx } from "../xr/sound";
import { headFrame, type HoloPanel } from "./hud";
import { LOOK } from "./look";
import { Stage } from "./stage";
import { num, on, setTune } from "./tune";
import type { Pointer, XRInput, XRPlugin } from "./xr";

/**
 * The room around the board, in the headset:
 *
 *  - The walls and desks Space Setup knows (plane detection).
 *  - Where the board stands: on the holotable (table), shrunk onto your real
 *    desk with shadows (desk), standing on a wall (wall), or blown up to the
 *    room so you walk inside it (room).
 *  - Throw a panel at a wall and it sticks there; throw an item with an inside
 *    at a wall and its board stands there.
 *  - Anchors: the table, and every board you stood in the room, stay where
 *    you left them, across sessions.
 *  - A room of boards: other boards stand around you, live. Walk up to one
 *    (or pinch its table) to use it; links can run from one board to another.
 *  - Levels: scale the table up past twice its size over an item and you
 *    dive inside it; down past half and you come back out.
 */

type Plane = { plane: XRPlane; matrix: THREE.Matrix4; normal: THREE.Vector3; center: THREE.Vector3; polygon: [number, number][]; vertical: boolean; label: string; size: [number, number] };
type Placed = { boardId: string; pos: THREE.Vector3; quat: THREE.Quaternion; scale: number; wall?: boolean; anchor?: string };
type Sat = Placed & { stage: Stage };
type Mode = "table" | "desk" | "wall" | "room";

const ROOM_KEY = "workshop.room";
const MAIN_ANCHOR_KEY = "workshop.anchor.main";

export class RoomXR implements XRPlugin {
  private planes: Plane[] = [];
  private planeLines = new THREE.Group();
  mode: Mode = "table";
  /** The table's pose before desk, wall or room mode: where "table mode" puts it back. */
  private tablePose: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number } | null = null;
  private tween: { t0: number; ms: number; from: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number }; to: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number } } | null = null;
  private sats: Sat[] = [];
  private xlines = new THREE.Group();
  private xkey = "";
  private reanchor = false;
  private mainAnchor: { space: XRSpace; uuid?: string } | null = null;
  private restoring = false;
  private lastAuto = 0;
  private zoom: { scale0: number; fired: boolean; dy0: number; gap0: number } | null = null;
  private off: () => void;

  constructor(
    private xr: XRInput,
    private o: { boardOf: () => Board | null; open: (id: string) => void; inside: (id: string) => void; up: () => void; boards: () => { id: string; name: string }[] },
  ) {
    const s = xr.scene;
    s.overlay.add(this.planeLines);
    s.scene.add(this.xlines);
    this.off = s.onFrame((t, dt, frame) => this.tick(t, dt, frame));
    s.onRigSaved = () => {
      if (this.mode === "table") this.reanchor = true;
    };
  }

  dispose() {
    this.off();
    for (const s of this.sats) s.stage.dispose();
  }

  entered() {
    this.mode = "table";
    this.tablePose = null;
    this.restoring = true;
    this.loadRoom();
  }

  left() {
    for (const s of this.sats) s.stage.dispose();
    this.sats = [];
    this.mainAnchor = null;
    this.planes = [];
    this.planeLines.clear();
    this.xlines.clear();
    this.xr.scene.shadowsOn = false;
    this.xr.boardTurns = true;
  }

  /* -------------------------------- actions ------------------------------ */

  handle(action: string, p?: Pointer): boolean {
    switch (action) {
      case "desk-mode":
        this.toDesk(p);
        return true;
      case "wall-mode":
        this.toWall(p);
        return true;
      case "room-scale":
        if (this.mode === "room") this.toTable();
        else this.toRoom();
        return true;
      case "table-mode":
        this.toTable();
        return true;
      case "recenter":
        if (this.mode !== "table") this.toTable();
        else this.xr.scene.resetRig();
        return true;
      case "place-board":
        this.placeCurrent();
        return true;
      case "tiers":
        this.xr.scene.tiersOn = !this.xr.scene.tiersOn;
        this.xr.say(this.xr.scene.tiersOn ? "Depth tiers" : "Tiers flat", p);
        return true;
    }
    return false;
  }

  /* ------------------------------- the planes ---------------------------- */

  private readPlanes(frame: XRFrame) {
    const ref = this.xr.scene.renderer.xr.getReferenceSpace();
    const set = (frame as XRFrame & { detectedPlanes?: Set<XRPlane> }).detectedPlanes;
    if (!ref || !set) return;
    const out: Plane[] = [];
    for (const plane of set) {
      const pose = frame.getPose(plane.planeSpace, ref);
      if (!pose) continue;
      const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const polygon = plane.polygon.map((pt) => [pt.x, pt.z] as [number, number]);
      const xs = polygon.map((q) => q[0]);
      const zs = polygon.map((q) => q[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      out.push({
        plane,
        matrix,
        normal: new THREE.Vector3(0, 1, 0).transformDirection(matrix),
        center: new THREE.Vector3(cx, 0, cz).applyMatrix4(matrix),
        polygon,
        vertical: plane.orientation === "vertical",
        label: (plane as XRPlane & { semanticLabel?: string }).semanticLabel ?? "",
        size: [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)],
      });
    }
    const changed = out.length !== this.planes.length;
    this.planes = out;
    if (changed || on("showPlanes") !== this.planeLines.visible) this.drawPlanes();
  }

  private drawPlanes() {
    this.planeLines.clear();
    this.planeLines.visible = on("showPlanes");
    if (!this.planeLines.visible) return;
    for (const p of this.planes) {
      const pts = p.polygon.map(([x, z]) => new THREE.Vector3(x, 0.002, z).applyMatrix4(p.matrix));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: p.vertical ? LOOK.accent : LOOK.cyan, transparent: true, opacity: 0.5, toneMapped: false }));
      this.planeLines.add(line);
    }
  }

  /** Where a ray (world) meets a wall (or any plane that passes the test), nearest first. */
  private hitPlane(origin: THREE.Vector3, dir: THREE.Vector3, want: (p: Plane) => boolean, far = 6): { plane: Plane; point: THREE.Vector3 } | null {
    let best: { plane: Plane; point: THREE.Vector3; d: number } | null = null;
    for (const p of this.planes) {
      if (!want(p)) continue;
      const denom = p.normal.dot(dir);
      if (Math.abs(denom) < 1e-4) continue;
      const d = p.center.clone().sub(origin).dot(p.normal) / denom;
      if (d < 0 || d > far) continue;
      const point = origin.clone().addScaledVector(dir, d);
      const local = point.clone().applyMatrix4(p.matrix.clone().invert());
      if (!inside(local.x, local.z, p.polygon)) continue;
      if (!best || d < best.d) best = { plane: p, point, d };
    }
    return best;
  }

  /* --------------------------------- modes ------------------------------- */

  private rigNow() {
    const r = this.xr.scene.rig;
    return { pos: r.position.clone(), quat: r.quaternion.clone(), scale: r.scale.x };
  }

  private moveRig(to: { pos: THREE.Vector3; quat: THREE.Quaternion; scale: number }, ms = 650) {
    this.tween = { t0: performance.now(), ms, from: this.rigNow(), to };
    sfx.play("place");
  }

  private enterMode(m: Mode) {
    if (this.mode === "table" && m !== "table") this.tablePose = this.rigNow();
    this.mode = m;
    this.xr.scene.shadowsOn = m === "desk";
    this.xr.boardTurns = m !== "wall";
    this.xr.scene.rigMode = m;
  }

  /** Onto your real desk: the table Space Setup knows nearest where you look, the board fitted to it. */
  private toDesk(p?: Pointer) {
    const cam = this.xr.scene.renderer.xr.getCamera();
    const { head, fwd } = headFrame(cam);
    const look = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
    const origin = p?.source ? p.origin : head;
    const dir = p?.source ? p.dir : look;
    let hit = this.hitPlane(origin, dir, (q) => !q.vertical && q.normal.y > 0.8 && q.center.y > 0.3 && q.center.y < head.y - 0.15);
    // Not pointed at one: the desk-like plane nearest in front of you.
    const desks = this.planes.filter((q) => !q.vertical && q.normal.y > 0.8 && q.center.y > 0.45 && q.center.y < 1.3);
    if (!hit && desks.length) {
      const d = desks.sort((a, b) => a.center.distanceTo(head) - b.center.distanceTo(head) + (b.label === "table" ? 0.3 : 0) - (a.label === "table" ? 0.3 : 0))[0];
      hit = { plane: d, point: d.center.clone() };
    }
    let pos: THREE.Vector3;
    let scale: number;
    if (hit) {
      const fit = Math.min(hit.plane.size[0], hit.plane.size[1]) / 2;
      scale = THREE.MathUtils.clamp((fit * num("deskFit")) / 1.45, 0.08, 0.6);
      // Its middle, or where you pointed if that's well inside.
      pos = hit.point.clone().setY(hit.plane.center.y + 0.003);
    } else {
      // No desk known: the table where it is, a desk's height, smaller.
      pos = head.clone().addScaledVector(fwd, 0.55).setY(Math.max(0.6, head.y - 0.55));
      scale = 0.22;
      this.xr.say("No desk found: run Space Setup", p);
    }
    const yaw = Math.atan2(head.x - pos.x, head.z - pos.z);
    this.enterMode("desk");
    this.moveRig({ pos, quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), scale });
  }

  /** Up on a wall: where you point (or look), facing out of it, the table's front at the bottom. */
  private toWall(p?: Pointer) {
    const cam = this.xr.scene.renderer.xr.getCamera();
    const { head, fwd } = headFrame(cam);
    const origin = p?.source ? p.origin : head;
    const dir = p?.source ? p.dir : new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
    const hit = this.hitPlane(origin, dir, (q) => q.vertical) ?? this.hitPlane(head, fwd, (q) => q.vertical);
    const n = hit ? hit.plane.normal.clone() : fwd.clone().negate();
    // The wall's normal faces into the room: toward you.
    if (n.dot(head.clone().sub(hit?.point ?? head)) < 0) n.negate();
    n.y = 0;
    n.normalize();
    const at = hit ? hit.point.clone() : head.clone().addScaledVector(fwd, 1.1);
    at.y = THREE.MathUtils.clamp(head.y - 0.1, 0.9, 2);
    this.enterMode("wall");
    this.moveRig({ pos: at.addScaledVector(n, 0.015), quat: wallQuat(n), scale: num("wallScale") });
    if (!hit) this.xr.say("No wall found: standing it before you", p);
  }

  /** Blown up to the room: on the floor, under where it stood, so you walk inside it. */
  private toRoom() {
    const r = this.rigNow();
    const yaw = new THREE.Euler().setFromQuaternion(r.quat, "YXZ").y;
    this.enterMode("room");
    this.moveRig({ pos: new THREE.Vector3(r.pos.x, 0.01, r.pos.z), quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), scale: num("roomScale") }, 900);
  }

  private toTable() {
    const back = this.tablePose;
    this.enterMode("table");
    if (back) this.moveRig(back);
    else this.xr.scene.resetRig();
    this.tablePose = null;
  }

  /* -------------------------------- throws ------------------------------- */

  throwPanel(panel: HoloPanel, at: THREE.Vector3, vel: THREE.Vector3): boolean {
    const hit = this.hitPlane(at, vel.clone().normalize(), (q) => q.vertical, 5);
    if (!hit) return false;
    const n = hit.plane.normal.clone();
    if (n.dot(at.clone().sub(hit.point)) < 0) n.negate();
    panel.mesh.position.copy(hit.point).addScaledVector(n, 0.01);
    panel.mesh.lookAt(hit.point.clone().addScaledVector(n, 1));
    panel.pinned = true;
    sfx.play("snap", hit.point);
    return true;
  }

  /** An item with an inside, thrown at a wall: its board stands there. */
  throwItem(id: string, at: THREE.Vector3, vel: THREE.Vector3): boolean {
    const it = this.o.boardOf()?.items.find((i) => i.id === id);
    if (!it?.sub) return false;
    const hit = this.hitPlane(at, vel.clone().normalize(), (q) => q.vertical, 6);
    if (!hit) return false;
    const n = hit.plane.normal.clone();
    if (n.dot(at.clone().sub(hit.point)) < 0) n.negate();
    n.y = 0;
    n.normalize();
    this.addSat({ boardId: it.sub, pos: hit.point.clone().addScaledVector(n, 0.015), quat: wallQuat(n), scale: num("wallScale") * 0.8, wall: true });
    sfx.play("snap", hit.point);
    this.xr.say(`${nameOf(it)} on the wall`);
    return true;
  }

  /* ------------------------------ the room ------------------------------- */

  /** A board stood in the room where you put it (from the shelf). */
  placeBoard(boardId: string, at: THREE.Vector3, wall = false) {
    if (boardId === this.o.boardOf()?.id || this.sats.some((s) => s.boardId === boardId)) return;
    const head = new THREE.Vector3().setFromMatrixPosition(this.xr.scene.renderer.xr.getCamera().matrixWorld);
    const yaw = Math.atan2(head.x - at.x, head.z - at.z);
    const pos = at.clone();
    if (!wall) pos.y = THREE.MathUtils.clamp(pos.y, 0.5, 1.2);
    this.addSat({ boardId, pos, quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), scale: Math.min(0.45, this.xr.scene.rig.scale.x) });
    sfx.play("place", at);
  }

  /** A board thrown at a wall (from the shelf): it stands there. False when there's no wall that way. */
  placeOnWall(boardId: string, at: THREE.Vector3, vel: THREE.Vector3): boolean {
    const hit = this.hitPlane(at, vel.clone().normalize(), (q) => q.vertical, 6);
    if (!hit || boardId === this.o.boardOf()?.id || this.sats.some((s) => s.boardId === boardId)) return false;
    const n = hit.plane.normal.clone();
    if (n.dot(at.clone().sub(hit.point)) < 0) n.negate();
    n.y = 0;
    n.normalize();
    this.addSat({ boardId, pos: hit.point.clone().addScaledVector(n, 0.015), quat: wallQuat(n), scale: num("wallScale") * 0.8, wall: true });
    sfx.play("snap", hit.point);
    return true;
  }

  /** This board steps aside into the room, where it stands; the next one takes the table. */
  private placeCurrent() {
    const b = this.o.boardOf();
    if (!b) return;
    const list = this.o.boards().filter((x) => x.id !== b.id && !this.sats.some((s) => s.boardId === x.id));
    const r = this.rigNow();
    const { right } = headFrame(this.xr.scene.renderer.xr.getCamera());
    this.addSat({ boardId: b.id, pos: r.pos.clone().addScaledVector(right, -1.6 * Math.max(0.5, r.scale)), quat: r.quat, scale: r.scale });
    if (list[0]) this.o.open(list[0].id);
    this.xr.say(`${b.name} stands aside`);
  }

  private addSat(p: Placed) {
    const stage = new Stage(p.boardId);
    stage.group.position.copy(p.pos);
    stage.group.quaternion.copy(p.quat);
    stage.group.scale.setScalar(p.scale);
    this.xr.scene.stages.add(stage.group);
    this.sats.push({ ...p, stage });
    this.saveRoom();
  }

  private removeSat(s: Sat) {
    s.stage.dispose();
    this.sats = this.sats.filter((x) => x !== s);
    this.saveRoom();
  }

  /** Use another board: it and the one on the table swap places and parts. */
  activate(s: Sat) {
    const b = this.o.boardOf();
    const rig = this.xr.scene.rig;
    const was = { pos: rig.position.clone(), quat: rig.quaternion.clone(), scale: rig.scale.x };
    rig.position.copy(s.stage.group.position);
    rig.quaternion.copy(s.stage.group.quaternion);
    rig.scale.setScalar(s.stage.group.scale.x);
    this.removeSat(s);
    if (b) this.addSat({ boardId: b.id, pos: was.pos, quat: was.quat, scale: was.scale, wall: this.mode === "wall" });
    this.enterMode(s.wall ? "wall" : "table");
    this.o.open(s.boardId);
    this.lastAuto = performance.now();
    sfx.play("focus");
  }

  private saveRoom() {
    try {
      const list = this.sats.map((s) => ({ boardId: s.boardId, pos: s.stage.group.position.toArray().map(r3), quat: s.stage.group.quaternion.toArray().map(r3), scale: r3(s.stage.group.scale.x), wall: s.wall }));
      localStorage.setItem(ROOM_KEY, JSON.stringify(list));
    } catch {
      /* not kept */
    }
  }

  private loadRoom() {
    try {
      const list = JSON.parse(localStorage.getItem(ROOM_KEY) ?? "[]") as { boardId: string; pos: number[]; quat: number[]; scale: number; wall?: boolean }[];
      const known = new Set(this.o.boards().map((b) => b.id));
      for (const s of list) {
        if (!known.has(s.boardId) || s.boardId === this.o.boardOf()?.id) continue;
        this.addSat({ boardId: s.boardId, pos: new THREE.Vector3().fromArray(s.pos), quat: new THREE.Quaternion().fromArray(s.quat), scale: s.scale, wall: s.wall });
      }
    } catch {
      /* a fresh room */
    }
  }

  /** Pinch a board standing in the room: use it. With the connect tool, the far end of a link. */
  press(p: Pointer, kind: "select" | "squeeze"): boolean {
    if (kind !== "select" || !this.sats.length) return false;
    const main = this.xr.scene.pick(p.origin, p.dir);
    for (const s of this.sats) {
      const hit = s.stage.pick(p.origin, p.dir);
      if (!hit || (main && main.dist < hit.dist)) continue;
      if (this.xr.ctl.tool() === "connect") return false;
      this.activate(s);
      return true;
    }
    return false;
  }

  /** The connect tool let go over an item on another board: a link across. */
  linkAcross(from: string, origin: THREE.Vector3, dir: THREE.Vector3): boolean {
    for (const s of this.sats) {
      const hit = s.stage.pick(origin, dir);
      if (hit?.kind !== "item" || !hit.id) continue;
      this.xr.ctl.client.apply([{ op: "xlink", links: [{ id: newId("x"), from, board: s.boardId, to: hit.id }] }]);
      sfx.play("snap", hit.point);
      return true;
    }
    return false;
  }

  /** Links that span boards: an arc of light from the item here to the one over there. */
  private drawXLinks() {
    const b = this.o.boardOf();
    const shown = new Map(this.sats.map((s) => [s.boardId, s.stage]));
    const lines: [THREE.Vector3, THREE.Vector3][] = [];
    const add = (from: THREE.Vector3 | null, to: THREE.Vector3 | null) => from && to && lines.push([from, to]);
    for (const x of b?.xlinks ?? []) add(this.xr.scene.views.get(x.from)?.center() ?? null, shown.get(x.board)?.itemAt(x.to) ?? null);
    for (const s of this.sats) {
      for (const x of s.stage.board?.xlinks ?? []) {
        const there = x.board === b?.id ? this.xr.scene.views.get(x.to)?.center() ?? null : shown.get(x.board)?.itemAt(x.to) ?? null;
        add(s.stage.itemAt(x.from), there);
      }
    }
    const key = lines.map(([a, c]) => `${a.toArray().map(r3)}${c.toArray().map(r3)}`).join("|");
    if (key === this.xkey) return;
    this.xkey = key;
    this.xlines.clear();
    for (const [a, c] of lines) {
      const mid = a.clone().lerp(c, 0.5).add(new THREE.Vector3(0, 0.25 + a.distanceTo(c) * 0.15, 0));
      const pts = new THREE.QuadraticBezierCurve3(a, mid, c).getPoints(48);
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: LOOK.accent, dashSize: 0.04, gapSize: 0.025, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      l.computeLineDistances();
      l.frustumCulled = false;
      this.xlines.add(l);
    }
  }

  /* --------------------------------- frame ------------------------------- */

  private tick(t: number, dt: number, frame?: XRFrame) {
    const scene = this.xr.scene;
    if (scene.mode === "flat") return;
    const now = performance.now();
    if (frame) {
      if (on("planes")) this.readPlanes(frame);
      void this.anchors(frame);
    }
    if (this.tween) {
      const k = Math.min(1, (now - this.tween.t0) / this.tween.ms);
      const e = 1 - Math.pow(1 - k, 3);
      const r = scene.rig;
      r.position.lerpVectors(this.tween.from.pos, this.tween.to.pos, e);
      r.quaternion.slerpQuaternions(this.tween.from.quat, this.tween.to.quat, e);
      r.scale.setScalar(THREE.MathUtils.lerp(this.tween.from.scale, this.tween.to.scale, e));
      if (k >= 1) this.tween = null;
    }
    for (const s of this.sats) {
      s.stage.dimLevel = num("satelliteDim");
      s.stage.tick(t, dt);
    }
    if (this.sats.length) this.drawXLinks();
    else if (this.xlines.children.length) (this.xlines.clear(), (this.xkey = ""));

    // Walk up to another board: it's the one you use.
    if (this.sats.length && on("autoActivate") && now - this.lastAuto > 2500 && !this.xr.ptrs.some((p) => p.press || p.carry || p.grabbing)) {
      const head = new THREE.Vector3().setFromMatrixPosition(scene.renderer.xr.getCamera().matrixWorld).setY(0);
      const dMain = head.distanceTo(scene.rig.position.clone().setY(0));
      for (const s of this.sats) {
        const d = head.distanceTo(s.stage.group.position.clone().setY(0));
        if (d < 0.9 && d < dMain - 0.5) {
          this.activate(s);
          break;
        }
      }
    }

    this.levels(dt);
  }

  /** Scaling the table up over an item dives inside it; down, back out. Tiers spread with the hands, too. */
  private levels(_dt: number) {
    const scene = this.xr.scene;
    const grabbing = this.xr.ptrs.filter((p) => p.grabbing);
    if (grabbing.length < 2) {
      this.zoom = null;
      return;
    }
    const a = this.xr.tip(grabbing[0]);
    const b = this.xr.tip(grabbing[1]);
    if (!this.zoom) {
      this.zoom = { scale0: scene.rig.scale.x, fired: false, dy0: Math.max(0.03, Math.abs(a.y - b.y)), gap0: num("tierGap") };
      return;
    }
    const z = this.zoom;
    if (scene.tiersOn) {
      const k = Math.abs(a.y - b.y) / z.dy0;
      if (Math.abs(k - 1) > 0.15) setTune({ tierGap: Math.round(THREE.MathUtils.clamp(z.gap0 * k, 0.05, 0.6) * 100) / 100 });
    }
    if (!on("c4Zoom") || z.fired) return;
    const k = scene.rig.scale.x / z.scale0;
    const mid = scene.toBoard(a.clone().lerp(b, 0.5));
    if (k > 2.3) {
      // The item nearest the hands' middle: inside it.
      let best: { id: string; d: number } | null = null;
      for (const v of scene.views.values()) {
        if (v.dying || v.hidden || ["frame", "ink", "text"].includes(v.item.kind)) continue;
        const d = Math.hypot(v.item.pos[0] - mid.x, v.item.pos[2] - mid.z);
        if (d < 0.35 && (!best || d < best.d)) best = { id: v.id, d };
      }
      if (best) {
        z.fired = true;
        this.letGo(z.scale0);
        this.o.inside(best.id);
      }
    } else if (k < 0.45 && this.o.boardOf()?.parent) {
      z.fired = true;
      this.letGo(z.scale0);
      this.o.up();
    }
  }

  /** Let go of the table (both hands), back at the size it was. */
  private letGo(scale: number) {
    for (const p of this.xr.ptrs) {
      p.grabbing = false;
      if (p.press?.kind === "empty") p.press = null;
    }
    this.xr.scene.rig.scale.setScalar(scale);
    sfx.play("focus");
  }

  /* -------------------------------- anchors ------------------------------ */

  /**
   * The table's anchor: restored when you come back (it stands where you left
   * it), made again whenever you move it by hand. Persistent where the
   * browser can (Quest), for this session where it can't.
   */
  private async anchors(frame: XRFrame) {
    if (!on("roomAnchors")) return;
    const session = this.xr.scene.session as (XRSession & AnchorSession) | null;
    const ref = this.xr.scene.renderer.xr.getReferenceSpace();
    if (!session || !ref) return;
    if (this.restoring) {
      this.restoring = false;
      const uuid = safeGet(MAIN_ANCHOR_KEY);
      if (uuid && session.restorePersistentAnchor) {
        session
          .restorePersistentAnchor(uuid)
          .then((a) => (this.mainAnchor = { space: a.anchorSpace, uuid }))
          .catch(() => {});
      }
      return;
    }
    if (this.reanchor && (frame as XRFrame & AnchorFrame).createAnchor) {
      this.reanchor = false;
      const r = this.xr.scene.rig;
      const pose = new XRRigidTransform({ x: r.position.x, y: r.position.y, z: r.position.z }, { x: r.quaternion.x, y: r.quaternion.y, z: r.quaternion.z, w: r.quaternion.w });
      const old = this.mainAnchor?.uuid;
      try {
        const a = await (frame as XRFrame & AnchorFrame).createAnchor!(pose, ref);
        this.mainAnchor = { space: a.anchorSpace };
        if (a.requestPersistentHandle) {
          const uuid = await a.requestPersistentHandle();
          this.mainAnchor.uuid = uuid;
          localStorage.setItem(MAIN_ANCHOR_KEY, uuid);
          if (old && old !== uuid) void session.deletePersistentAnchor?.(old).catch(() => {});
        }
      } catch {
        /* anchors refused: the saved pose still holds */
      }
      return;
    }
    // Held to the anchor while nobody's moving the table.
    if (this.mainAnchor && this.mode === "table" && !this.tween && !this.xr.ptrs.some((p) => p.grabbing)) {
      const pose = frame.getPose(this.mainAnchor.space, ref);
      if (pose) {
        const r = this.xr.scene.rig;
        const p = pose.transform.position;
        const q = pose.transform.orientation;
        r.position.set(p.x, p.y, p.z);
        r.quaternion.set(q.x, q.y, q.z, q.w);
      }
    }
  }
}

type AnchorLike = { anchorSpace: XRSpace; requestPersistentHandle?: () => Promise<string> };
type AnchorFrame = { createAnchor?: (pose: XRRigidTransform, space: XRSpace) => Promise<AnchorLike> };
type AnchorSession = { restorePersistentAnchor?: (uuid: string) => Promise<AnchorLike>; deletePersistentAnchor?: (uuid: string) => Promise<void> };

/** A board stood on a wall: its up out of the wall, its front (toward you on the table) at the bottom. */
function wallQuat(n: THREE.Vector3) {
  const Y = n.clone().normalize();
  const Z = new THREE.Vector3(0, -1, 0);
  const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  Z.crossVectors(X, Y).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
