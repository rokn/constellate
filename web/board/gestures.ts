import * as THREE from "three";
import { ACTION_IDS, actionById } from "../../shared/boardActions";
import { sfx } from "../xr/sound";
import { cond, sans, withAlpha } from "../xr/ui";
import { HoloPanel, faceHead, headFrame } from "./hud";
import { LOOK } from "./look";
import { num, on } from "./tune";
import type { Pointer, XRInput, XRPlugin } from "./xr";

/**
 * Your own gestures: hold a hand pose, record it, bind it to any action — a
 * thumbs-up to mark something done, a fist to undo, a peace sign for a
 * snapshot. A pose is read as how curled each finger is and which way the
 * palm and thumb point; held a moment within tolerance, its action runs.
 * Kept in this browser (they're your hands).
 */

export type Gesture = { id: string; name: string; side: "left" | "right"; f: number[]; action: string };
const KEY = "workshop.gestures";
const TIPS = ["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"] as const;
/** How much each feature counts: the fingers most, the palm's way less. */
const WEIGHTS = [1, 1, 1, 1, 1, 0.6, 0.6, 0.8];

/** A hand pose as numbers: five curls (0 straight … 1 folded), palm up, palm toward you, thumb up. */
export function poseFeatures(hand: THREE.XRHandSpace, head: THREE.Vector3, side: "left" | "right"): number[] | null {
  const j = (n: string) => {
    const x = hand.joints[n as XRHandJoint];
    return x?.visible ? x.getWorldPosition(new THREE.Vector3()) : null;
  };
  const wrist = j("wrist");
  const mid = j("middle-finger-metacarpal");
  const iBase = j("index-finger-metacarpal");
  const pBase = j("pinky-finger-metacarpal");
  const tBase = j("thumb-metacarpal");
  if (!wrist || !mid || !iBase || !pBase || !tBase) return null;
  const size = Math.max(0.03, wrist.distanceTo(mid));
  const palm = wrist.clone().add(mid).multiplyScalar(0.5);
  const out: number[] = [];
  for (const t of TIPS) {
    const tip = j(t);
    if (!tip) return null;
    // Straight: far from the palm (about 2.4 hand-sizes); folded: right by it.
    out.push(THREE.MathUtils.clamp(1 - (tip.distanceTo(palm) / size - 0.8) / 1.6, 0, 1));
  }
  const a = iBase.clone().sub(wrist);
  const b = pBase.clone().sub(wrist);
  const n = (side === "left" ? b.cross(a) : a.cross(b)).normalize();
  out.push((n.y + 1) / 2, (n.dot(head.clone().sub(palm).normalize()) + 1) / 2);
  const thumb = j("thumb-tip")!.sub(tBase).normalize();
  out.push((thumb.y + 1) / 2);
  return out;
}

function distance(a: number[], b: number[]) {
  let s = 0;
  let w = 0;
  for (let i = 0; i < a.length; i++) {
    s += WEIGHTS[i] * (a[i] - b[i]) ** 2;
    w += WEIGHTS[i];
  }
  return Math.sqrt(s / w);
}

export class GesturesXR implements XRPlugin {
  list: Gesture[] = load();
  private panel: GesturePanel;
  private held = new Map<string, { id: string; since: number; fired: boolean }>();
  private recording: { side: "left" | "right"; t0: number; samples: number[][] } | null = null;

  constructor(private xr: XRInput) {
    this.panel = new GesturePanel(this);
    this.panel.onClose = () => (this.panel.mesh.visible = false);
    this.panel.mesh.material.opacity = 1;
    xr.scene.overlay.add(this.panel.mesh);
  }

  panels() {
    return [this.panel];
  }

  handle(action: string): boolean {
    if (action !== "gestures") return false;
    const m = this.panel.mesh;
    m.visible = !m.visible;
    if (m.visible) {
      const cam = this.xr.scene.renderer.xr.getCamera();
      const { head, fwd, right } = headFrame(cam);
      m.position.copy(head).addScaledVector(fwd, 0.6).addScaledVector(right, -0.15).add(new THREE.Vector3(0, -0.18, 0));
      faceHead(m, head);
      this.panel.invalidate();
    }
    return true;
  }

  left() {
    this.panel.mesh.visible = false;
    this.recording = null;
  }

  /** Record: 2 s to get the pose ready, then half a second of it, averaged. */
  record(side: "left" | "right") {
    this.recording = { side, t0: performance.now(), samples: [] };
    this.panel.invalidate();
  }

  get countdown() {
    if (!this.recording) return null;
    const left = 2000 - (performance.now() - this.recording.t0);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.list));
    } catch {
      /* not kept */
    }
    this.panel.invalidate();
  }

  frame(_dt: number, now: number) {
    const head = new THREE.Vector3().setFromMatrixPosition(this.xr.scene.renderer.xr.getCamera().matrixWorld);
    const r = this.recording;
    if (r) {
      const elapsed = now - r.t0;
      const p = this.xr.ptrs.find((q) => q.side === r.side && this.xr.isHand(q));
      if (elapsed > 2000 && p) {
        const f = poseFeatures(p.hand, head, r.side);
        if (f) r.samples.push(f);
      }
      if (elapsed > 2600) {
        this.recording = null;
        if (r.samples.length >= 3) {
          const f = r.samples[0].map((_, i) => r.samples.reduce((s, x) => s + x[i], 0) / r.samples.length);
          const g: Gesture = { id: Math.random().toString(36).slice(2, 8), name: `Gesture ${this.list.length + 1}`, side: r.side, f, action: "mark-done" };
          this.list.push(g);
          this.save();
          sfx.play("snap");
          this.xr.say(`Recorded · ${g.name}`, p);
        } else this.xr.say("Couldn't see that hand");
      }
      this.panel.invalidate();
      this.panel.render();
      return;
    }
    if (this.panel.mesh.visible) this.panel.render();
    if (!on("customGestures") || !this.list.length) return;
    for (const p of this.xr.ptrs) {
      if (!p.source || !this.xr.isHand(p) || (p.side !== "left" && p.side !== "right")) continue;
      // Busy hands make no gestures.
      if (p.press || p.carry || p.grabbing || p.poke) {
        this.held.delete(p.side);
        continue;
      }
      const f = poseFeatures(p.hand, head, p.side);
      if (!f) continue;
      let best: { g: Gesture; d: number } | null = null;
      for (const g of this.list) {
        if (g.side !== p.side) continue;
        const d = distance(f, g.f);
        if (d < num("gestureTolerance") && (!best || d < best.d)) best = { g, d };
      }
      const h = this.held.get(p.side);
      if (!best) {
        this.held.delete(p.side);
        continue;
      }
      if (!h || h.id !== best.g.id) this.held.set(p.side, { id: best.g.id, since: now, fired: false });
      else if (!h.fired && now - h.since > num("gestureHoldMs")) {
        h.fired = true;
        this.fire(best.g, p);
      }
    }
  }

  private fire(g: Gesture, p: Pointer) {
    this.xr.act(g.action, p);
  }
}

class GesturePanel extends HoloPanel {
  constructor(private g: GesturesXR) {
    super("gestures", 0.46, 0.32, "Gestures");
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    this.frameHolo(ctx, "Gestures", on("customGestures") ? "on" : "off in Tune");
    const cd = this.g.countdown;
    if (cd !== null) {
      ctx.textAlign = "center";
      ctx.font = cond(cd > 0 ? 120 : 44, 700);
      ctx.fillStyle = LOOK.accent;
      ctx.fillText(cd > 0 ? String(cd) : "HOLD IT…", this.W / 2, this.H / 2 + 30);
      ctx.font = sans(22);
      ctx.fillStyle = "#dff6ff";
      ctx.fillText("Make the pose with that hand, and hold it", this.W / 2, this.H / 2 + 90);
      ctx.textAlign = "left";
      return;
    }
    this.holoButton(ctx, "rec-l", 30, this.header + 8, 250, 44, "Record left hand", () => this.g.record("left"), { icon: "hand", size: 19, color: LOOK.accent });
    this.holoButton(ctx, "rec-r", 296, this.header + 8, 250, 44, "Record right hand", () => this.g.record("right"), { icon: "hand", size: 19, color: LOOK.accent });
    let y = this.header + 70;
    for (const g of this.g.list.slice(0, 7)) {
      ctx.font = cond(22, 600);
      ctx.fillStyle = "#dff6ff";
      ctx.fillText(`${g.name.toUpperCase()} · ${g.side === "left" ? "L" : "R"}`, 30, y + 28);
      const i = ACTION_IDS.indexOf(g.action);
      const step = (d: number) => {
        g.action = ACTION_IDS[(i + d + ACTION_IDS.length) % ACTION_IDS.length];
        this.g.save();
      };
      const x0 = 290;
      this.holoButton(ctx, `p:${g.id}`, x0, y, 40, 40, "‹", () => step(-1), { size: 22 });
      this.holoButton(ctx, `a:${g.id}`, x0 + 46, y, 300, 40, actionById(g.action)?.label ?? g.action, () => step(1), { size: 17, color: LOOK.accent });
      this.holoButton(ctx, `n:${g.id}`, x0 + 352, y, 40, 40, "›", () => step(1), { size: 22 });
      this.iconButton(ctx, `x:${g.id}`, this.W - 74, y, 40, "close", () => {
        this.g.list = this.g.list.filter((x) => x !== g);
        this.g.save();
      }, false, LOOK.danger);
      y += 52;
    }
    if (!this.g.list.length) {
      ctx.font = sans(21);
      ctx.fillStyle = withAlpha("#dff6ff", 0.7);
      ctx.fillText("Record a pose — a thumbs-up, a fist, a peace sign — then pick what it does.", 30, y + 30);
    }
  }
}

function load(): Gesture[] {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Gesture[];
    return Array.isArray(l) ? l.filter((g) => Array.isArray(g.f) && g.f.length === WEIGHTS.length) : [];
  } catch {
    return [];
  }
}
