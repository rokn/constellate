/**
 * Freehand ink, tidied: a stroke that was meant as a line, an arrow, a
 * circle, an ellipse, a triangle, a rectangle or a diamond comes back as that
 * shape, drawn clean. Anything else is left as it was drawn (null).
 *
 * Works in any plane: a stroke lying on the table is read from above (so a
 * box lines up with the table's sides); one drawn in the air is read in the
 * plane it was drawn in (a box drawn upright stays upright).
 *
 * Points are board space, [x, y, z]. Pure maths, no three.js, so the server
 * (or a test) can run it too.
 */

import type { Vec3 } from "./board";

export const INK_SHAPES = ["line", "arrow", "circle", "ellipse", "triangle", "rectangle", "diamond"] as const;
export type InkShape = (typeof INK_SHAPES)[number];

export type ShapeFit = { shape: InkShape; points: Vec3[] };

type P = [number, number];

/** Smaller than this (m, bounding box diagonal) and it's a dot or a tick: left alone. */
const MIN_SIZE = 0.015;

export function recognizeStroke(stroke: Vec3[]): ShapeFit | null {
  if (stroke.length < 4) return null;
  const frame = planeOf(stroke);
  if (!frame) return null;
  const flat = stroke.map(frame.to2);
  const fit = recognize2D(flat);
  if (!fit) return null;
  return { shape: fit.shape, points: fit.points.map(frame.to3) };
}

/* -------------------------------- the plane ------------------------------- */

type Frame = { to2(p: Vec3): P; to3(p: P): Vec3 };

function planeOf(pts: Vec3[]): Frame | null {
  const c = mean3(pts);
  const ys = pts.map((p) => p[1]);
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[2]);
  const flatSpan = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const rise = Math.max(...ys) - Math.min(...ys);
  // Flat on (or just over) the table: read from above, keep the height it was drawn at.
  if (rise < 0.2 * flatSpan) {
    const y = c[1];
    return { to2: (p) => [p[0], p[2]], to3: (p) => [p[0], y, p[1]] };
  }
  // In the air: the plane it lies in (its least spread direction is the normal).
  const n = leastAxis(pts, c);
  // Horizontal across that plane, and "up" within it, so upright boxes snap upright.
  let u = cross([0, 1, 0], n);
  if (len(u) < 1e-6) u = [1, 0, 0];
  u = norm(u);
  const v = norm(cross(n, u));
  return {
    to2: (p) => {
      const d = sub(p, c);
      return [dot(d, u), dot(d, v)];
    },
    to3: (p) => [c[0] + u[0] * p[0] + v[0] * p[1], c[1] + u[1] * p[0] + v[1] * p[1], c[2] + u[2] * p[0] + v[2] * p[1]],
  };
}

/** The direction the points spread least along (the eigenvector of the smallest eigenvalue). */
function leastAxis(pts: Vec3[], c: Vec3): Vec3 {
  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += d[i] * d[j];
  }
  // Jacobi rotations: a symmetric 3×3 goes diagonal in a handful of sweeps.
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 20; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        off += Math.abs(a[p][q]);
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1);
        const sn = t * cs;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = cs * akp - sn * akq;
          a[k][q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = cs * apk - sn * aqk;
          a[q][k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = cs * vkp - sn * vkq;
          v[k][q] = sn * vkp + cs * vkq;
        }
      }
    if (off < 1e-14) break;
  }
  let m = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[m][m]) m = i;
  return norm([v[0][m], v[1][m], v[2][m]]);
}

/* ------------------------------ recognising ------------------------------ */

function recognize2D(raw: P[]): ShapeFit2 | null {
  const pts = dedupe(raw);
  if (pts.length < 4) return null;
  const L = pathLength(pts);
  const size = diag(pts);
  if (size < MIN_SIZE || L < MIN_SIZE) return null;
  const rs = resample(pts, 72);
  const gap = d2(pts[0], pts[pts.length - 1]);
  const closed = gap < 0.18 * L && gap < 0.35 * size && L > 1.6 * size;
  return closed ? closedShape(rs, size) : openShape(rs, L, size);
}

type ShapeFit2 = { shape: InkShape; points: P[] };

function openShape(pts: P[], L: number, size: number): ShapeFit2 | null {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = d2(a, b);
  // Nearly straight: a line.
  if (chord > 0.5 * L && Math.max(...pts.map((p) => distToSeg(p, a, b))) < 0.06 * chord) return { shape: "line", points: [a, b] };
  // An arrow: a straight shaft, then a short head (one or two barbs) back from its tip.
  const poly = rdp(pts, 0.07 * size);
  if (poly.length < 3) return null;
  const tip = poly[1];
  const shaft = d2(poly[0], tip);
  if (shaft < 0.5 * L) return null;
  const dir = unit2(subP(tip, poly[0]));
  let at = 0;
  for (let i = 1; i < pts.length; i++) if (d2(pts[i], tip) < d2(pts[at], tip)) at = i;
  let barb = 0;
  for (const q of pts.slice(at + 1)) {
    const off = subP(q, tip);
    const r = Math.hypot(off[0], off[1]);
    if (r > 0.45 * shaft) return null; // wanders off: not a head
    const along = dot2(off, dir);
    if (along > 0.08 * shaft) return null; // goes on past the tip
    if (r > 0.1 * shaft && along < -0.3 * r) barb = Math.max(barb, r);
  }
  if (!barb) return null;
  return { shape: "arrow", points: arrow(poly[0], tip) };
}

function closedShape(pts: P[], size: number): ShapeFit2 | null {
  const loop = pts.slice(0, -1);
  const corners = cornersOf(loop, 0.075 * size);
  const polyErr = corners.length >= 3 ? meanDistToPolygon(loop, corners) / size : Infinity;

  const e = fitEllipse(loop);
  const ellErr = e ? meanDistToPolygon(loop, ellipsePoints(e, e.a, e.b, 96)) / size : Infinity;
  // Corners win only where they fit better than a smooth round shape does.
  const angular = polyErr < 0.05 && (polyErr < ellErr * 0.9 || ellErr > 0.025);

  if (angular && corners.length === 3) return { shape: "triangle", points: close(corners) };
  if (angular && corners.length === 4 && convex(corners)) {
    const box = asRectangle(corners);
    if (box) return box;
    return { shape: "diamond", points: close(corners) };
  }

  if (e && e.err < 0.11 && ellErr < 0.05) {
    const round = e.b / e.a > 0.8;
    const r = (e.a + e.b) / 2;
    return { shape: round ? "circle" : "ellipse", points: close(ellipsePoints(e, round ? r : e.a, round ? r : e.b, 64)) };
  }
  return null;
}

function ellipsePoints(e: { c: P; ax: P }, ra: number, rb: number, n: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = ra * Math.cos(t);
    const y = rb * Math.sin(t);
    out.push([e.c[0] + x * e.ax[0] - y * e.ax[1], e.c[1] + x * e.ax[1] + y * e.ax[0]]);
  }
  return out;
}

/** Every turn the same way: no bow-tie, no dent. */
function convex(q: P[]): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = subP(q[(i + 1) % q.length], q[i]);
    const b = subP(q[(i + 2) % q.length], q[(i + 1) % q.length]);
    const z = a[0] * b[1] - a[1] * b[0];
    const s = Math.sign(z);
    if (!s) continue;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Four corners that are near right angles: a clean box (a square when nearly one), squared to the table when nearly level. */
function asRectangle(q: P[]): ShapeFit2 | null {
  for (let i = 0; i < 4; i++) {
    const a = unit2(subP(q[(i + 3) % 4], q[i]));
    const b = unit2(subP(q[(i + 1) % 4], q[i]));
    if (Math.abs(dot2(a, b)) > 0.4) return null; // > ~24° off square
  }
  // Its turn: the mean edge direction, folded into a quarter turn.
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < 4; i++) {
    const e = subP(q[(i + 1) % 4], q[i]);
    const ang = Math.atan2(e[1], e[0]) * 4;
    const w = Math.hypot(e[0], e[1]);
    sx += Math.cos(ang) * w;
    sy += Math.sin(ang) * w;
  }
  let th = Math.atan2(sy, sx) / 4;
  // Standing on a corner (a diamond) isn't a box gone askew.
  if (Math.abs(Math.abs(th) - Math.PI / 4) < 0.18) return null;
  if (Math.abs(th) < 0.17) th = 0; // within ~10° of level: level
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const local = q.map((p) => [p[0] * cs + p[1] * sn, -p[0] * sn + p[1] * cs] as P);
  const xs = local.map((p) => p[0]).sort((a, b) => a - b);
  const ys = local.map((p) => p[1]).sort((a, b) => a - b);
  let x0 = (xs[0] + xs[1]) / 2;
  let x1 = (xs[2] + xs[3]) / 2;
  let y0 = (ys[0] + ys[1]) / 2;
  let y1 = (ys[2] + ys[3]) / 2;
  const w = x1 - x0;
  const h = y1 - y0;
  if (Math.abs(w - h) / Math.max(w, h) < 0.1) {
    const s = (w + h) / 2;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    [x0, x1, y0, y1] = [cx - s / 2, cx + s / 2, cy - s / 2, cy + s / 2];
  }
  const back = (p: P): P => [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs];
  return { shape: "rectangle", points: close([back([x0, y0]), back([x1, y0]), back([x1, y1]), back([x0, y1])]) };
}

/** A straight arrow from a to its tip, with even barbs. */
function arrow(a: P, tip: P): P[] {
  const d = unit2(subP(tip, a));
  const len = d2(a, tip);
  const barb = Math.min(0.25 * len, Math.max(0.2 * len, 0.03));
  const ang = (28 * Math.PI) / 180;
  const back: P = [-d[0], -d[1]];
  const rot = (v: P, t: number): P => [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t)];
  const l = rot(back, ang);
  const r = rot(back, -ang);
  return [a, tip, [tip[0] + l[0] * barb, tip[1] + l[1] * barb], tip, [tip[0] + r[0] * barb, tip[1] + r[1] * barb]];
}

/** The corners of a closed loop: simplified from its two farthest-apart points. */
function cornersOf(loop: P[], eps: number): P[] {
  const c = mean2(loop);
  let i0 = 0;
  for (let i = 1; i < loop.length; i++) if (d2(loop[i], c) > d2(loop[i0], c)) i0 = i;
  const ring = [...loop.slice(i0), ...loop.slice(0, i0)];
  let j = 0;
  for (let i = 1; i < ring.length; i++) if (d2(ring[i], ring[0]) > d2(ring[j], ring[0])) j = i;
  const a = rdp(ring.slice(0, j + 1), eps);
  const b = rdp([...ring.slice(j), ring[0]], eps);
  let out = [...a.slice(0, -1), ...b.slice(0, -1)];
  // Corners too close together are one corner (a wobble at the join).
  const minGap = eps * 1.2;
  out = out.filter((p, i) => i === 0 || d2(p, out[i - 1]) > minGap);
  if (out.length > 2 && d2(out[0], out[out.length - 1]) < minGap) out.pop();
  // A "corner" on a straight run isn't one.
  for (let k = 0; out.length > 3 && k < out.length; ) {
    const p = out[(k + out.length - 1) % out.length];
    const n = out[(k + 1) % out.length];
    if (distToSeg(out[k], p, n) < eps * 0.8) out.splice(k, 1);
    else k++;
  }
  return out;
}

function fitEllipse(loop: P[]): { c: P; ax: P; a: number; b: number; err: number } | null {
  const c = mean2(loop);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of loop) {
    const x = p[0] - c[0];
    const y = p[1] - c[1];
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ax: P = [Math.cos(th), Math.sin(th)];
  const local = loop.map((p) => {
    const x = p[0] - c[0];
    const y = p[1] - c[1];
    return [x * ax[0] + y * ax[1], -x * ax[1] + y * ax[0]] as P;
  });
  const us = local.map((p) => p[0]);
  const vs = local.map((p) => p[1]);
  const u0 = Math.min(...us);
  const u1 = Math.max(...us);
  const v0 = Math.min(...vs);
  const v1 = Math.max(...vs);
  // Centre on the box it fills (a lopsided drawing still means a centred ellipse).
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const a = (u1 - u0) / 2;
  const b = (v1 - v0) / 2;
  if (a < 1e-6 || b < 1e-6 || b / a < 0.12) return null;
  let err = 0;
  let sweep = 0;
  let prev: number | null = null;
  for (const p of local) {
    const x = (p[0] - cu) / a;
    const y = (p[1] - cv) / b;
    err += Math.abs(Math.hypot(x, y) - 1);
    const ang = Math.atan2(y, x);
    if (prev !== null) {
      let d = ang - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      sweep += d;
    }
    prev = ang;
  }
  // It must go round once (not a zigzag that happens to fill a box).
  if (Math.abs(sweep) < Math.PI * 1.6) return null;
  const cc: P = [c[0] + cu * ax[0] - cv * ax[1], c[1] + cu * ax[1] + cv * ax[0]];
  return { c: cc, ax, a, b, err: err / local.length };
}

/* --------------------------------- helpers -------------------------------- */

function rdp(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts.slice();
  const a = pts[0];
  const b = pts[pts.length - 1];
  let far = -1;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i], a, b);
    if (d > far) {
      far = d;
      idx = i;
    }
  }
  if (far <= eps) return [a, b];
  const l = rdp(pts.slice(0, idx + 1), eps);
  const r = rdp(pts.slice(idx), eps);
  return [...l.slice(0, -1), ...r];
}

function resample(pts: P[], n: number): P[] {
  const L = pathLength(pts);
  const step = L / (n - 1);
  const out: P[] = [pts[0]];
  let acc = 0;
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    let cur = pts[i];
    let d = d2(prev, cur);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const q: P = [prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t];
      out.push(q);
      prev = q;
      d = d2(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push(pts[pts.length - 1]);
  return out.slice(0, n);
}

function meanDistToPolygon(pts: P[], poly: P[]): number {
  let s = 0;
  for (const p of pts) {
    let m = Infinity;
    for (let i = 0; i < poly.length; i++) m = Math.min(m, distToSeg(p, poly[i], poly[(i + 1) % poly.length]));
    s += m;
  }
  return s / pts.length;
}

function distToSeg(p: P, a: P, b: P): number {
  const ab = subP(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (l2 === 0) return d2(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
  return d2(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}

function dedupe(pts: P[]): P[] {
  return pts.filter((p, i) => i === 0 || d2(p, pts[i - 1]) > 1e-6);
}
const close = (ps: P[]): P[] => [...ps, ps[0]];
const pathLength = (pts: P[]) => pts.reduce((s, p, i) => (i ? s + d2(p, pts[i - 1]) : 0), 0);
function diag(pts: P[]): number {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}
const d2 = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const subP = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const dot2 = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const unit2 = (a: P): P => {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
};
const mean2 = (ps: P[]): P => [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
const mean3 = (ps: Vec3[]): Vec3 => [0, 1, 2].map((k) => ps.reduce((s, p) => s + p[k], 0) / ps.length) as Vec3;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
