import * as THREE from "three";
import { actionById } from "../../shared/boardActions";
import { cond, sans, withAlpha } from "../xr/ui";
import { HoloPanel, chamfer, icon } from "./hud";
import { LOOK } from "./look";
import { pick } from "./tune";

/**
 * The command wheel: eight actions in a ring of light, around a controller
 * (hold the stick in, tilt to a slice, let go) or blooming from an upturned
 * palm (touch a slice, or point and pinch). The slices are Tune knobs.
 *
 * Also here: the chip that says what a button just did, and the labels that
 * show on a controller when you look at it.
 */

const CYAN = LOOK.cyan;
const AMBER = LOOK.accent;
export const WHEEL_KEYS = ["wheel1", "wheel2", "wheel3", "wheel4", "wheel5", "wheel6", "wheel7", "wheel8"];

export class Wheel extends HoloPanel {
  /** The slice the stick (or a hand) is on: -1 for none. */
  slice = -1;
  private slots: string[] = [];
  private key = "";

  constructor(private onPick: (action: string) => void) {
    super("wheel", 0.24, 0.24, "");
    this.header = 0;
  }

  /** Where slice i sits on the canvas, from the top, clockwise. */
  private at(i: number) {
    const a = -Math.PI / 2 + (i / 8) * Math.PI * 2;
    const r = this.W * 0.355;
    return { x: this.W / 2 + Math.cos(a) * r, y: this.H / 2 + Math.sin(a) * r };
  }

  /** The slice a stick tilt points at, or -1 near the middle. */
  sliceOf(x: number, y: number) {
    if (Math.hypot(x, y) < 0.5) return -1;
    const a = Math.atan2(x, -y); // 0 up, clockwise
    return ((Math.round((a / (Math.PI * 2)) * 8) % 8) + 8) % 8;
  }

  setHot(i: number) {
    if (i === this.slice) return;
    this.slice = i;
    this.invalidate();
  }

  /** The action on the hot slice. */
  hotAction() {
    return this.slice >= 0 ? this.slots[this.slice] : null;
  }

  refresh() {
    const slots = WHEEL_KEYS.map((k) => pick(k));
    const key = slots.join();
    if (key !== this.key) {
      this.key = key;
      this.slots = slots;
      this.invalidate();
    }
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const { W, H } = this;
    const cx = W / 2;
    const cy = H / 2;
    // The ring: faint glass, ticks, the hot slice's arc lit.
    ctx.beginPath();
    ctx.arc(cx, cy, W * 0.47, 0, Math.PI * 2);
    ctx.arc(cx, cy, W * 0.2, 0, Math.PI * 2, true);
    ctx.fillStyle = "rgba(2, 14, 24, 0.5)";
    ctx.fill();
    ctx.strokeStyle = withAlpha(CYAN, 0.5);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, W * 0.47, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, W * 0.2, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const r0 = W * (i % 8 === 4 ? 0.44 : 0.455);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * W * 0.47, cy + Math.sin(a) * W * 0.47);
      ctx.strokeStyle = withAlpha(CYAN, 0.35);
      ctx.stroke();
    }
    if (this.slice >= 0) {
      const a = -Math.PI / 2 + (this.slice / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, W * 0.47, a - Math.PI / 8, a + Math.PI / 8);
      ctx.arc(cx, cy, W * 0.2, a + Math.PI / 8, a - Math.PI / 8, true);
      ctx.closePath();
      ctx.fillStyle = withAlpha(AMBER, 0.22);
      ctx.fill();
      ctx.shadowColor = AMBER;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    const s = W * 0.15;
    this.slots.forEach((id, i) => {
      const p = this.at(i);
      const act = actionById(id);
      const hot = this.slice === i || this.hover === `s${i}`;
      icon(ctx, act?.icon ?? "close", p.x, p.y, s * 0.62, hot ? "#ffffff" : id === "none" ? withAlpha(CYAN, 0.25) : CYAN);
      this.region({ id: `s${i}`, x: p.x - s / 2, y: p.y - s / 2, w: s, h: s, onClick: () => this.onPick(id) });
    });
    // The middle: what the hot slice does.
    const hotId = this.slice >= 0 ? this.slots[this.slice] : this.hover?.startsWith("s") ? this.slots[Number(this.hover.slice(1))] : null;
    const label = hotId ? actionById(hotId)?.label ?? hotId : "COMMAND";
    ctx.textAlign = "center";
    ctx.font = cond(label.length > 12 ? 24 : 30, 600);
    ctx.letterSpacing = "2px";
    ctx.fillStyle = hotId ? "#ffffff" : withAlpha(CYAN, 0.7);
    const words = label.toUpperCase().split(" ");
    const lines = words.length > 2 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : [words.join(" ")];
    lines.forEach((l, i) => ctx.fillText(l, cx, cy + 10 + (i - (lines.length - 1) / 2) * 30));
    ctx.letterSpacing = "0px";
    ctx.textAlign = "left";
  }
}

/** What a button just did: a chip of light by the hand that pressed it. */
export class Toast extends HoloPanel {
  private text = "";
  private until = 0;

  constructor() {
    super("toast", 0.16, 0.035, "");
    this.header = 0;
  }

  show(text: string, at: THREE.Vector3, head: THREE.Vector3, ms = 1300) {
    if (text !== this.text) {
      this.text = text;
      // As wide as what it says.
      const w = THREE.MathUtils.clamp(0.035 + text.length * 0.0088, 0.1, 0.4);
      if (Math.abs(w - this.widthM) > 0.012) this.resize(w, 0.035);
      this.invalidate();
    }
    this.until = performance.now() + ms;
    this.mesh.position.copy(at);
    this.mesh.lookAt(head);
    this.mesh.visible = true;
  }

  tick() {
    const left = this.until - performance.now();
    if (left <= 0) this.mesh.visible = false;
    else this.mesh.material.opacity = Math.min(1, left / 300);
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const { W, H } = this;
    ctx.font = cond(30, 600);
    ctx.letterSpacing = "4px";
    const t = this.text.toUpperCase();
    const tw = Math.min(W - 20, ctx.measureText(t).width + 50);
    chamfer(ctx, (W - tw) / 2, 6, tw, H - 12, 10);
    ctx.fillStyle = "rgba(2, 14, 24, 0.7)";
    ctx.fill();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = AMBER;
    ctx.shadowBlur = 10;
    ctx.fillText(t, W / 2, H / 2 + 10);
    ctx.shadowBlur = 0;
    ctx.textAlign = "left";
    ctx.letterSpacing = "0px";
  }
}

/** A controller's buttons and what they do, floating over it while you look at it. */
export class Hints extends HoloPanel {
  private key = "";
  private rows: [string, string][] = [];

  constructor(readonly side: "left" | "right") {
    super(`hints-${side}`, 0.19, 0.07, "");
    this.header = 0;
  }

  refresh() {
    const lbl = (k: string) => actionById(pick(k))?.label ?? pick(k);
    const rows: [string, string][] =
      this.side === "right"
        ? [
            ["A", `${lbl("btnA")} · hold ${lbl("btnAHold")}`],
            ["B", `${lbl("btnB")} · hold ${lbl("btnBHold")}`],
            ["◉", lbl("btnRStick")],
            ["⇅", pick("rightStick") === "off" ? "—" : pick("rightStick") === "snap-turn" ? "Turn table in steps" : "Turn · scale table"],
          ]
        : [
            ["X", `${lbl("btnX")} · hold ${lbl("btnXHold")}`],
            ["Y", `${lbl("btnY")} · hold ${lbl("btnYHold")}`],
            ["◉", lbl("btnLStick")],
            ["⇅", pick("leftStick") === "off" ? "—" : "Slide table"],
          ];
    const key = JSON.stringify(rows);
    if (key !== this.key) {
      this.key = key;
      this.rows = rows;
      this.invalidate();
    }
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const { W, H } = this;
    chamfer(ctx, 3, 3, W - 6, H - 6, 12);
    ctx.fillStyle = "rgba(2, 14, 24, 0.62)";
    ctx.fill();
    ctx.strokeStyle = withAlpha(CYAN, 0.5);
    ctx.lineWidth = 2;
    ctx.stroke();
    const rowH = (H - 20) / this.rows.length;
    this.rows.forEach(([k, v], i) => {
      const y = 10 + rowH * (i + 0.5) + 9;
      ctx.font = cond(26, 700);
      ctx.fillStyle = AMBER;
      ctx.fillText(k, 18, y);
      ctx.font = sans(20, 500);
      ctx.fillStyle = "#dff6ff";
      let t = v;
      while (ctx.measureText(t).width > W - 70 && t.length > 4) t = `${t.slice(0, -2)}…`;
      ctx.fillText(t, 58, y);
    });
  }
}
