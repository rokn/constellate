import type { Item, Vec3 } from "../../shared/board";
import { recognizeStroke } from "../../shared/inkShapes";

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * A finished ink stroke (board space) as an ink item: where it stands and its
 * points relative to that, tidied into a clean shape when it reads as one.
 */
export function inkStroke(pts: Vec3[], tidy: boolean): { pos: Vec3; extra: Partial<Item> } {
  const fit = tidy ? recognizeStroke(pts) : null;
  const use = fit?.points ?? pts;
  const base = use[0];
  const extra: Partial<Item> = { points: use.map((p) => [round(p[0] - base[0]), round(p[1] - base[1]), round(p[2] - base[2])] as Vec3) };
  if (fit) extra.shape = fit.shape;
  return { pos: [round(base[0]), round(base[1]), round(base[2])], extra };
}
