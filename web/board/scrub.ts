import * as THREE from "three";
import type { Board } from "../../shared/board";
import { sfx } from "../xr/sound";
import { Toast } from "./wheel";
import type { Pointer, XRInput, XRPlugin } from "./xr";

/**
 * Scrubbing history with a twist of the wrist: turn your hand (or the
 * controller) like a dial — left goes back, right goes forward — and the
 * board shows each step as it was, ghosted. Pinch or pull the trigger to go
 * there; grip (or the scrub action again) to leave it as it is.
 */

type State = Pick<Board, "name" | "items" | "links">;
const STEP_DEG = 16;

export class ScrubXR implements XRPlugin {
  readonly label = "history dial";
  private on: { p: Pointer; q0: THREE.Quaternion; back: State[]; forward: State[]; steps: number } | null = null;
  private tag = new Toast();

  constructor(
    private xr: XRInput,
    private o: { boardId: () => string; board: () => Board | null; preview: (b: Board | null, label?: string) => void },
  ) {
    xr.scene.overlay.add(this.tag.mesh);
  }

  handle(action: string, p?: Pointer): boolean {
    if (action !== "scrub") return false;
    if (this.on) this.end(false);
    else void this.start(p ?? this.xr.ptrs.find((q) => q.side === "right" && q.source) ?? this.xr.ptrs.find((q) => q.source));
    return true;
  }

  private async start(p?: Pointer) {
    if (!p) return;
    const r = await fetch(`/api/board/history?id=${encodeURIComponent(this.o.boardId())}`).catch(() => null);
    if (!r?.ok) return;
    const h = (await r.json()) as { back: State[]; forward: State[] };
    if (!h.back.length && !h.forward.length) return this.xr.say("No history yet", p);
    this.on = { p, q0: p.ray.getWorldQuaternion(new THREE.Quaternion()), back: h.back, forward: h.forward, steps: 0 };
    this.xr.haptic(p, 0.4, 30);
    sfx.play("pick");
  }

  private end(commit: boolean) {
    const s = this.on;
    this.on = null;
    this.tag.mesh.visible = false;
    this.o.preview(null);
    if (!s) return;
    if (commit && s.steps) {
      void fetch("/api/board/rewind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: this.o.boardId(), steps: s.steps }) });
      sfx.play("place");
      this.xr.say(s.steps > 0 ? `${s.steps} back` : `${-s.steps} forward`, s.p);
    } else sfx.play("back");
  }

  /** The trigger or pinch: go there. The grip: leave it. */
  press(p: Pointer, kind: "select" | "squeeze"): boolean {
    if (!this.on) return false;
    this.end(kind === "select" && p === this.on.p);
    return true;
  }

  left() {
    if (this.on) this.end(false);
  }

  frame() {
    const s = this.on;
    if (!s) return;
    const q = s.p.ray.getWorldQuaternion(new THREE.Quaternion());
    // The twist about where the hand points: a dial.
    const d = s.q0.clone().invert().multiply(q);
    let twist = THREE.MathUtils.radToDeg(2 * Math.atan2(d.z, d.w));
    if (twist > 180) twist -= 360;
    if (twist < -180) twist += 360;
    const steps = THREE.MathUtils.clamp(Math.round(twist / STEP_DEG), -s.forward.length, s.back.length);
    if (steps !== s.steps) {
      s.steps = steps;
      const b = this.o.board();
      const st = steps > 0 ? s.back[steps - 1] : steps < 0 ? s.forward[-steps - 1] : null;
      this.o.preview(st && b ? { ...b, ...st } : null, steps ? `${Math.abs(steps)} ${steps > 0 ? "back" : "forward"}` : undefined);
      this.xr.haptic(s.p, 0.25, 12);
      sfx.play("tick");
    }
    const head = new THREE.Vector3().setFromMatrixPosition(this.xr.scene.renderer.xr.getCamera().matrixWorld);
    const label = steps === 0 ? "Now · twist to scrub" : `${steps > 0 ? "◀" : "▶"} ${Math.abs(steps)} ${steps > 0 ? "back" : "forward"} · pinch to go`;
    this.tag.show(label, this.xr.tip(s.p).add(new THREE.Vector3(0, 0.08, 0)), head, 300);
    this.tag.tick();
    this.tag.render();
  }
}
