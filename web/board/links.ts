import * as THREE from "three";
import { colorOf, type Link } from "../../shared/board";
import type { ItemView } from "./items";
import { LOOK, labelSprite, linkMaterial } from "./look";
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

export class LinkView {
  readonly root = new THREE.Group();
  private tube: THREE.Mesh<THREE.TubeGeometry, THREE.ShaderMaterial> | null = null;
  private heads: THREE.Mesh[] = [];
  private label: THREE.Sprite | null = null;
  private ends = "";
  private key = "";
  private born = 0;
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
    const mat = linkMaterial(color, { dashed: st.dashed, opacity: st.opacity, speed: st.speed, len });
    const radius = st.radius * num("linkWidth");
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

    if (this.link.label && on("linkLabels") && on("labels")) {
      const s = labelSprite(this.link.label, color, { height: 0.03 * num("labelSize"), bracket: false });
      s.material.color.setScalar(num("labelBrightness"));
      s.position.copy(curve.getPoint(0.5)).add(new THREE.Vector3(0, 0.008, 0));
      this.label = s;
      this.root.add(s);
    }
  }

  tick(dt: number) {
    if (!this.tube) return;
    const m = this.tube.material;
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
    this.tube = null;
    this.heads = [];
    this.label = null;
  }

  dispose() {
    this.clear();
    this.root.removeFromParent();
  }
}
