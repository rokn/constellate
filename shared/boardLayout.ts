import dagre from "@dagrejs/dagre";
import type { Board, Item, Vec3 } from "./board";

/**
 * Arranging items on the table. Every arrangement lays items out in the
 * table's plane (x across, z toward you), keeping each item's height, and
 * centres the result on `center` (the table's middle by default).
 */

export type Arrangement = "flow" | "grid" | "row" | "column" | "ring" | "stack";
export const ARRANGEMENTS: readonly Arrangement[] = ["flow", "grid", "row", "column", "ring", "stack"];

export function arrange(b: Board, ids: string[], how: Arrangement, o: { center?: Vec3; spacing?: number; direction?: "front-to-back" | "left-to-right" } = {}): Map<string, Vec3> {
  const items = ids.map((id) => b.items.find((i) => i.id === id)).filter((i): i is Item => !!i && i.kind !== "ink");
  const out = new Map<string, Vec3>();
  if (!items.length) return out;
  const gap = o.spacing ?? 0.32;
  const n = items.length;
  const flat: [number, number][] = [];

  switch (how) {
    case "row":
      items.forEach((_, k) => flat.push([(k - (n - 1) / 2) * gap, 0]));
      break;
    case "column":
      items.forEach((_, k) => flat.push([0, (k - (n - 1) / 2) * gap]));
      break;
    case "grid": {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      items.forEach((_, k) => flat.push([((k % cols) - (cols - 1) / 2) * gap, (Math.floor(k / cols) - (rows - 1) / 2) * gap]));
      break;
    }
    case "ring": {
      const r = Math.max(gap, (n * gap) / (2 * Math.PI));
      items.forEach((_, k) => {
        const a = (k / n) * Math.PI * 2 - Math.PI / 2;
        flat.push([Math.cos(a) * r, Math.sin(a) * r]);
      });
      break;
    }
    case "stack": {
      // Up, not across: a tower of layers.
      const c = o.center ?? [0, 0, 0];
      items.forEach((it, k) => out.set(it.id, [c[0], 0.05 + k * gap * 0.6, c[2]]));
      return out;
    }
    case "flow": {
      // Layered by the links between them: sources at the back, sinks at the front (or left to right).
      const g = new dagre.graphlib.Graph();
      const lr = o.direction === "left-to-right";
      g.setGraph({ rankdir: lr ? "LR" : "TB", nodesep: gap * 100, ranksep: gap * 110, marginx: 0, marginy: 0 });
      g.setDefaultEdgeLabel(() => ({}));
      const set = new Set(items.map((i) => i.id));
      for (const it of items) g.setNode(it.id, { width: 18, height: 18 });
      for (const l of b.links) if (set.has(l.from) && set.has(l.to)) g.setEdge(l.from, l.to);
      dagre.layout(g);
      const pts = items.map((it) => g.node(it.id) as { x: number; y: number });
      const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2;
      const cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
      // dagre's units are ~1 cm here; top-to-bottom becomes back-to-front.
      for (const p of pts) flat.push([(p.x - cx) / 100, (p.y - cy) / 100]);
      break;
    }
  }

  // Too big for the table: shrink it to fit a 2.6 m disc.
  const reach = Math.max(...flat.map(([x, z]) => Math.hypot(x, z)), 0.001);
  const k = reach > 1.3 ? 1.3 / reach : 1;
  const c = o.center ?? [0, 0, 0];
  items.forEach((it, idx) => {
    const [x, z] = flat[idx];
    out.set(it.id, [round(c[0] + x * k), it.pos[1], round(c[2] + z * k)]);
  });
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
