import * as THREE from "three";
import { ARCH_KINDS, STATUSES, type Board, type Presence, type Step } from "../../shared/board";
import type { ItemView } from "./items";
import { LOOK, STATUS_COLOR, labelSprite } from "./look";
import { num, on } from "./tune";

/**
 * What the workshop draws over the board, apart from the items:
 *
 *  - pins: a dotted thread from a pinned note to what it's pinned to;
 *  - the progress ring round the table's rim: how much is done, at risk;
 *  - ghosts: the other screens on this board (a desktop's camera, a headset's head and hands);
 *  - the player: a request flowing hop by hop, or a guided tour;
 *  - layers: kinds hidden, or items isolated with the rest dimmed;
 *  - the boot: the table powering up when a board opens.
 */

export type Layers = { hide: string[]; isolate: string[] | null };

/** Which layer an item is in, for hiding by kind. */
export function layerOf(kind: string): string {
  if ((ARCH_KINDS as readonly string[]).includes(kind)) return "architecture";
  if (kind === "note" || kind === "text") return "notes";
  if (kind === "frame") return "frames";
  if (kind === "holo") return "holograms";
  return kind;
}

type Ghost = { group: THREE.Group; at: number; head: THREE.Mesh; hands: THREE.Mesh[]; rays: THREE.Line[]; tag: THREE.Sprite; mode: string };

export class Fx {
  readonly group = new THREE.Group();
  private pins = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({ color: LOOK.cyan, dashSize: 0.008, gapSize: 0.008, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }),
  );
  private ring = new THREE.Group();
  private ringKey = "";
  private ghosts = new Map<string, Ghost>();
  private comet: THREE.Mesh;
  private trail: THREE.Points;
  private play: { kind: "flow" | "tour"; steps: Step[]; i: number; t0: number; title?: string; curve?: THREE.Curve<THREE.Vector3> } | null = null;
  private boot: { t0: number; rings: THREE.Mesh[]; tag: THREE.Sprite } | null = null;
  layers: Layers = { hide: [], isolate: null };
  /** What the player is saying now (the page shows it as a caption). */
  caption: { text: string; title?: string; step: number; of: number } | null = null;
  onCaption?: () => void;

  constructor(
    private views: Map<string, ItemView>,
    private focus: (ids: string[]) => void,
    private hoverIds: (ids: string[]) => void,
  ) {
    this.pins.frustumCulled = false;
    this.group.add(this.pins, this.ring);
    this.comet = new THREE.Mesh(
      new THREE.SphereGeometry(0.014, 16, 12),
      new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.comet.visible = false;
    const tp = new Float32Array(40 * 3);
    this.trail = new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(tp, 3)),
      new THREE.PointsMaterial({ color: LOOK.accent, size: 0.012, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    this.group.add(this.comet, this.trail);
  }

  /* --------------------------------- bursts --------------------------------- */

  private bursts: { pts: THREE.Points; vel: Float32Array; t0: number }[] = [];

  /** Sparks flying out of a point (board space): something crumpled, erased, or arriving. */
  burst(at: THREE.Vector3, color: string, n = 60, speed = 0.5) {
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([at.x, at.y, at.z], i * 3);
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.1, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      vel.set([d.x, d.y, d.z], i * 3);
    }
    const pts = new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(pos, 3)),
      new THREE.PointsMaterial({ color, size: 0.01, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    pts.frustumCulled = false;
    pts.userData.noPick = true;
    this.group.add(pts);
    this.bursts.push({ pts, vel, t0: performance.now() });
  }

  private tickBursts() {
    const now = performance.now();
    this.bursts = this.bursts.filter((b) => {
      const age = (now - b.t0) / 1000;
      if (age > 0.9) {
        b.pts.removeFromParent();
        b.pts.geometry.dispose();
        (b.pts.material as THREE.Material).dispose();
        return false;
      }
      const attr = b.pts.geometry.getAttribute("position") as THREE.BufferAttribute;
      const dt = 1 / 72;
      for (let i = 0; i < attr.count; i++) {
        b.vel[i * 3 + 1] -= 0.9 * dt;
        attr.setXYZ(i, attr.getX(i) + b.vel[i * 3] * dt, Math.max(0, attr.getY(i) + b.vel[i * 3 + 1] * dt), attr.getZ(i) + b.vel[i * 3 + 2] * dt);
      }
      attr.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = 1 - age / 0.9;
      return true;
    });
  }

  /* ---------------------------------- board ---------------------------------- */

  update(b: Board) {
    // Pins: from each pinned item's middle to what it's pinned to.
    const pts: number[] = [];
    for (const it of b.items) {
      if (!it.attach) continue;
      const a = this.views.get(it.id);
      const p = this.views.get(it.attach);
      if (!a || !p || a.hidden || p.hidden) continue;
      const ca = a.root.position.clone().setY(a.root.position.y + a.midY * a.root.scale.x);
      const cp = p.root.position.clone().setY(p.root.position.y + p.midY * p.root.scale.x);
      pts.push(ca.x, ca.y, ca.z, cp.x, cp.y, cp.z);
    }
    this.pins.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.pins.computeLineDistances();

    // The progress ring: arcs by status round the rim, and a count.
    const counted = b.items.filter((i) => i.status);
    const key = JSON.stringify([on("statusRing"), STATUSES.map((s) => counted.filter((i) => i.status === s).length)]);
    if (key !== this.ringKey) {
      this.ringKey = key;
      this.buildRing(b);
    }
    this.applyLayers(b);
  }

  private buildRing(b: Board) {
    for (const c of [...this.ring.children]) {
      this.ring.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    if (!on("statusRing")) return;
    const counted = b.items.filter((i) => i.status);
    if (!counted.length) return;
    const R = 1.47;
    let a = -Math.PI / 2 - 0.9;
    const span = 1.8;
    for (const s of STATUSES) {
      const n = counted.filter((i) => i.status === s).length;
      if (!n) continue;
      const da = (n / counted.length) * span;
      const pts = Array.from({ length: 24 }, (_, k) => {
        const t = a + (da * k) / 23;
        return new THREE.Vector3(Math.cos(t) * R, 0.004, Math.sin(t) * R);
      });
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.006, 6),
        new THREE.MeshBasicMaterial({ color: STATUS_COLOR[s], transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      );
      this.ring.add(tube);
      a += da + 0.015;
    }
    const done = counted.filter((i) => i.status === "done").length;
    const risk = counted.filter((i) => i.status === "risk").length;
    const tag = labelSprite(`${done}/${counted.length} done${risk ? ` · ${risk} at risk` : ""}`, risk ? LOOK.danger : LOOK.cyan, { height: 0.045, bracket: false });
    tag.position.set(0, 0.02, -R - 0.04);
    this.ring.add(tag);
  }

  /* --------------------------------- layers --------------------------------- */

  setLayers(l: Partial<Layers>, b: Board | null) {
    this.layers = { hide: l.hide ?? this.layers.hide, isolate: l.isolate === undefined ? this.layers.isolate : l.isolate };
    if (b) this.applyLayers(b);
  }

  private applyLayers(b: Board) {
    const hide = new Set(this.layers.hide.map((h) => h.toLowerCase().replace(/s$/, "")));
    const iso = this.layers.isolate ? new Set(this.layers.isolate) : null;
    for (const it of b.items) {
      const v = this.views.get(it.id);
      if (!v) continue;
      const layer = layerOf(it.kind).replace(/s$/, "");
      v.hidden = hide.has(layer) || hide.has(it.kind);
      v.root.visible = !v.hidden;
      v.dim = iso ? !iso.has(it.id) : false;
    }
  }

  get linksHidden() {
    return this.layers.hide.some((h) => h.toLowerCase().startsWith("link"));
  }

  /* --------------------------------- ghosts --------------------------------- */

  /** Another screen on this board moved (positions in board space). */
  presence(p: Presence) {
    let g = this.ghosts.get(p.id);
    if (!g || g.mode !== p.mode) {
      if (g) this.group.remove(g.group);
      g = this.makeGhost(p.mode);
      this.ghosts.set(p.id, g);
      this.group.add(g.group);
    }
    g.at = performance.now();
    g.head.position.set(...p.head);
    g.head.lookAt(new THREE.Vector3(...p.look));
    g.tag.position.set(p.head[0], p.head[1] + 0.07, p.head[2]);
    g.hands.forEach((h, i) => {
      const hp = p.hands?.[i];
      h.visible = !!hp;
      g!.rays[i].visible = !!hp?.to;
      if (hp) {
        h.position.set(...hp.at);
        if (hp.to) {
          const pos = g!.rays[i].geometry.getAttribute("position") as THREE.BufferAttribute;
          pos.setXYZ(0, ...hp.at);
          pos.setXYZ(1, ...hp.to);
          pos.needsUpdate = true;
        }
      }
    });
  }

  private makeGhost(mode: string): Ghost {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: LOOK.accent, wireframe: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    // A desktop is a camera: a little frustum. A headset is a visor.
    const head = new THREE.Mesh(mode === "flat" ? new THREE.ConeGeometry(0.04, 0.07, 4, 1, true).rotateX(-Math.PI / 2).rotateZ(Math.PI / 4) : new THREE.SphereGeometry(0.05, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), mat);
    group.add(head);
    const hands = [0, 1].map(() => new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), mat));
    const rays = [0, 1].map(() => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: LOOK.accent, transparent: true, opacity: 0.5, toneMapped: false }));
      l.frustumCulled = false;
      l.visible = false;
      return l;
    });
    for (const h of hands) h.visible = false;
    group.add(...hands, ...rays);
    const tag = labelSprite(mode === "flat" ? "desk" : mode === "ar" ? "headset" : "VR", LOOK.accent, { height: 0.022, bracket: false });
    group.add(tag);
    return { group, at: performance.now(), head, hands, rays, tag, mode };
  }

  /* --------------------------------- player --------------------------------- */

  start(kind: "flow" | "tour", steps: Step[], title?: string) {
    this.play = steps.length ? { kind, steps, i: -1, t0: 0, title } : null;
    this.next();
  }

  stop() {
    this.play = null;
    this.comet.visible = false;
    this.trail.visible = false;
    this.caption = null;
    this.hoverIds([]);
    this.onCaption?.();
  }

  get playing() {
    return !!this.play;
  }

  private stepMs(s: Step) {
    const words = (s.say ?? "").split(/\s+/).length;
    return Math.max(this.play?.kind === "flow" ? 2200 : 3500, words * 330);
  }

  private next() {
    const p = this.play;
    if (!p) return;
    p.i++;
    if (p.i >= p.steps.length) return this.stop();
    p.t0 = performance.now();
    const s = p.steps[p.i];
    this.caption = { text: s.say ?? "", title: p.title, step: p.i + 1, of: p.steps.length };
    this.onCaption?.();
    if (p.kind === "tour") {
      if (s.ids?.length) {
        this.focus(s.ids);
        this.hoverIds(s.ids);
      }
      p.curve = undefined;
      return;
    }
    const a = s.from ? this.views.get(s.from) : null;
    const b = s.to ? this.views.get(s.to) : null;
    if (!a || !b) return;
    this.hoverIds([a.id, b.id]);
    const ca = a.root.position.clone().setY(a.root.position.y + a.midY * a.root.scale.x);
    const cb = b.root.position.clone().setY(b.root.position.y + b.midY * b.root.scale.x);
    const mid = ca.clone().lerp(cb, 0.5);
    mid.y += (0.04 + ca.distanceTo(cb) * 0.12) * num("arcHeight") + 0.01;
    p.curve = new THREE.QuadraticBezierCurve3(ca, mid, cb);
  }

  /* ---------------------------------- boot ---------------------------------- */

  /** The table powering up: rings racing out from the middle, and the board's name. */
  startBoot(name: string) {
    this.endBoot();
    const rings = [0, 1, 2].map((k) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.97, 1, 96).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: k === 1 ? LOOK.accent : LOOK.cyan, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
      );
      m.position.y = 0.003 + k * 0.001;
      this.group.add(m);
      return m;
    });
    const tag = labelSprite(`Workshop online · ${name}`, LOOK.cyan, { height: 0.06 });
    tag.position.set(0, 0.35, 0);
    tag.material.opacity = 0;
    this.group.add(tag);
    this.boot = { t0: performance.now(), rings, tag };
  }

  private endBoot() {
    if (!this.boot) return;
    for (const r of this.boot.rings) {
      this.group.remove(r);
      r.geometry.dispose();
    }
    this.group.remove(this.boot.tag);
    this.boot = null;
  }

  /* ---------------------------------- frame ---------------------------------- */

  tick(t: number) {
    if (this.bursts.length) this.tickBursts();
    const now = performance.now();
    // Ghosts nobody's heard from in a while go.
    for (const [id, g] of this.ghosts) {
      if (now - g.at > 5000) {
        this.group.remove(g.group);
        this.ghosts.delete(id);
      }
    }
    for (const g of this.ghosts.values()) (g.head.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.3 * Math.sin(t * 3);

    const p = this.play;
    if (p) {
      const s = p.steps[p.i];
      const k = (now - p.t0) / this.stepMs(s);
      if (p.kind === "flow" && p.curve) {
        const u = Math.min(1, k * 1.6);
        const at = p.curve.getPoint(u);
        this.comet.position.copy(at);
        this.comet.visible = true;
        this.comet.scale.setScalar(1 + 0.4 * Math.sin(t * 20));
        const pos = this.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const q = p.curve.getPoint(Math.max(0, u - i * 0.012));
          pos.setXYZ(i, q.x, q.y, q.z);
        }
        pos.needsUpdate = true;
        this.trail.visible = true;
      } else {
        this.comet.visible = false;
        this.trail.visible = false;
      }
      if (k >= 1) this.next();
    }

    const b = this.boot;
    if (b) {
      const k = (now - b.t0) / 2200;
      b.rings.forEach((r, i) => {
        const kk = Math.max(0, Math.min(1, k * 1.4 - i * 0.18));
        r.scale.setScalar(0.05 + kk * 1.42);
        (r.material as THREE.MeshBasicMaterial).opacity = Math.sin(kk * Math.PI) * 0.9;
      });
      b.tag.material.opacity = k < 0.25 ? k / 0.25 : k > 0.8 ? Math.max(0, (1 - k) / 0.2) : 1;
      b.tag.position.y = 0.3 + k * 0.08;
      if (k >= 1) this.endBoot();
    }
  }
}
