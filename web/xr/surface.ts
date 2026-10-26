import * as THREE from "three";
import { C } from "./ui";

/**
 * The table the map sits on, as a shape: the real table's own outline (the
 * plane the headset detected, or the one you traced round it by hand), and
 * the glassy top drawn over it. Also what's kept of it between sessions, so
 * the map goes back on the same table next time you come in.
 */

const Y = new THREE.Vector3(0, 1, 0);

/**
 * The real table the map sits on. `toward` runs from its middle to the edge
 * nearest you, `right` along that edge to your right; the half sizes are
 * along those. `poly` is its outline in those two directions (x right, z
 * toward), about the centre, which is the middle of its bounds.
 */
export type Table = { center: THREE.Vector3; toward: THREE.Vector3; right: THREE.Vector3; halfW: number; halfD: number; poly: [number, number][]; manual?: boolean };

/** A table from an outline in the room (any height; it's taken at `y`), squared to `toward`. */
export function tableFrom(pts: THREE.Vector3[], toward: THREE.Vector3, y: number, manual?: boolean): Table {
  const t = toward.clone().setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(Y, t).normalize();
  const raw = pts.map((p) => [p.x * right.x + p.z * right.z, p.x * t.x + p.z * t.z] as [number, number]);
  const xs = raw.map((q) => q[0]);
  const zs = raw.map((q) => q[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const center = right.clone().multiplyScalar(cx).addScaledVector(t, cz).setY(y);
  return {
    center,
    toward: t,
    right,
    halfW: (Math.max(...xs) - Math.min(...xs)) / 2,
    halfD: (Math.max(...zs) - Math.min(...zs)) / 2,
    poly: raw.map(([x, z]) => [x - cx, z - cz]),
    manual,
  };
}

/** The table's outline in the room. */
export function outlineOf(t: Table): THREE.Vector3[] {
  return t.poly.map(([x, z]) => t.center.clone().addScaledVector(t.right, x).addScaledVector(t.toward, z));
}

/**
 * The same table, its front turned to whichever of its four sides faces you
 * most (you may sit somewhere else this time).
 */
export function facing(t: Table, head: THREE.Vector3): Table {
  const you = head.clone().sub(t.center).setY(0).normalize();
  const sides = [t.toward, t.toward.clone().negate(), t.right, t.right.clone().negate()];
  const front = sides.reduce((a, b) => (b.dot(you) > a.dot(you) ? b : a));
  return front === t.toward ? t : tableFrom(outlineOf(t), front, t.center.y, t.manual);
}

/** The main directions of an outline: its longest edge, and across it. */
export function mainAxis(pts: THREE.Vector3[]): THREE.Vector3 {
  let best = new THREE.Vector3(0, 0, 1);
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = pts[(i + 1) % pts.length].clone().sub(pts[i]).setY(0);
    if (d.length() > len) (len = d.length()), (best = d.normalize());
  }
  return best;
}

/** Whether a point (in the room) is over the table, by its outline. */
export function overTable(t: Table, at: THREE.Vector3) {
  const rel = at.clone().sub(t.center);
  return inPoly(rel.dot(t.right), rel.dot(t.toward), t.poly);
}

function inPoly(x: number, y: number, poly: [number, number][]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** A circle as an outline: the virtual table under the map when there's no real one. */
export function disc(r: number, n = 48): [number, number][] {
  return Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r] as [number, number]);
}

/* -------------------------------- the top -------------------------------- */

const MAX_PTS = 64;

/**
 * The table top: a faint glassy fill in the table's own shape, a bright rim
 * along its real edge and a fainter line a few centimetres in, so it reads in
 * the headset without hiding anything under it (it writes no depth, and the
 * map draws over it). The rim is measured in metres from the edge, so it's
 * the same width all round, whatever the shape.
 */
export class Surface {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private key = "";

  constructor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0.6 },
        uColor: { value: new THREE.Color(C.static).multiplyScalar(0.6) },
        uPoly: { value: Array.from({ length: MAX_PTS }, () => new THREE.Vector2()) },
        uN: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main() {
          vP = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform vec3 uColor;
        uniform vec2 uPoly[${MAX_PTS}];
        uniform int uN;
        varying vec2 vP;
        float seg(vec2 p, vec2 a, vec2 b) {
          vec2 ab = b - a;
          float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
          return length(p - a - ab * t);
        }
        void main() {
          float d = 1e3;
          for (int i = 0; i < ${MAX_PTS}; i++) {
            if (i >= uN) break;
            vec2 a = uPoly[i];
            vec2 b = uPoly[i + 1 < uN ? i + 1 : 0];
            d = min(d, seg(vP, a, b));
          }
          float aa = fwidth(d) * 1.5;
          float rim = 1.0 - smoothstep(0.007, 0.007 + aa, d);
          float inner = (1.0 - smoothstep(0.0015, 0.0015 + aa, abs(d - 0.045))) * 0.3;
          // A faint fill, a touch brighter away from the edges where the map stands.
          float top = 0.07 + 0.06 * smoothstep(0.0, 0.35, d);
          float alpha = (top + rim * 0.75 + inner) * uOpacity;
          gl_FragColor = vec4(uColor * (0.5 + rim * 0.7), alpha);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    // Over the floor grid, under the map.
    this.mesh.renderOrder = -3;
    this.mesh.visible = false;
  }

  /** Its shape: an outline in its own x (right) and z (toward you). */
  setShape(poly: [number, number][]) {
    const pts = poly.length > MAX_PTS ? poly.filter((_, i) => i % Math.ceil(poly.length / MAX_PTS) === 0) : poly;
    const key = pts.map(([x, z]) => `${x.toFixed(3)},${z.toFixed(3)}`).join(";");
    if (key === this.key) return;
    this.key = key;
    const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const pos = new Float32Array(pts.length * 3);
    pts.forEach(([x, z], i) => pos.set([x, 0, z], i * 3));
    const g = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(tris.flat());
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    const u = this.mesh.material.uniforms;
    contour.forEach((v, i) => (u.uPoly.value as THREE.Vector2[])[i].copy(v));
    u.uN.value = contour.length;
  }

  /** Where it lies, as a pose: its outline in the pose's x and z. */
  setMatrix(m: THREE.Matrix4) {
    m.decompose(this.mesh.position, this.mesh.quaternion, new THREE.Vector3());
  }

  /** Where it lies: centred at `center`, its z toward `toward`. */
  setPose(center: THREE.Vector3, toward: THREE.Vector3) {
    const t = toward.clone().setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(Y, t).normalize();
    this.mesh.position.copy(center);
    this.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, Y, t));
  }

  set opacity(v: number) {
    this.mesh.material.uniforms.uOpacity.value = v;
  }
}

/* ------------------------------ kept for later ------------------------------ */

type V3 = [number, number, number];

/**
 * The table, kept in two ways, so either finds it again: relative to the
 * headset's anchor (when it keeps one between sessions), and relative to the
 * detected plane it lies on, found again by its size and height above the
 * floor (Space Setup keeps those). The outline is the table's own.
 */
export type SavedTable = {
  poly: [number, number][];
  manual?: boolean;
  /** In the anchor's space: the map's spot is the anchor itself. */
  anchor?: { center: V3; toward: V3 };
  /** In the plane's space: its size (x, z) and height, where the map was, and the table. */
  plane?: { sx: number; sz: number; y: number; spot: V3; center: V3; toward: V3 };
};

const KEY = "constellate.xr.table";

export function loadTable(): SavedTable | null {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? "null") as SavedTable | null;
    return t && Array.isArray(t.poly) && t.poly.length >= 3 ? t : null;
  } catch {
    return null;
  }
}

export function saveTable(t: SavedTable | null) {
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify(t));
    else localStorage.removeItem(KEY);
  } catch {
    /* no storage: it's found afresh next time */
  }
}

export const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
export const vec = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** A table kept in some space (`m`: that space's pose in the room), back in the room. */
export function tableIn(m: THREE.Matrix4, saved: { center: V3; toward: V3 }, poly: [number, number][], manual?: boolean): Table {
  const center = vec(saved.center).applyMatrix4(m);
  const toward = vec(saved.toward).transformDirection(m).setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(Y, toward).normalize();
  const xs = poly.map((q) => q[0]);
  const zs = poly.map((q) => q[1]);
  return { center, toward, right, poly, manual, halfW: (Math.max(...xs) - Math.min(...xs)) / 2, halfD: (Math.max(...zs) - Math.min(...zs)) / 2 };
}

/** The table, in some space (`inv`: the room into that space). */
export function tableInto(inv: THREE.Matrix4, t: Table): { center: V3; toward: V3 } {
  return { center: v3(t.center.clone().applyMatrix4(inv)), toward: v3(t.toward.clone().transformDirection(inv)) };
}

/* ------------------------------ your own surfaces ------------------------------ */

/**
 * A surface of your own, traced by hand like the table: any flat thing a
 * panel can lie on (a shelf, a stretch of wall the headset didn't find, a
 * slanted desk). `m` is its pose: x along it, y out of it toward you, z along
 * it the other way; `poly` its outline in x and z about the middle of its bounds.
 */
export type Plane = { m: THREE.Matrix4; poly: [number, number][]; halfX: number; halfZ: number };

/** The plane through traced corners (its face toward `head`), with their outline on it. Three corners make a rectangle. */
export function planeThrough(raw: THREE.Vector3[], head: THREE.Vector3): Plane | null {
  let pts = raw.map((p) => p.clone());
  if (pts.length === 3) {
    const [a, b, c] = pts;
    const ab = b.clone().sub(a);
    const bc = c.clone().sub(b);
    bc.sub(ab.clone().multiplyScalar(bc.dot(ab) / Math.max(1e-6, ab.lengthSq())));
    pts = [a, b, b.clone().add(bc), a.clone().add(bc)];
  }
  // Newell's normal: the best plane through a loop of points, however it bends.
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    n.x += (p.y - q.y) * (p.z + q.z);
    n.y += (p.z - q.z) * (p.x + q.x);
    n.z += (p.x - q.x) * (p.y + q.y);
  }
  if (n.lengthSq() < 1e-8) return null;
  n.normalize();
  const mid = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  if (head.clone().sub(mid).dot(n) < 0) n.negate();
  // Along it: level on an upright surface, along its longest side on a lying one.
  const x = Math.abs(n.y) < 0.7 ? new THREE.Vector3().crossVectors(Y, n).normalize() : mainAxis(pts).projectOnPlane(n).normalize();
  const z = new THREE.Vector3().crossVectors(x, n).normalize();
  const flat = pts.map((p) => [p.clone().sub(mid).dot(x), p.clone().sub(mid).dot(z)] as [number, number]);
  const xs = flat.map((q) => q[0]);
  const zs = flat.map((q) => q[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const center = mid.clone().addScaledVector(x, cx).addScaledVector(z, cz);
  const m = new THREE.Matrix4().makeBasis(x, n, z).setPosition(center);
  return { m, poly: flat.map(([a, b]) => [a - cx, b - cz]), halfX: (Math.max(...xs) - Math.min(...xs)) / 2, halfZ: (Math.max(...zs) - Math.min(...zs)) / 2 };
}

/** Your surfaces as kept: each by the headset's anchor at its middle (which carries its pose), and its outline. */
export type SavedSurface = { uuid: string; poly: [number, number][] };

const SURFACES_KEY = "constellate.xr.surfaces";

export function loadSurfaces(): SavedSurface[] {
  try {
    const l = JSON.parse(localStorage.getItem(SURFACES_KEY) ?? "[]") as SavedSurface[];
    return Array.isArray(l) ? l.filter((s) => typeof s.uuid === "string" && Array.isArray(s.poly) && s.poly.length >= 3) : [];
  } catch {
    return [];
  }
}

export function saveSurfaces(l: SavedSurface[]) {
  try {
    localStorage.setItem(SURFACES_KEY, JSON.stringify(l));
  } catch {
    /* no storage: they last this session */
  }
}
