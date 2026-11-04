import * as THREE from "three";
import { PROTOCOLS, colorOf, protocolOf, type Link, type Protocol } from "../../shared/board";
import type { ItemView } from "./items";
import { LOOK, flatCapable, labelSprite, linkMaterial } from "./look";
import { num, on, tuneRev } from "./tune";

/**
 * A link: an arc of light from one item to another with packets running
 * along it, source to target. Sync links are solid, async ones dashed, data
 * flows thick, dependencies thin and faint.
 */

const STYLE: Record<string, { color: string; radius: number; dashed: boolean; opacity: number; speed: number }> = {
  sync: { color: LOOK.cyan, radius: 0.0022, dashed: false, opacity: 0.9, speed: 1.2 },
  async: { color: "#ffb547", radius: 0.0022, dashed: true, opacity: 0.95, speed: 0.8 },
  data: { color: "#3ef2c9", radius: 0.0042, dashed: false, opacity: 1, speed: 1.6 },
  depends: { color: "#7fa6bd", radius: 0.0012, dashed: false, opacity: 0.5, speed: 0.5 },
};

/** Each protocol's look: its shader mode, how thick, how fast, and its name on the label. */
const PROTO: Record<Protocol, { mode: number; width: number; speed: number; name: string }> = {
  rest: { mode: 1, width: 1, speed: 1, name: "REST" },
  grpc: { mode: 2, width: 0.8, speed: 1, name: "gRPC" },
  graphql: { mode: 3, width: 1, speed: 1, name: "GraphQL" },
  kafka: { mode: 4, width: 1.25, speed: 1, name: "Kafka" },
  amqp: { mode: 5, width: 1.1, speed: 1, name: "Queue" },
  websocket: { mode: 6, width: 1, speed: 1, name: "WebSocket" },
  sql: { mode: 7, width: 1.6, speed: 1, name: "SQL" },
  http: { mode: 8, width: 1, speed: 1, name: "HTTP" },
  events: { mode: 9, width: 1, speed: 1, name: "Events" },
  file: { mode: 10, width: 1.7, speed: 1, name: "Files" },
};
void PROTOCOLS;

/** A sample message as a small card of light: the first few lines, in mono. */
function sampleSprite(text: string, color: string) {
  const lines = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/.{1,30}(\s|$)|.{30}/g)
    ?.slice(0, 3)
    .map((l) => l.trim()) ?? [text.slice(0, 30)];
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const px = 30;
  ctx.font = `500 ${px}px "JetBrains Mono", ui-monospace, monospace`;
  const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width)) + 36);
  const h = lines.length * (px + 8) + 26;
  c.width = w;
  c.height = h;
  ctx.fillStyle = "rgba(2, 12, 22, 0.78)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
  ctx.font = `500 ${px}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = "#e8f6ff";
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  lines.forEach((l, i) => ctx.fillText(l, 18, 18 + px * 0.85 + i * (px + 8)));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(flatCapable(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })));
  const height = 0.018 * (lines.length + 0.8);
  s.scale.set((height * w) / h, height, 1);
  s.userData.noPick = true;
  return s;
}

export class LinkView {
  readonly root = new THREE.Group();
  private tube: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial> | null = null;
  private heads: THREE.Mesh[] = [];
  private label: THREE.Sprite | null = null;
  private ends = "";
  private key = "";
  private born = 0;
  private curve: THREE.Curve<THREE.Vector3> | null = null;
  private sample: THREE.Sprite | null = null;
  private sampleT = -1;
  private nextSample = performance.now() + 1500 + Math.random() * 4000;
  link: Link;
  lit = 0;

  constructor(link: Link, fresh: boolean) {
    this.link = link;
    this.root.userData.linkId = link.id;
    if (fresh) this.born = performance.now();
  }

  get id() {
    return this.link.id;
  }

  /** Follow its two items; rebuilt only when either moved or the link itself changed. */
  update(link: Link, a: ItemView, b: ItemView) {
    const key = `${tuneRev}|${JSON.stringify(link)}`;
    const pa = a.root.position;
    const pb = b.root.position;
    const ends = `${pa.x.toFixed(3)},${pa.y.toFixed(3)},${pa.z.toFixed(3)}|${pb.x.toFixed(3)},${pb.y.toFixed(3)},${pb.z.toFixed(3)}|${a.root.scale.x.toFixed(2)}|${b.root.scale.x.toFixed(2)}`;
    if (key === this.key && ends === this.ends) return;
    this.link = link;
    this.key = key;
    this.ends = ends;
    this.rebuild(a, b);
  }

  private rebuild(a: ItemView, b: ItemView) {
    this.clear();
    const st = STYLE[this.link.style ?? "sync"] ?? STYLE.sync;
    const color = this.link.color ? colorOf(this.link.color) : st.color;
    const proto = on("protocolStyles") ? protocolOf(this.link) : null;
    const pr = proto ? PROTO[proto] : null;
    const ca = new THREE.Vector3(0, a.midY * a.root.scale.x, 0).add(a.root.position);
    const cb = new THREE.Vector3(0, b.midY * b.root.scale.x, 0).add(b.root.position);
    // Leave from the edge of each item, not its middle.
    const dir = cb.clone().sub(ca);
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const d = dir.length();
    const ra = Math.min(a.radius * a.root.scale.x * 0.7, d * 0.3);
    const rb = Math.min(b.radius * b.root.scale.x * 0.7, d * 0.3);
    const start = ca.clone().addScaledVector(flat, ra);
    const end = cb.clone().addScaledVector(flat, -rb);
    const mid = start.clone().lerp(end, 0.5);
    mid.y += (0.04 + d * 0.12) * num("arcHeight");
    const via = on("drawnLinks") && this.link.via?.length ? this.link.via.map((p) => new THREE.Vector3(...p)) : null;
    const curve: THREE.Curve<THREE.Vector3> = via ? new THREE.CatmullRomCurve3([start, ...via, end], false, "centripetal") : new THREE.QuadraticBezierCurve3(start, mid, end);
    const len = curve.getLength();
    const mat = linkMaterial(color, { dashed: st.dashed && !pr, opacity: st.opacity, speed: st.speed * (pr?.speed ?? 1), len, proto: pr?.mode ?? 0 });
    const radius = st.radius * num("linkWidth") * (pr?.width ?? 1);
    this.curve = curve;
    this.tube = new THREE.Mesh(new THREE.TubeGeometry(curve, via ? 96 : 48, radius, 6), mat);
    this.tube.renderOrder = 4;
    this.root.add(this.tube);

    const head = (t: number, flip: boolean) => {
      const at = curve.getPoint(t);
      const tan = curve.getTangent(t).multiplyScalar(flip ? -1 : 1);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(radius * 3.2 + 0.004, 0.022, 12).translate(0, -0.011, 0),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
      );
      cone.position.copy(at);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan.normalize());
      this.heads.push(cone);
      this.root.add(cone);
    };
    if (on("arrows")) {
      head(1, false);
      if (this.link.both) head(0, true);
    }

    const text = [pr && !(this.link.label ?? "").toLowerCase().includes(pr.name.toLowerCase()) ? pr.name : "", this.link.label ?? ""].filter(Boolean).join(" · ");
    if (text && on("linkLabels") && on("labels")) {
      const s = labelSprite(text, color, { height: 0.03 * num("labelSize"), bracket: false });
      s.material.color.setScalar(num("labelBrightness"));
      s.position.copy(curve.getPoint(0.5)).add(new THREE.Vector3(0, 0.008, 0));
      this.label = s;
      this.root.add(s);
    }
  }

  tick(dt: number) {
    if (!this.tube) return;
    const m = this.tube.material;
    // A sample message riding along now and then.
    const now = performance.now();
    if (this.link.sample && on("payloadSamples") && this.curve && this.root.visible) {
      if (this.sampleT < 0 && now > this.nextSample) {
        this.sampleT = 0;
        if (!this.sample) {
          this.sample = sampleSprite(this.link.sample, (m.uniforms.uColor.value as THREE.Color).getStyle());
          this.root.add(this.sample);
        }
      }
      if (this.sampleT >= 0 && this.sample) {
        this.sampleT += dt / 2.4;
        const k = Math.min(1, this.sampleT);
        this.sample.position.copy(this.curve.getPoint(k)).add(new THREE.Vector3(0, 0.03, 0));
        this.sample.material.opacity = Math.min(1, k * 6, (1 - k) * 6);
        this.sample.visible = true;
        if (k >= 1) {
          this.sampleT = -1;
          this.sample.visible = false;
          this.nextSample = now + num("payloadEvery") * 1000 * (0.7 + Math.random() * 0.6);
        }
      }
    } else if (this.sample) this.sample.visible = false;
    m.uniforms.uLit.value += (this.lit - m.uniforms.uLit.value) * Math.min(1, dt * 10);
    if (this.born) {
      const k = Math.min(1, (performance.now() - this.born) / 700);
      m.uniforms.uReveal.value = k;
      for (const h of this.heads) h.visible = k >= 1;
      if (this.label) this.label.material.opacity = k;
      if (k >= 1) this.born = 0;
    }
  }

  private clear() {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | undefined;
      (mat as THREE.SpriteMaterial | undefined)?.map?.dispose();
      mat?.dispose?.();
    });
    this.root.clear();
    this.sample = null;
    this.sampleT = -1;
    this.tube = null;
    this.heads = [];
    this.label = null;
  }

  dispose() {
    this.clear();
    this.root.removeFromParent();
  }
}
