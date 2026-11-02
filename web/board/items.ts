import * as THREE from "three";
import { colorOf, heightOf, type Item } from "../../shared/board";
import { animateHolo, buildHolo, type Animated } from "./holo";
import { LOOK, STATUS_COLOR, holoMesh, holoUniforms, labelSprite, lineMaterial, noteTexture, type HoloUniforms } from "./look";

/**
 * One item on the board, drawn. Built once from what the item is, and only
 * rebuilt when that changes; moving, turning, scaling, exploding and lighting
 * it up are cheap.
 */

const PRINT_MS = 900;

/** What's drawn, apart from where it stands: a change here rebuilds it. */
function shapeKey(i: Item) {
  const { pos: _p, rotY: _r, quat: _q, scale: _s, explode: _e, spin: _sp, ...rest } = i;
  return JSON.stringify(rest);
}

export class ItemView {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  readonly u: HoloUniforms = holoUniforms();
  private key = "";
  private animated: Animated[] = [];
  private sprites: THREE.Sprite[] = [];
  private selRing: THREE.Object3D | null = null;
  private born = 0;
  private explodeNow = 0;
  private spinAngle = 0;
  /** Bounding radius (m, at scale 1) and the height of its middle: for picking, framing and the selection ring. */
  radius = 0.1;
  midY = 0.06;
  item: Item;
  lit = 0;
  selected = false;
  /** Fading out on its way to the bin. */
  dying = 0;

  constructor(item: Item, fresh: boolean) {
    this.item = item;
    this.root.userData.itemId = item.id;
    this.root.add(this.body);
    this.build(item);
    this.place(item);
    if (fresh) this.born = performance.now();
  }

  get id() {
    return this.item.id;
  }

  update(item: Item) {
    const rebuild = shapeKey(item) !== this.key;
    this.item = item;
    if (rebuild) this.build(item);
    this.place(item);
  }

  /** Where it stands: from the item, or (while it's held) wherever the hand puts it. */
  place(item: Pick<Item, "pos" | "rotY" | "quat" | "scale">) {
    this.root.position.set(...item.pos);
    if (item.quat) this.root.quaternion.set(...item.quat);
    else this.root.rotation.set(0, THREE.MathUtils.degToRad(item.rotY ?? 0), 0);
    this.root.scale.setScalar(item.scale ?? 1);
  }

  private clear() {
    this.body.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        (x as THREE.MeshBasicMaterial).map?.dispose();
        x.dispose();
      }
    });
    this.body.clear();
    this.animated = [];
    this.sprites = [];
    this.selRing = null;
  }

  private build(item: Item) {
    this.clear();
    this.key = shapeKey(item);
    const color = colorOf(item.color);
    const u = this.u;
    const b = this.body;
    let labelY = heightOf({ ...item, scale: 1 }) + 0.025;
    let label: string | undefined = item.label;

    switch (item.kind) {
      case "note": {
        const [w, h] = item.size ?? [0.22, 0.16];
        const ppm = 2300;
        const tex = noteTexture(item.body ?? "", color, Math.round(w * ppm), Math.round(h * ppm), item.label);
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(w, h),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
        );
        const stand = new THREE.Group();
        stand.position.y = h / 2 + 0.03;
        stand.rotation.x = -0.18;
        stand.add(plane);
        b.add(stand);
        b.add(pad(u, color, Math.max(w, 0.1) * 0.45));
        label = undefined;
        this.radius = Math.hypot(w, h) / 2;
        this.midY = h / 2 + 0.03;
        break;
      }
      case "text": {
        const s = labelSprite(item.body || item.label || "Text", color, { height: 0.06, bracket: false });
        s.position.y = 0.01;
        b.add(s);
        this.sprites.push(s);
        // Something solid to point at.
        const hit = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.02), new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.y = 0.04;
        b.add(hit);
        label = undefined;
        this.radius = 0.12;
        this.midY = 0.04;
        break;
      }
      case "frame": {
        const [w, d] = item.size ?? [0.8, 0.5];
        const pts = [new THREE.Vector3(-w / 2, 0.003, -d / 2), new THREE.Vector3(w / 2, 0.003, -d / 2), new THREE.Vector3(w / 2, 0.003, d / 2), new THREE.Vector3(-w / 2, 0.003, d / 2)];
        b.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMaterial(u, color, 0.45)));
        // Bright corner brackets.
        const k = Math.min(w, d) * 0.12;
        const corners: THREE.Vector3[] = [];
        for (const [x, z, sx, sz] of [
          [-w / 2, -d / 2, 1, 1],
          [w / 2, -d / 2, -1, 1],
          [w / 2, d / 2, -1, -1],
          [-w / 2, d / 2, 1, -1],
        ]) {
          corners.push(new THREE.Vector3(x, 0.004, z + sz * k), new THREE.Vector3(x, 0.004, z), new THREE.Vector3(x, 0.004, z), new THREE.Vector3(x + sx * k, 0.004, z));
        }
        b.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(corners), lineMaterial(u, color, 1)));
        // A flat wash, not a hologram's rim: seen from an angle, a rim would light the whole plane.
        const fill = new THREE.Mesh(
          new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(0, 0.002, 0),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
        );
        b.add(fill);
        if (item.label) {
          const s = labelSprite(item.label, color, { height: 0.05, bracket: false });
          s.center.set(0, 0);
          s.position.set(-w / 2 + 0.01, 0.01, -d / 2);
          b.add(s);
          this.sprites.push(s);
        }
        label = undefined;
        this.radius = Math.hypot(w, d) / 2;
        this.midY = 0;
        break;
      }
      case "ink": {
        const pts = (item.points ?? []).map((p) => new THREE.Vector3(...p));
        if (pts.length >= 2) {
          const curve = new THREE.CatmullRomCurve3(pts);
          const geo = new THREE.TubeGeometry(curve, Math.min(600, pts.length * 3), (item.width ?? 0.005) / 2, 6);
          b.add(holoMesh(geo, u, color, { opacity: 0.65, edgeAngle: 89 }));
          const box = new THREE.Box3().setFromPoints(pts);
          this.radius = Math.max(0.03, box.getSize(new THREE.Vector3()).length() / 2);
          this.midY = box.getCenter(new THREE.Vector3()).y;
        }
        label = undefined;
        break;
      }
      case "holo": {
        const parts = item.holo?.parts ?? [];
        if (parts.length) {
          const built = buildHolo(parts, u, color);
          b.add(built.group);
          this.animated = built.animated;
          const box = new THREE.Box3().setFromObject(built.group);
          const size = box.getSize(new THREE.Vector3());
          this.radius = Math.max(0.06, size.length() / 2);
          this.midY = box.getCenter(new THREE.Vector3()).y;
          labelY = box.max.y + 0.04;
        } else {
          // Still building (a script on its way), or empty.
          const ph = holoMesh(new THREE.IcosahedronGeometry(0.08, 0), u, color, { wire: true });
          ph.position.y = 0.12;
          b.add(ph);
          this.animated = [{ obj: ph, home: ph.position.clone(), out: new THREE.Vector3(), spin: new THREE.Vector3(30, 60, 0), phase: 0 }];
          this.radius = 0.1;
          this.midY = 0.12;
          labelY = 0.25;
        }
        b.add(pad(u, color, Math.min(0.25, this.radius * 0.7)));
        break;
      }
      default: {
        const g = archShape(item.kind, u, color);
        g.traverse((o) => {
          if (o.userData.spin) this.animated.push({ obj: o, home: o.position.clone(), out: new THREE.Vector3(), spin: new THREE.Vector3(25, 45, 0), phase: 0 });
        });
        b.add(g);
        b.add(pad(u, color, 0.085));
        this.radius = 0.1;
        this.midY = 0.06;
      }
    }

    if (item.status) {
      const ring = statusRing(u, STATUS_COLOR[item.status] ?? LOOK.cyan, Math.max(0.07, Math.min(0.3, this.radius * 0.75)));
      b.add(ring);
    }

    if (label) {
      const sub = [item.status && item.status !== "planned" ? item.status : "", ...(item.tags ?? [])].filter(Boolean).join(" · ");
      const err = item.kind === "holo" && item.holo?.error ? "script error" : item.kind === "holo" && item.holo?.script && !item.holo.parts?.length ? "building…" : "";
      const s = labelSprite(label, err === "script error" ? LOOK.danger : color, { height: 0.042, sub: err || sub || undefined });
      s.position.y = labelY;
      b.add(s);
      this.sprites.push(s);
    }
  }

  /** Light it up (hovered, selected), print it in, and run its animations. */
  tick(t: number, dt: number) {
    const want = this.selected ? 1 : this.lit;
    this.u.uLit.value += (want - this.u.uLit.value) * Math.min(1, dt * 10);

    if (this.born) {
      const k = Math.min(1, (performance.now() - this.born) / PRINT_MS);
      this.u.uReveal.value = k;
      const box = new THREE.Box3().setFromObject(this.body);
      this.u.uBase.value = box.min.y;
      this.u.uHeight.value = Math.max(0.02, box.max.y - box.min.y);
      for (const s of this.sprites) s.material.opacity = k;
      if (k >= 1) this.born = 0;
    }

    if (this.dying) {
      this.dying = Math.max(0, this.dying - dt * 2.5);
      this.u.uFade.value = this.dying;
      for (const s of this.sprites) s.material.opacity = this.dying;
    }

    if (this.item.kind === "holo") {
      const target = this.item.explode ?? 0;
      this.explodeNow += (target - this.explodeNow) * Math.min(1, dt * 6);
      if (this.item.spin) this.spinAngle += dt * 0.35;
      this.body.rotation.y = this.spinAngle;
    }
    if (this.animated.length) animateHolo(this.animated, this.explodeNow, t, dt);

    // The selection: an amber ring turning on the table under it.
    if (this.selected && !this.selRing) {
      this.selRing = selectionRing(Math.max(0.08, Math.min(0.9, this.radius * 0.9)));
      this.root.add(this.selRing);
    } else if (!this.selected && this.selRing) {
      this.root.remove(this.selRing);
      this.selRing = null;
    }
    if (this.selRing) this.selRing.rotation.y = t * 0.6;
  }

  /** Where its middle is, in world space. */
  center(out = new THREE.Vector3()) {
    return this.root.localToWorld(out.set(0, this.midY, 0));
  }

  dispose() {
    this.clear();
    this.root.removeFromParent();
  }
}

/* ------------------------------- shapes -------------------------------- */

function pad(u: HoloUniforms, color: string, r: number) {
  const g = new THREE.Group();
  const ring = (rr: number, op: number) => {
    const pts = Array.from({ length: 64 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2) * rr, 0.003, Math.sin((i / 64) * Math.PI * 2) * rr));
    return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMaterial(u, color, op));
  };
  g.add(ring(r, 0.55), ring(r * 0.75, 0.2));
  return g;
}

function statusRing(u: HoloUniforms, color: string, r: number) {
  const g = new THREE.Group();
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 12; i++) {
    const a0 = (i / 12) * Math.PI * 2;
    const a1 = a0 + 0.32;
    for (let k = 0; k < 6; k++) {
      const a = a0 + ((a1 - a0) * k) / 5;
      const b = a0 + ((a1 - a0) * (k + 1)) / 5;
      if (k < 5) pts.push(new THREE.Vector3(Math.cos(a) * r, 0.004, Math.sin(a) * r), new THREE.Vector3(Math.cos(b) * r, 0.004, Math.sin(b) * r));
    }
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMaterial(u, color, 1, 0.6)));
  return g;
}

function selectionRing(r: number) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * Math.PI * 2;
    for (let k = 0; k < 10; k++) {
      const a = a0 + (k / 10) * 1.1;
      const b = a0 + ((k + 1) / 10) * 1.1;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0.006, Math.sin(a) * r), new THREE.Vector3(Math.cos(b) * r, 0.006, Math.sin(b) * r));
    }
  }
  const m = new THREE.LineBasicMaterial({ color: LOOK.select, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), m);
  l.userData.noPick = true;
  return l;
}

/** The architecture blocks: each a small hologram standing on the table, about 12 cm tall. */
function archShape(kind: Item["kind"], u: HoloUniforms, color: string): THREE.Group {
  const g = new THREE.Group();
  const m = (geo: THREE.BufferGeometry, o?: Parameters<typeof holoMesh>[3]) => holoMesh(geo, u, color, o);
  const at = (o: THREE.Object3D, x: number, y: number, z = 0) => (o.position.set(x, y, z), o);
  switch (kind) {
    case "database":
      for (let k = 0; k < 3; k++) g.add(at(m(new THREE.CylinderGeometry(0.065, 0.065, 0.03, 32)), 0, 0.02 + k * 0.038));
      break;
    case "queue": {
      const tube = m(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 20, 1, true).rotateZ(Math.PI / 2), { opacity: 0.06 });
      g.add(at(tube, 0, 0.06));
      for (let k = 0; k < 4; k++) {
        const msg = m(new THREE.BoxGeometry(0.03, 0.03, 0.03), { opacity: 0.2 });
        g.add(at(msg, -0.075 + k * 0.05, 0.06));
      }
      g.add(at(m(new THREE.TorusGeometry(0.038, 0.004, 6, 24).rotateY(Math.PI / 2)), -0.1, 0.06), at(m(new THREE.TorusGeometry(0.038, 0.004, 6, 24).rotateY(Math.PI / 2)), 0.1, 0.06));
      break;
    }
    case "api":
      g.add(at(m(new THREE.CylinderGeometry(0.075, 0.075, 0.07, 6)), 0, 0.05));
      g.add(at(m(new THREE.TorusGeometry(0.095, 0.003, 6, 48).rotateX(Math.PI / 2), { pulse: 0.6 }), 0, 0.05));
      break;
    case "client": {
      g.add(at(m(new THREE.BoxGeometry(0.18, 0.11, 0.008)), 0, 0.1));
      g.add(at(m(new THREE.BoxGeometry(0.15, 0.08, 0.001), { opacity: 0.22 }), 0, 0.1, 0.005));
      g.add(at(m(new THREE.CylinderGeometry(0.006, 0.006, 0.04, 8)), 0, 0.025));
      g.add(at(m(new THREE.CylinderGeometry(0.04, 0.04, 0.005, 24)), 0, 0.004));
      break;
    }
    case "user":
      g.add(at(m(new THREE.SphereGeometry(0.03, 16, 12)), 0, 0.13));
      g.add(at(m(new THREE.CylinderGeometry(0.025, 0.055, 0.09, 20)), 0, 0.05));
      break;
    case "cache":
      g.add(at(m(new THREE.OctahedronGeometry(0.06, 0), { pulse: 0.5 }), 0, 0.07));
      g.add(at(m(new THREE.TorusGeometry(0.075, 0.002, 6, 48).rotateX(Math.PI / 2.4)), 0, 0.07));
      break;
    case "storage":
      g.add(at(m(new THREE.CylinderGeometry(0.075, 0.055, 0.1, 28, 1, true)), 0, 0.055));
      g.add(at(m(new THREE.TorusGeometry(0.075, 0.003, 6, 48).rotateX(Math.PI / 2)), 0, 0.105));
      break;
    case "function": {
      g.add(at(m(new THREE.TetrahedronGeometry(0.06, 0)), 0, 0.07));
      g.add(at(m(new THREE.TorusGeometry(0.08, 0.002, 6, 48).rotateX(1.2)), 0, 0.07));
      break;
    }
    case "external":
      g.add(at(m(new THREE.DodecahedronGeometry(0.06, 0), { wire: true }), 0, 0.07));
      g.add(at(m(new THREE.SphereGeometry(0.03, 12, 8), { opacity: 0.15 }), 0, 0.07));
      break;
    case "cloud":
      for (const [x, y, r] of [
        [-0.05, 0.05, 0.04],
        [0, 0.07, 0.055],
        [0.055, 0.05, 0.04],
        [0.02, 0.035, 0.035],
      ] as const)
        g.add(at(m(new THREE.SphereGeometry(r, 16, 10), { opacity: 0.07 }), x, y));
      break;
    default: {
      // A service: a box, and a core turning inside it.
      g.add(at(m(new THREE.BoxGeometry(0.14, 0.1, 0.14)), 0, 0.055));
      const core = m(new THREE.BoxGeometry(0.05, 0.05, 0.05), { opacity: 0.3, pulse: 0.4 });
      core.position.y = 0.055;
      core.rotation.set(0.6, 0.6, 0);
      core.userData.spin = true;
      g.add(core);
    }
  }
  return g;
}
