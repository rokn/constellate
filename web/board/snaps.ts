import * as THREE from "three";
import { newId, type Board, type Snap, type Vec3 } from "../../shared/board";
import { sfx } from "../xr/sound";
import { cond, withAlpha } from "../xr/ui";
import { HoloPanel, chamfer, faceHead, headFrame } from "./hud";
import { LOOK } from "./look";
import type { BoardScene } from "./scene";
import { on } from "./tune";
import type { Pointer, XRInput, XRPlugin } from "./xr";

/**
 * Snapshot cards: a view kept — where you stood, what you looked at, what
 * was selected — with a picture of it, kept on the board for every screen.
 * Tap a card to stand there again: on the desktop the camera flies there,
 * in the headset the board moves so you are.
 */

/** The picture for a card: the scene from where the head is, small, as a JPEG. */
export function thumbFrom(scene: BoardScene, head: THREE.Vector3, look: THREE.Vector3): string | undefined {
  if (!on("snapshotThumbs")) return undefined;
  const r = scene.renderer;
  const w = 240;
  const h = 150;
  const rt = new THREE.WebGLRenderTarget(w, h, { samples: 2 });
  const cam = new THREE.PerspectiveCamera(60, w / h, 0.01, 60);
  cam.position.copy(head);
  cam.lookAt(look);
  cam.updateMatrixWorld();
  const prev = r.getRenderTarget();
  const xrOn = r.xr.enabled;
  const clear = r.getClearColor(new THREE.Color());
  const alpha = r.getClearAlpha();
  try {
    r.xr.enabled = false;
    r.setRenderTarget(rt);
    r.setClearColor(LOOK.bg, 1);
    r.clear();
    r.render(scene.scene, cam);
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, px);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    // Read upside down: flip it.
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/jpeg", 0.62);
  } catch {
    return undefined;
  } finally {
    r.xr.enabled = xrOn;
    r.setRenderTarget(prev);
    r.setClearColor(clear, alpha);
    rt.dispose();
  }
}

/** The headset: kept views as a panel of cards, and a snapshot from where you stand. */
export class SnapsXR implements XRPlugin {
  private panel: SnapsPanel;
  private want: Pointer | null | undefined = undefined;

  constructor(
    private xr: XRInput,
    private o: { board: () => Board | null; apply: (snap: Snap) => void; remove: (id: string) => void; select: (ids: string[]) => void },
  ) {
    this.panel = new SnapsPanel({ go: (s) => this.go(s), remove: (id) => o.remove(id), take: () => (this.want = null) });
    this.panel.onClose = () => (this.panel.mesh.visible = false);
    this.panel.mesh.material.opacity = 1;
    xr.scene.overlay.add(this.panel.mesh);
  }

  panels() {
    return [this.panel];
  }

  handle(action: string, p?: Pointer): boolean {
    if (action === "snapshot") {
      // Taken next frame, inside the headset's own frame.
      this.want = p ?? null;
      return true;
    }
    if (action === "snapshots") {
      const m = this.panel.mesh;
      m.visible = !m.visible;
      if (m.visible) {
        const cam = this.xr.scene.renderer.xr.getCamera();
        const { head, fwd, right } = headFrame(cam);
        m.position.copy(head).addScaledVector(fwd, 0.6).addScaledVector(right, 0.12).add(new THREE.Vector3(0, -0.2, 0));
        faceHead(m, head);
        this.panel.invalidate();
      }
      sfx.play(m.visible ? "pick" : "back");
      return true;
    }
    return false;
  }

  left() {
    this.panel.mesh.visible = false;
  }

  frame() {
    const s = this.xr.scene;
    if (this.want !== undefined) {
      const p = this.want;
      this.want = undefined;
      const cam = s.renderer.xr.getCamera();
      const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
      const look = head.clone().add(new THREE.Vector3(0, 0, -0.6).transformDirection(cam.matrixWorld));
      const n = (this.o.board()?.snaps?.length ?? 0) + 1;
      const snap: Snap = { id: newId("s"), label: `View ${n}`, at: Date.now(), head: v3(s.toBoard(head)), look: v3(s.toBoard(look)), scale: r3(s.rig.scale.x), selected: this.xr.ctl.selected(), thumb: thumbFrom(s, head, look) };
      this.o.apply(snap);
      sfx.play("snap" as never);
      this.xr.say(`Kept: ${snap.label}`, p ?? undefined);
    }
    if (this.panel.mesh.visible) {
      this.panel.snaps = this.o.board()?.snaps ?? [];
      this.panel.render();
    }
  }

  /** Stand where the card was taken: the board moves (and turns, and scales) so your head is there. */
  go(sn: Snap) {
    const s = this.xr.scene;
    const cam = s.renderer.xr.getCamera();
    const { head, fwd } = headFrame(cam);
    const scale = sn.scale ?? s.rig.scale.x;
    const hb = new THREE.Vector3(...sn.head);
    const lb = new THREE.Vector3(...sn.look);
    const dirB = lb.clone().sub(hb).setY(0);
    const yaw = Math.atan2(fwd.x, fwd.z) - Math.atan2(dirB.x, dirB.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const pos = head.clone().sub(hb.clone().multiplyScalar(scale).applyQuaternion(q));
    s.rig.position.copy(pos);
    s.rig.quaternion.copy(q);
    s.rig.scale.setScalar(scale);
    if (sn.selected?.length) this.o.select(sn.selected);
    sfx.play("focus");
    this.panel.mesh.visible = false;
  }
}

class SnapsPanel extends HoloPanel {
  snaps: Snap[] = [];
  private imgs = new Map<string, HTMLImageElement>();
  private key = "";

  constructor(private on: { go: (s: Snap) => void; remove: (id: string) => void; take: () => void }) {
    super("snaps", 0.46, 0.3, "Views");
  }

  render() {
    const key = this.snaps.map((s) => s.id + s.label).join();
    if (key !== this.key) {
      this.key = key;
      this.invalidate();
    }
    super.render();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    this.frameHolo(ctx, "Views", `${this.snaps.length} kept`);
    this.holoButton(ctx, "take", 30, this.header + 8, 260, 44, "Keep this view", () => this.on.take(), { icon: "camera", size: 20, color: LOOK.accent });
    const cols = 4;
    const gap = 14;
    const w = (this.W - 60 - gap * (cols - 1)) / cols;
    const h = w * 0.625;
    const top = this.header + 66;
    [...this.snaps].reverse().slice(0, 8).forEach((s, i) => {
      const x = 30 + (i % cols) * (w + gap);
      const y = top + Math.floor(i / cols) * (h + 40);
      chamfer(ctx, x, y, w, h, 10);
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "rgba(2,10,18,0.8)";
      ctx.fillRect(x, y, w, h);
      const img = s.thumb ? this.image(s) : null;
      if (img?.complete && img.naturalWidth) ctx.drawImage(img, x, y, w, h);
      ctx.restore();
      chamfer(ctx, x, y, w, h, 10);
      ctx.strokeStyle = withAlpha(LOOK.cyan, this.hover === `go:${s.id}` ? 1 : 0.45);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = cond(18, 600);
      ctx.fillStyle = "#dff6ff";
      ctx.fillText(s.label.toUpperCase().slice(0, 18), x + 4, y + h + 24);
      this.region({ id: `go:${s.id}`, x, y, w, h, onClick: () => this.on.go(s) });
      this.iconButton(ctx, `rm:${s.id}`, x + w - 34, y + h + 4, 30, "close", () => this.on.remove(s.id), false, LOOK.danger);
    });
    if (!this.snaps.length) this.caption(ctx, "Nothing kept yet: keep this view, or hold Y", 30, top + 40, 18);
  }

  private image(s: Snap) {
    let img = this.imgs.get(s.id);
    if (!img) {
      img = new Image();
      img.onload = () => this.invalidate();
      img.src = s.thumb!;
      this.imgs.set(s.id, img);
    }
    return img;
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const v3 = (v: THREE.Vector3): Vec3 => [r3(v.x), r3(v.y), r3(v.z)];
