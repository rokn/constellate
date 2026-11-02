import * as THREE from "three";
import type { Board } from "../../shared/board";
import { BoardClient } from "./client";
import { ItemView } from "./items";
import { LinkView } from "./links";
import { LOOK, labelSprite, makeTable } from "./look";

/**
 * A board drawn on its own: another board standing in the room beside the
 * one you're editing, live (its own stream), dimmed a little, on its own
 * small holotable with its name over it. Picked to be used, or as the far
 * end of a link that spans boards.
 */
export class Stage {
  /** Its place in the room: position, turn and scale, as the main board's rig. */
  readonly group = new THREE.Group();
  readonly views = new Map<string, ItemView>();
  private links = new Map<string, LinkView>();
  private table = makeTable(1.4);
  private label: THREE.Sprite | null = null;
  private labelKey = "";
  private offClient: () => void;
  private offBoard: () => void;
  readonly client: BoardClient;
  board: Board | null = null;
  dimLevel = 0.55;

  constructor(readonly boardId: string) {
    this.client = new BoardClient(boardId);
    this.group.add(this.table.group);
    this.offClient = this.client.open();
    this.offBoard = this.client.subscribe((b) => this.set(b));
  }

  private set(b: Board) {
    this.board = b;
    const seen = new Set<string>();
    for (const it of b.items) {
      seen.add(it.id);
      const v = this.views.get(it.id);
      if (!v) {
        const nv = new ItemView(it, false);
        this.views.set(it.id, nv);
        this.group.add(nv.root);
      } else v.update(it);
    }
    for (const [id, v] of this.views) if (!seen.has(id)) (v.dispose(), this.views.delete(id));
    const seenL = new Set<string>();
    for (const l of b.links) {
      seenL.add(l.id);
      if (!this.links.has(l.id)) {
        const lv = new LinkView(l, false);
        this.links.set(l.id, lv);
        this.group.add(lv.root);
      }
    }
    for (const [id, lv] of this.links) if (!seenL.has(id)) (lv.dispose(), this.links.delete(id));
    if (this.labelKey !== b.name) {
      this.labelKey = b.name;
      this.label?.removeFromParent();
      this.label = labelSprite(b.name, LOOK.accent, { height: 0.09 });
      this.label.position.set(0, 0.55, -1.2);
      this.group.add(this.label);
    }
  }

  tick(t: number, dt: number) {
    this.table.tick(t, 0.5);
    this.table.u.uFade.value = this.dimLevel;
    for (const v of this.views.values()) {
      v.dim = this.dimLevel < 0.999;
      v.dimLevel = this.dimLevel;
      v.tick(t, dt);
    }
    if (!this.board) return;
    for (const l of this.board.links) {
      const lv = this.links.get(l.id);
      const a = this.views.get(l.from);
      const b = this.views.get(l.to);
      if (lv && a && b) lv.update(l, a, b);
    }
    for (const lv of this.links.values()) lv.tick(dt);
  }

  /** What a ray (world) hits: one of its items, or its table. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3): { kind: "item" | "table"; id?: string; point: THREE.Vector3; dist: number } | null {
    const rc = new THREE.Raycaster(origin, dir, 0, 30);
    this.group.updateMatrixWorld(true);
    const hits = rc.intersectObjects([...this.views.values()].map((v) => v.root), true);
    for (const h of hits) {
      let n: THREE.Object3D | null = h.object;
      while (n && !n.userData.itemId) n = n.parent;
      if (n && this.views.get(n.userData.itemId)?.item.kind !== "frame") return { kind: "item", id: n.userData.itemId, point: h.point.clone(), dist: h.distance };
    }
    // Its table: the disc at y = 0 in its own space.
    const inv = this.group.matrixWorld.clone().invert();
    const o = origin.clone().applyMatrix4(inv);
    const d = dir.clone().transformDirection(inv);
    if (Math.abs(d.y) < 1e-4) return null;
    const k = -o.y / d.y;
    if (k < 0) return null;
    const p = o.addScaledVector(d, k);
    if (Math.hypot(p.x, p.z) > 1.45) return null;
    const w = this.group.localToWorld(p.clone());
    return { kind: "table", point: w, dist: w.distanceTo(origin) };
  }

  /** An item's middle, in the world. */
  itemAt(id: string): THREE.Vector3 | null {
    const v = this.views.get(id);
    return v ? v.center() : null;
  }

  dispose() {
    this.offBoard();
    this.offClient();
    for (const v of this.views.values()) v.dispose();
    for (const l of this.links.values()) l.dispose();
    this.group.removeFromParent();
  }
}
