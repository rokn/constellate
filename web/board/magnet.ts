import * as THREE from "three";
import { heightOf, type Board, type Vec3 } from "../../shared/board";
import { num, on } from "./tune";

/**
 * Magnetic snapping: an item being placed is drawn to its neighbours. Within
 * reach of another item's x, z or height it lines up with it, and over the
 * top of one it comes to rest on it. What it snapped to comes back too, for
 * the guides drawn while it's held.
 */

export type Snap = { pos: Vec3; guides: [THREE.Vector3, THREE.Vector3][]; snapped: string };

export function magnet(b: Board | null, id: string, pos: Vec3, o: { ignore?: Set<string> } = {}): Snap {
  const out: Snap = { pos: [...pos] as Vec3, guides: [], snapped: "" };
  if (!b || !on("magnet")) return out;
  const reach = num("magnetReach");
  const me = b.items.find((i) => i.id === id);
  if (!me || me.kind === "frame" || me.kind === "ink") return out;
  let bestX: { d: number; v: number; from: Vec3 } | null = null;
  let bestZ: { d: number; v: number; from: Vec3 } | null = null;
  let bestY: { d: number; v: number; from: Vec3 } | null = null;
  let rest: { y: number; on: string } | null = null;
  for (const it of b.items) {
    if (it.id === id || it.kind === "ink" || it.attach === id || o.ignore?.has(it.id)) continue;
    const [x, y, z] = it.pos;
    const near = Math.hypot(x - pos[0], z - pos[2]);
    if (near > 0.9) continue;
    if (it.kind !== "frame") {
      const dx = Math.abs(x - pos[0]);
      const dz = Math.abs(z - pos[2]);
      if (dx < reach && (!bestX || dx < bestX.d)) bestX = { d: dx, v: x, from: it.pos };
      if (dz < reach && (!bestZ || dz < bestZ.d)) bestZ = { d: dz, v: z, from: it.pos };
      if (pos[1] > 0.01 && Math.abs(y - pos[1]) < reach && (!bestY || Math.abs(y - pos[1]) < bestY.d)) bestY = { d: Math.abs(y - pos[1]), v: y, from: it.pos };
      // Right over it, and coming down onto it: rest on top.
      const top = y + heightOf(it);
      const r = 0.07 * (it.scale ?? 1);
      if (near < r && pos[1] > y && pos[1] - top < reach * 2.5 && pos[1] - top > -heightOf(it) * 0.6) rest = { y: top, on: it.id };
    }
  }
  if (rest) {
    out.pos = [b.items.find((i) => i.id === rest!.on)!.pos[0], round(rest.y), b.items.find((i) => i.id === rest!.on)!.pos[2]];
    out.snapped = `rest:${rest.on}`;
    return out;
  }
  const keys: string[] = [];
  if (bestX) {
    out.pos[0] = bestX.v;
    keys.push(`x${bestX.v}`);
    if (on("magnetGuides")) out.guides.push([new THREE.Vector3(bestX.v, Math.max(out.pos[1], bestX.from[1]) + 0.004, bestX.from[2]), new THREE.Vector3(bestX.v, out.pos[1] + 0.004, out.pos[2])]);
  }
  if (bestZ) {
    out.pos[2] = bestZ.v;
    keys.push(`z${bestZ.v}`);
    if (on("magnetGuides")) out.guides.push([new THREE.Vector3(bestZ.from[0], Math.max(out.pos[1], bestZ.from[1]) + 0.004, bestZ.v), new THREE.Vector3(out.pos[0], out.pos[1] + 0.004, bestZ.v)]);
  }
  if (bestY) {
    out.pos[1] = bestY.v;
    keys.push(`y${bestY.v}`);
    if (on("magnetGuides")) out.guides.push([new THREE.Vector3(bestY.from[0], bestY.v, bestY.from[2]), new THREE.Vector3(out.pos[0], bestY.v, out.pos[2])]);
  }
  out.snapped = keys.join("|");
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
