import * as THREE from "three";
import { colorOf, type Part, type Vec3 } from "../../shared/board";
import { holoMesh, labelSprite, type HoloUniforms } from "./look";

/**
 * Holograms: a tree of parts, built into glowing meshes. Each part knows
 * where it sits and where it flies when the model is pulled apart; parts
 * without an explode vector fly straight out from the middle.
 */

const MAX_PARTS = 1500;
const D = THREE.MathUtils.degToRad;

export type Animated = { obj: THREE.Object3D; home: THREE.Vector3; out: THREE.Vector3; spin?: THREE.Vector3; bob?: number; phase: number };

export function buildHolo(parts: Part[], u: HoloUniforms, baseColor: string): { group: THREE.Group; animated: Animated[]; count: number } {
  const group = new THREE.Group();
  const animated: Animated[] = [];
  let count = 0;

  const one = (p: Part, parent: THREE.Object3D, top: boolean, extra?: { pos: Vec3; rot: Vec3 }) => {
    if (count >= MAX_PARTS) return;
    count++;
    const holder = new THREE.Group();
    const pos = add(p.pos ?? [0, 0, 0], extra?.pos ?? [0, 0, 0]);
    const rot = add(p.rot ?? [0, 0, 0], extra?.rot ?? [0, 0, 0]);
    holder.position.set(...pos);
    holder.rotation.set(D(rot[0]), D(rot[1]), D(rot[2]));
    if (typeof p.scale === "number") holder.scale.setScalar(p.scale);
    else if (Array.isArray(p.scale)) holder.scale.set(...p.scale);
    const color = colorOf(p.color, baseColor);
    const obj = shapeOf(p, u, color);
    if (obj) holder.add(obj);
    parent.add(holder);
    for (const c of p.children ?? []) expand(c, holder, false);

    const home = holder.position.clone();
    const out = p.explode
      ? new THREE.Vector3(...p.explode)
      : top && home.lengthSq() > 1e-6
        ? home.clone().normalize().multiplyScalar(0.12)
        : new THREE.Vector3();
    if (out.lengthSq() > 0 || p.anim?.spin || p.anim?.bob) {
      animated.push({
        obj: holder,
        home,
        out,
        spin: p.anim?.spin ? new THREE.Vector3(...p.anim.spin) : undefined,
        bob: p.anim?.bob,
        phase: Math.random() * Math.PI * 2,
      });
    }
  };

  const expand = (p: Part, parent: THREE.Object3D, top: boolean) => {
    const r = p.repeat;
    if (!r || !(r.count > 1)) return one(p, parent, top);
    const n = Math.min(200, Math.floor(r.count));
    for (let k = 0; k < n; k++) {
      if (r.radial) {
        const a = (k / n) * Math.PI * 2;
        one(p, parent, top, { pos: [Math.cos(a) * r.radial, 0, Math.sin(a) * r.radial], rot: [0, -THREE.MathUtils.radToDeg(a), 0] });
      } else {
        const o = r.offset ?? [0, 0, 0];
        const t = r.rotate ?? [0, 0, 0];
        one(p, parent, top, { pos: [o[0] * k, o[1] * k, o[2] * k], rot: [t[0] * k, t[1] * k, t[2] * k] });
      }
    }
  };

  for (const p of parts) expand(p, group, true);
  return { group, animated, count };
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const num = (n: unknown, d: number, lo = 0.0005, hi = 5) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);

function shapeOf(p: Part, u: HoloUniforms, color: string): THREE.Object3D | null {
  const r = num(p.radius, 0.05);
  const h = num(p.height, 0.1);
  let geo: THREE.BufferGeometry | null = null;
  let stretch = true;
  try {
    switch (p.shape) {
      case "box":
        geo = new THREE.BoxGeometry(...((p.size ?? [0.1, 0.1, 0.1]).map((n) => num(n, 0.1)) as Vec3));
        stretch = false;
        break;
      case "sphere":
        geo = new THREE.SphereGeometry(r, 20, 14);
        break;
      case "cylinder":
        geo = new THREE.CylinderGeometry(num(p.radiusTop, r, 0), r, h, 28);
        break;
      case "cone":
        geo = new THREE.ConeGeometry(r, h, 28);
        break;
      case "torus":
        geo = new THREE.TorusGeometry(r, num(p.tube, r * 0.2), 10, 48);
        break;
      case "ring":
        geo = new THREE.RingGeometry(num(p.tube, r * 0.8, 0), r, 56).rotateX(-Math.PI / 2);
        break;
      case "capsule":
        geo = new THREE.CapsuleGeometry(r, h, 6, 16);
        break;
      case "plane":
        geo = new THREE.PlaneGeometry(num(p.size?.[0], 0.1), num(p.size?.[1], 0.1));
        stretch = false;
        break;
      case "icosahedron":
        geo = new THREE.IcosahedronGeometry(r, 0);
        break;
      case "octahedron":
        geo = new THREE.OctahedronGeometry(r, 0);
        break;
      case "tetrahedron":
        geo = new THREE.TetrahedronGeometry(r, 0);
        break;
      case "dodecahedron":
        geo = new THREE.DodecahedronGeometry(r, 0);
        break;
      case "gear":
        geo = gear(r, Math.min(120, Math.max(4, Math.round(p.teeth ?? 12))), num(p.depth, r * 0.25));
        break;
      case "tube": {
        const pts = (p.points ?? []).filter((q) => q.length >= 3).map((q) => new THREE.Vector3(q[0], q[1], q[2]));
        if (pts.length < 2) return null;
        geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.min(256, pts.length * 12), num(p.radius, 0.004), 8);
        break;
      }
      case "lathe": {
        const pts = (p.points ?? []).filter((q) => q.length >= 2).map((q) => new THREE.Vector2(Math.max(0, q[0]), q[1]));
        if (pts.length < 2) return null;
        geo = new THREE.LatheGeometry(pts, 36);
        break;
      }
      case "extrude": {
        const pts = (p.points ?? []).filter((q) => q.length >= 2).map((q) => new THREE.Vector2(q[0], q[1]));
        if (pts.length < 3) return null;
        geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: num(p.depth, 0.02), bevelEnabled: false });
        break;
      }
      case "text": {
        const s = labelSprite(String(p.text ?? ""), color, { height: num(p.size?.[0], 0.025), bracket: false });
        s.center.set(0.5, 0.5);
        return s;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
  const mesh = holoMesh(geo, u, color, { opacity: num(p.opacity, 0.12, 0, 1) * 0.6, wire: p.wire, pulse: num(p.anim?.pulse, 0, 0, 1) });
  if (stretch && p.size) mesh.scale.set(...(p.size.map((n) => num(n, 1, 0.01, 50)) as Vec3));
  return mesh;
}

function gear(r: number, teeth: number, depth: number) {
  const s = new THREE.Shape();
  const inner = r * 0.82;
  const n = teeth * 4;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = i % 4 === 1 || i % 4 === 2 ? r : inner;
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, r * 0.28, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false }).translate(0, 0, -depth / 2);
}

/** Pull a built hologram apart (0..1) and run its animations. */
export function animateHolo(animated: Animated[], explode: number, t: number, dt: number) {
  // Past 1 (a longer reach): eased to 1, then on in a straight line.
  const e = explode <= 1 ? easeInOut(explode) : explode;
  for (const a of animated) {
    a.obj.position.copy(a.home).addScaledVector(a.out, e);
    if (a.bob) a.obj.position.y += Math.sin(t * 1.6 + a.phase) * a.bob;
    if (a.spin) {
      a.obj.rotation.x += D(a.spin.x) * dt;
      a.obj.rotation.y += D(a.spin.y) * dt;
      a.obj.rotation.z += D(a.spin.z) * dt;
    }
  }
}

const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/* ------------------------------ the sandbox ------------------------------ */

/**
 * Runs a hologram's script: in an iframe with only scripts allowed (no
 * same-origin, so no cookies, no page, no API), inside a worker there, so a
 * loop that never ends is cut off after two seconds.
 */
const SANDBOX = `<!doctype html><script>
const WORKER = ${JSON.stringify(`
  let seed = 1234567;
  const rand = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const api = { range: (n) => Array.from({ length: Math.max(0, Math.min(5000, n|0)) }, (_, i) => i), lerp: (a, b, t) => a + (b - a) * t, rand, TAU: Math.PI * 2, deg: (r) => r * 180 / Math.PI };
  self.onmessage = (e) => {
    try {
      const out = new Function("api", e.data)(api);
      if (!Array.isArray(out)) throw new Error("The script must return an array of parts.");
      self.postMessage({ ok: true, parts: JSON.parse(JSON.stringify(out)) });
    } catch (err) { self.postMessage({ ok: false, error: String(err && err.message || err) }); }
  };
`)};
window.addEventListener("message", (e) => {
  const { id, code } = e.data || {};
  let done = false;
  const reply = (r) => { if (done) return; done = true; parent.postMessage({ id, ...r }, "*"); };
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }))); }
  catch (err) { reply({ ok: false, error: "No worker in the sandbox: " + err }); return; }
  const t = setTimeout(() => { w.terminate(); reply({ ok: false, error: "The script ran past 2 seconds." }); }, 2000);
  w.onmessage = (m) => { clearTimeout(t); w.terminate(); reply(m.data); };
  w.onerror = (m) => { clearTimeout(t); w.terminate(); reply({ ok: false, error: m.message || "Script error" }); };
  w.postMessage(code);
});
</script>`;

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
const waiting = new Map<string, (r: { ok: boolean; parts?: Part[]; error?: string }) => void>();

function sandbox() {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.display = "none";
    frame.srcdoc = SANDBOX;
    frame.onload = () => resolve();
    document.body.appendChild(frame);
    window.addEventListener("message", (e) => {
      if (e.source !== frame?.contentWindow) return;
      const d = e.data as { id?: string; ok: boolean; parts?: Part[]; error?: string };
      if (!d?.id) return;
      waiting.get(d.id)?.(d);
      waiting.delete(d.id);
    });
  });
  return ready;
}

export async function runScript(code: string): Promise<{ ok: boolean; parts?: Part[]; error?: string }> {
  await sandbox();
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    frame!.contentWindow!.postMessage({ id, code }, "*");
    // The sandbox's own clock should answer first; this is the backstop.
    setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      resolve({ ok: false, error: "The sandbox didn't answer." });
    }, 5000);
  });
}
