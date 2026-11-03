import * as THREE from "three";
import { colorOf, type Board, type BoardSummary } from "../../shared/board";
import { sfx } from "../xr/sound";
import { headFrame } from "./hud";
import { LOOK, labelSprite } from "./look";
import type { RoomXR } from "./room";
import { num, on, pick } from "./tune";
import type { Pointer, XRInput, XRPlugin } from "./xr";

/**
 * The board shelf: every board as a small hologram of itself (its items as
 * points of light, its links as threads) on an arc beside you. Point and
 * pinch one to switch to it; carry one (pinch and pull, or grip) to the
 * table to switch, into open space to stand it in the room, or throw it at
 * a wall. The last card makes a new board.
 */

type Card = { id: string | null; name: string; group: THREE.Group; hit: THREE.Mesh; home: THREE.Vector3; key: string };
type Held = { card: Card; p: Pointer; via: "ray" | "hand"; dist: number; moved: boolean; trail: { t: number; at: THREE.Vector3 }[]; start: THREE.Vector3 };

const R = 0.075;

export class ShelfXR implements XRPlugin {
  readonly label = "board shelf";
  private root = new THREE.Group();
  private cards: Card[] = [];
  private cache = new Map<string, { at: number; board: Board }>();
  private held: Held | null = null;
  private hover: Card | null = null;
  open = false;

  constructor(
    private xr: XRInput,
    private room: RoomXR,
    private o: { boards: () => BoardSummary[]; current: () => string | null; open: (id: string) => void; create: () => Promise<string | null> },
  ) {
    this.root.visible = false;
    xr.scene.overlay.add(this.root);
  }

  handle(action: string): boolean {
    if (action !== "shelf") return false;
    if (!on("shelfOn")) return true;
    if (this.open) this.close();
    else void this.show();
    return true;
  }

  left() {
    this.close();
  }

  close() {
    this.open = false;
    this.root.visible = false;
    this.held = null;
  }

  /** Lay the shelf out beside you, every board on it. */
  async show() {
    this.open = true;
    this.root.visible = true;
    const list = this.o.boards();
    await Promise.all(
      list.map(async (b) => {
        const c = this.cache.get(b.id);
        if (c && c.at >= b.updatedAt) return;
        try {
          const r = await fetch(`/api/board?id=${encodeURIComponent(b.id)}`);
          if (r.ok) this.cache.set(b.id, { at: b.updatedAt, board: (await r.json()) as Board });
        } catch {
          /* shown as an empty card */
        }
      }),
    );
    this.build(list);
    sfx.play("pick");
  }

  private build(list: BoardSummary[]) {
    for (const c of this.cards) disposeGroup(c.group);
    this.cards = [];
    this.root.clear();
    const cam = this.xr.scene.renderer.xr.getCamera();
    const { head, fwd, right } = headFrame(cam);
    const side = pick("shelfSide") === "right" ? 1 : -1;
    const dist = num("shelfDistance");
    const all: (BoardSummary | null)[] = [...list, null];
    const perRow = 6;
    all.forEach((b, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      // An arc from ahead-and-aside round to your side.
      const a = THREE.MathUtils.degToRad(35 + col * 15);
      const dir = fwd.clone().multiplyScalar(Math.cos(a)).addScaledVector(right, side * Math.sin(a)).normalize();
      const home = head.clone().addScaledVector(dir, dist).add(new THREE.Vector3(0, -0.22 + row * 0.2, 0));
      const card = this.makeCard(b, home, head);
      this.cards.push(card);
      this.root.add(card.group);
    });
  }

  private makeCard(b: BoardSummary | null, home: THREE.Vector3, head: THREE.Vector3): Card {
    const g = new THREE.Group();
    g.position.copy(home);
    // Tilted toward you, as a dish on a shelf.
    g.lookAt(head.x, home.y + 0.25, head.z);
    g.rotateX(-Math.PI / 2 + 0.55);
    const current = b?.id === this.o.current();
    const col = current ? LOOK.accent : LOOK.cyan;
    const ring = (r: number, op: number) =>
      new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2) * r, 0, Math.sin((i / 64) * Math.PI * 2) * r))),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      );
    g.add(ring(R, 0.9), ring(R * 0.7, 0.25));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    g.add(disc);
    const board = b ? this.cache.get(b.id)?.board : null;
    if (board) {
      const k = R / 1.4;
      const pos: number[] = [];
      const cols: number[] = [];
      const c = new THREE.Color();
      for (const it of board.items) {
        if (it.kind === "frame" || it.kind === "ink") continue;
        pos.push(it.pos[0] * k, 0.004 + it.pos[1] * k + 0.006, it.pos[2] * k);
        c.set(colorOf(it.color));
        cols.push(c.r, c.g, c.b);
      }
      if (pos.length) {
        const pts = new THREE.Points(
          new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)).setAttribute("color", new THREE.Float32BufferAttribute(cols, 3)),
          new THREE.PointsMaterial({ size: 0.006, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
        );
        g.add(pts);
      }
      const byId = new Map(board.items.map((i) => [i.id, i]));
      const seg: number[] = [];
      for (const l of board.links) {
        const a = byId.get(l.from);
        const z = byId.get(l.to);
        if (!a || !z) continue;
        seg.push(a.pos[0] * k, 0.01, a.pos[2] * k, z.pos[0] * k, 0.01, z.pos[2] * k);
      }
      if (seg.length) g.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(seg, 3)), new THREE.LineBasicMaterial({ color: LOOK.cyan, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
      for (const f of board.items.filter((i) => i.kind === "frame")) {
        const [w, d] = f.size ?? [0.8, 0.5];
        const x = f.pos[0] * k;
        const z = f.pos[2] * k;
        const hw = (w * k) / 2;
        const hd = (d * k) / 2;
        g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x - hw, 0.003, z - hd), new THREE.Vector3(x + hw, 0.003, z - hd), new THREE.Vector3(x + hw, 0.003, z + hd), new THREE.Vector3(x - hw, 0.003, z + hd)]), new THREE.LineBasicMaterial({ color: colorOf(f.color), transparent: true, opacity: 0.4, toneMapped: false })));
      }
    } else if (!b) {
      // The new-board card: a plus of light.
      const plus = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.025, 0.01, 0), new THREE.Vector3(0.025, 0.01, 0), new THREE.Vector3(0, 0.01, -0.025), new THREE.Vector3(0, 0.01, 0.025)]),
        new THREE.LineBasicMaterial({ color: LOOK.accent, toneMapped: false }),
      );
      g.add(plus);
    }
    const label = labelSprite(b ? b.name : "New board", current ? LOOK.accent : b ? LOOK.cyan : LOOK.accent, { height: 0.016, sub: b ? `${b.items} items` : undefined, bracket: false });
    label.position.set(0, 0.05, -R * 0.2);
    g.add(label);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.05, R * 1.05, 0.06, 24), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.02;
    g.add(hit);
    return { id: b?.id ?? null, name: b?.name ?? "New board", group: g, hit, home: home.clone(), key: b ? `${b.id}` : "new" };
  }

  panels() {
    return [];
  }

  private cardHit(origin: THREE.Vector3, dir: THREE.Vector3): { card: Card; dist: number } | null {
    if (!this.open) return null;
    const rc = new THREE.Raycaster(origin, dir, 0, 4);
    let best: { card: Card; dist: number } | null = null;
    for (const c of this.cards) {
      const h = rc.intersectObject(c.hit, false)[0];
      if (h && (!best || h.distance < best.dist)) best = { card: c, dist: h.distance };
    }
    return best;
  }

  private nearCard(at: THREE.Vector3): Card | null {
    if (!this.open) return null;
    let best: { c: Card; d: number } | null = null;
    for (const c of this.cards) {
      const d = c.group.getWorldPosition(new THREE.Vector3()).distanceTo(at);
      if (d < R * 1.3 && (!best || d < best.d)) best = { c, d };
    }
    return best?.c ?? null;
  }

  press(p: Pointer, kind: "select" | "squeeze"): boolean {
    if (!this.open) return false;
    const hand = this.xr.isHand(p);
    const near = hand || kind === "squeeze" ? this.nearCard(hand ? this.xr.tip(p) : new THREE.Vector3().setFromMatrixPosition(p.grip.matrixWorld)) : null;
    const hit = near ? null : this.cardHit(p.origin, p.dir);
    const card = near ?? hit?.card;
    if (!card) return false;
    this.held = { card, p, via: near ? "hand" : "ray", dist: hit?.dist ?? 0, moved: false, trail: [], start: card.group.position.clone() };
    this.xr.haptic(p, 0.4, 25);
    sfx.play("grab", card.group.position);
    return true;
  }

  release(p: Pointer): boolean {
    const h = this.held;
    if (!h || h.p !== p) return false;
    this.held = null;
    const c = h.card;
    const at = c.group.position.clone();
    if (!h.moved) {
      // A tap: this board.
      void this.choose(c);
      return true;
    }
    const scene = this.xr.scene;
    const toTable = at.distanceTo(scene.rig.position) < Math.max(0.45, scene.rig.scale.x * 1.4 * 0.8);
    const v = velocityOf(h.trail);
    if (toTable) void this.choose(c);
    else if (c.id && v && v.speed > num("flingSpeed") && on("throwToWall")) {
      if (!this.room.placeOnWall(c.id, at, v.vel)) this.room.placeBoard(c.id, at);
    } else if (c.id && at.distanceTo(c.home) > 0.25) this.room.placeBoard(c.id, at);
    // Back on the shelf, either way.
    c.group.position.copy(c.home);
    return true;
  }

  private async choose(c: Card) {
    let id = c.id;
    if (!id) id = await this.o.create();
    if (!id) return;
    if (id !== this.o.current()) this.o.open(id);
    sfx.play("whoosh");
    this.close();
  }

  frame(_dt: number, now: number) {
    if (!this.open) return;
    const h = this.held;
    if (h) {
      const p = h.p;
      const want = h.via === "hand" ? (this.xr.isHand(p) ? this.xr.tip(p) : new THREE.Vector3().setFromMatrixPosition(p.grip.matrixWorld)) : p.origin.clone().addScaledVector(p.dir, h.dist);
      if (!h.moved && want.distanceTo(h.start) > 0.03) h.moved = true;
      if (h.moved) h.card.group.position.copy(want);
      h.trail.push({ t: now, at: want.clone() });
      while (h.trail.length > 2 && now - h.trail[0].t > 120) h.trail.shift();
    }
    // Pointed at: it comes forward a little.
    let hov: Card | null = null;
    for (const p of this.xr.ptrs) {
      if (!p.source || p.press) continue;
      const hit = this.cardHit(p.origin, p.dir);
      if (hit) hov = hit.card;
    }
    if (hov !== this.hover) {
      if (hov) sfx.play("hover", hov.group.position, hov.key);
      this.hover = hov;
    }
    for (const c of this.cards) {
      const s = c === this.hover || c === this.held?.card ? 1.18 : 1;
      c.group.scale.setScalar(THREE.MathUtils.lerp(c.group.scale.x, s, 0.25));
      c.group.children.forEach((o) => {
        if (o instanceof THREE.Points) o.rotation.y += 0.004;
      });
    }
  }
}

function velocityOf(trail: { t: number; at: THREE.Vector3 }[]) {
  if (trail.length < 2) return null;
  const a = trail[0];
  const b = trail[trail.length - 1];
  const vel = b.at.clone().sub(a.at).divideScalar(Math.max(0.001, (b.t - a.t) / 1000));
  return { vel, speed: vel.length() };
}

function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | undefined;
    (mat as THREE.SpriteMaterial | undefined)?.map?.dispose();
    mat?.dispose?.();
  });
}
