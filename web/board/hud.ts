import * as THREE from "three";
import { ARCH_KINDS, COLORS, STATUSES, colorOf, nameOf, type Board, type Item, type ItemKind } from "../../shared/board";
import { BOARD_SECTIONS, BUILT_IN_PRESETS, type BoardKnob, type BoardPreset } from "../../shared/boardTune";
import { actionById } from "../../shared/boardActions";
import { Panel, cond, sans, withAlpha } from "../xr/ui";
import type { Ctl, Tool } from "./ctl";
import { LOOK, STATUS_COLOR } from "./look";
import { num, on, pick, resetTune, setTune } from "./tune";

/**
 * The headset's panels, drawn the way Stark's are: thin light on dark glass,
 * chamfered corners, tick marks and condensed caps — and never a slab in
 * your way. Panels float low, drift after you when you turn, and fade back
 * when you're not pointing at them; grab one by its title bar to pin it.
 *
 *  - Dock: on your left wrist (a hand turned toward you, or the controller).
 *  - Palette: every component, and the hologram library and templates.
 *  - Tune: every knob, and the presets.
 *  - Callout: the selected item's inspector, beside the item itself.
 *  - Captions: what the voice says and the builder's doing, as subtitles.
 */

const CYAN = LOOK.cyan;
const AMBER = LOOK.accent;
const GLASS_TOP = "rgba(4, 22, 36, 0.62)";
const GLASS_BOTTOM = "rgba(2, 10, 18, 0.5)";

export function chamfer(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number) {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function glow(ctx: CanvasRenderingContext2D, color: string, blur: number) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
}

function noGlow(ctx: CanvasRenderingContext2D) {
  ctx.shadowBlur = 0;
}

/** Vector icons: the headset's browser may not have the glyphs. */
export function icon(ctx: CanvasRenderingContext2D, name: string, cx: number, cy: number, s: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, s * 0.09);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const h = s / 2;
  ctx.beginPath();
  switch (name) {
    case "select":
      ctx.moveTo(cx - h * 0.6, cy - h * 0.8);
      ctx.lineTo(cx + h * 0.6, cy + h * 0.1);
      ctx.lineTo(cx + h * 0.05, cy + h * 0.2);
      ctx.lineTo(cx - h * 0.25, cy + h * 0.85);
      ctx.closePath();
      ctx.stroke();
      break;
    case "connect":
      ctx.arc(cx - h * 0.65, cy + h * 0.45, h * 0.2, 0, Math.PI * 2);
      ctx.moveTo(cx + h * 0.85, cy - h * 0.45);
      ctx.arc(cx + h * 0.65, cy - h * 0.45, h * 0.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.5, cy + h * 0.35);
      ctx.quadraticCurveTo(cx, cy - h * 0.9, cx + h * 0.5, cy - h * 0.35);
      ctx.stroke();
      break;
    case "ink":
      ctx.moveTo(cx - h * 0.8, cy + h * 0.3);
      ctx.bezierCurveTo(cx - h * 0.4, cy - h * 0.8, cx, cy + h * 0.8, cx + h * 0.4, cy - h * 0.2);
      ctx.lineTo(cx + h * 0.8, cy - h * 0.6);
      ctx.stroke();
      break;
    case "voice":
      ctx.roundRect(cx - h * 0.25, cy - h * 0.8, h * 0.5, h * 1.05, h * 0.25);
      ctx.moveTo(cx - h * 0.55, cy - h * 0.05);
      ctx.quadraticCurveTo(cx - h * 0.55, cy + h * 0.55, cx, cy + h * 0.55);
      ctx.quadraticCurveTo(cx + h * 0.55, cy + h * 0.55, cx + h * 0.55, cy - h * 0.05);
      ctx.moveTo(cx, cy + h * 0.55);
      ctx.lineTo(cx, cy + h * 0.85);
      ctx.stroke();
      break;
    case "build":
      ctx.moveTo(cx, cy - h * 0.85);
      ctx.lineTo(cx + h * 0.75, cy - h * 0.42);
      ctx.lineTo(cx + h * 0.75, cy + h * 0.42);
      ctx.lineTo(cx, cy + h * 0.85);
      ctx.lineTo(cx - h * 0.75, cy + h * 0.42);
      ctx.lineTo(cx - h * 0.75, cy - h * 0.42);
      ctx.closePath();
      ctx.moveTo(cx - h * 0.75, cy - h * 0.42);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + h * 0.75, cy - h * 0.42);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy + h * 0.85);
      ctx.stroke();
      break;
    case "tune":
      for (const [y, k] of [
        [-0.5, 0.3],
        [0, -0.35],
        [0.5, 0.1],
      ]) {
        ctx.moveTo(cx - h * 0.8, cy + y * h);
        ctx.lineTo(cx + h * 0.8, cy + y * h);
      }
      ctx.stroke();
      for (const [y, k] of [
        [-0.5, 0.3],
        [0, -0.35],
        [0.5, 0.1],
      ]) {
        ctx.beginPath();
        ctx.arc(cx + k * h, cy + y * h, h * 0.16, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case "undo":
      ctx.arc(cx, cy + h * 0.1, h * 0.6, Math.PI * 1.1, Math.PI * 0.2, false);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.85, cy - h * 0.35);
      ctx.lineTo(cx - h * 0.6, cy + h * 0.15);
      ctx.lineTo(cx - h * 0.15, cy - h * 0.15);
      ctx.stroke();
      break;
    case "redo":
      ctx.arc(cx, cy + h * 0.1, h * 0.6, Math.PI * 1.9, Math.PI * 0.8, true);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + h * 0.85, cy - h * 0.35);
      ctx.lineTo(cx + h * 0.6, cy + h * 0.15);
      ctx.lineTo(cx + h * 0.15, cy - h * 0.15);
      ctx.stroke();
      break;
    case "close":
      ctx.moveTo(cx - h * 0.5, cy - h * 0.5);
      ctx.lineTo(cx + h * 0.5, cy + h * 0.5);
      ctx.moveTo(cx + h * 0.5, cy - h * 0.5);
      ctx.lineTo(cx - h * 0.5, cy + h * 0.5);
      ctx.stroke();
      break;
    case "pin":
      ctx.arc(cx, cy - h * 0.25, h * 0.35, 0, Math.PI * 2);
      ctx.moveTo(cx, cy + h * 0.1);
      ctx.lineTo(cx, cy + h * 0.85);
      ctx.stroke();
      break;
    case "table":
      ctx.ellipse(cx, cy + h * 0.15, h * 0.85, h * 0.35, 0, 0, Math.PI * 2);
      ctx.moveTo(cx, cy - h * 0.2);
      ctx.lineTo(cx, cy - h * 0.85);
      ctx.stroke();
      break;
    case "play":
      ctx.moveTo(cx - h * 0.4, cy - h * 0.6);
      ctx.lineTo(cx + h * 0.6, cy);
      ctx.lineTo(cx - h * 0.4, cy + h * 0.6);
      ctx.closePath();
      ctx.fill();
      break;
    case "wheel":
      ctx.arc(cx, cy, h * 0.8, 0, Math.PI * 2);
      ctx.moveTo(cx + h * 0.3, cy);
      ctx.arc(cx, cy, h * 0.3, 0, Math.PI * 2);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.moveTo(cx + Math.cos(a) * h * 0.3, cy + Math.sin(a) * h * 0.3);
        ctx.lineTo(cx + Math.cos(a) * h * 0.8, cy + Math.sin(a) * h * 0.8);
      }
      ctx.stroke();
      break;
    case "shelf":
      for (const yy of [-0.35, 0.45]) {
        ctx.moveTo(cx - h * 0.85, cy + yy * h);
        ctx.lineTo(cx + h * 0.85, cy + yy * h);
      }
      ctx.rect(cx - h * 0.6, cy - h * 0.8, h * 0.35, h * 0.45);
      ctx.rect(cx + h * 0.1, cy - h * 0.8, h * 0.45, h * 0.45);
      ctx.rect(cx - h * 0.3, cy, h * 0.5, h * 0.45);
      ctx.stroke();
      break;
    case "camera":
      ctx.roundRect(cx - h * 0.8, cy - h * 0.45, h * 1.6, h * 1.1, h * 0.15);
      ctx.moveTo(cx + h * 0.35, cy + h * 0.1);
      ctx.arc(cx, cy + h * 0.1, h * 0.35, 0, Math.PI * 2);
      ctx.moveTo(cx - h * 0.35, cy - h * 0.45);
      ctx.lineTo(cx - h * 0.2, cy - h * 0.7);
      ctx.lineTo(cx + h * 0.2, cy - h * 0.7);
      ctx.lineTo(cx + h * 0.35, cy - h * 0.45);
      ctx.stroke();
      break;
    case "hand":
      for (const [x, top] of [
        [-0.45, -0.45],
        [-0.15, -0.8],
        [0.15, -0.85],
        [0.45, -0.6],
      ]) {
        ctx.moveTo(cx + x * h, cy + h * 0.1);
        ctx.lineTo(cx + x * h, cy + top * h);
      }
      ctx.moveTo(cx - h * 0.45, cy + h * 0.1);
      ctx.quadraticCurveTo(cx - h * 0.5, cy + h * 0.85, cx, cy + h * 0.85);
      ctx.quadraticCurveTo(cx + h * 0.6, cy + h * 0.85, cx + h * 0.85, cy - h * 0.1);
      ctx.stroke();
      break;
    case "mic":
      ctx.roundRect(cx - h * 0.25, cy - h * 0.8, h * 0.5, h * 1.05, h * 0.25);
      ctx.moveTo(cx - h * 0.6, cy + h * 0.6);
      ctx.lineTo(cx + h * 0.6, cy + h * 0.6);
      ctx.stroke();
      break;
    case "clock":
      ctx.arc(cx, cy, h * 0.8, 0, Math.PI * 2);
      ctx.moveTo(cx, cy - h * 0.5);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + h * 0.4, cy + h * 0.25);
      ctx.stroke();
      break;
    case "lasso":
      ctx.ellipse(cx, cy - h * 0.2, h * 0.8, h * 0.5, 0, 0, Math.PI * 2);
      ctx.moveTo(cx - h * 0.3, cy + h * 0.25);
      ctx.quadraticCurveTo(cx - h * 0.5, cy + h * 0.9, cx + h * 0.1, cy + h * 0.85);
      ctx.stroke();
      break;
    case "erase":
      ctx.moveTo(cx - h * 0.8, cy + h * 0.2);
      ctx.lineTo(cx - h * 0.1, cy - h * 0.6);
      ctx.lineTo(cx + h * 0.6, cy + h * 0.1);
      ctx.lineTo(cx, cy + h * 0.8);
      ctx.lineTo(cx - h * 0.4, cy + h * 0.6);
      ctx.closePath();
      ctx.moveTo(cx - h * 0.45, cy - h * 0.2);
      ctx.lineTo(cx + h * 0.25, cy + h * 0.5);
      ctx.stroke();
      break;
    case "scale":
      ctx.moveTo(cx - h * 0.8, cy + h * 0.8);
      ctx.lineTo(cx + h * 0.8, cy - h * 0.8);
      ctx.moveTo(cx + h * 0.2, cy - h * 0.8);
      ctx.lineTo(cx + h * 0.8, cy - h * 0.8);
      ctx.lineTo(cx + h * 0.8, cy - h * 0.2);
      ctx.moveTo(cx - h * 0.2, cy + h * 0.8);
      ctx.lineTo(cx - h * 0.8, cy + h * 0.8);
      ctx.lineTo(cx - h * 0.8, cy + h * 0.2);
      ctx.stroke();
      break;
    case "trash":
      ctx.moveTo(cx - h * 0.75, cy - h * 0.55);
      ctx.lineTo(cx + h * 0.75, cy - h * 0.55);
      ctx.moveTo(cx - h * 0.25, cy - h * 0.55);
      ctx.lineTo(cx - h * 0.2, cy - h * 0.8);
      ctx.lineTo(cx + h * 0.2, cy - h * 0.8);
      ctx.lineTo(cx + h * 0.25, cy - h * 0.55);
      ctx.moveTo(cx - h * 0.55, cy - h * 0.55);
      ctx.lineTo(cx - h * 0.45, cy + h * 0.85);
      ctx.lineTo(cx + h * 0.45, cy + h * 0.85);
      ctx.lineTo(cx + h * 0.55, cy - h * 0.55);
      ctx.stroke();
      break;
    case "copy":
      ctx.rect(cx - h * 0.75, cy - h * 0.75, h * 1, h * 1);
      ctx.rect(cx - h * 0.25, cy - h * 0.25, h * 1, h * 1);
      ctx.stroke();
      break;
    case "explode":
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.moveTo(cx + Math.cos(a) * h * 0.3, cy + Math.sin(a) * h * 0.3);
        ctx.lineTo(cx + Math.cos(a) * h * 0.85, cy + Math.sin(a) * h * 0.85);
      }
      ctx.stroke();
      break;
    case "spin":
      ctx.arc(cx, cy, h * 0.7, Math.PI * 0.2, Math.PI * 1.7);
      ctx.moveTo(cx + h * 0.55, cy - h * 0.75);
      ctx.lineTo(cx + h * 0.6, cy - h * 0.35);
      ctx.lineTo(cx + h * 0.2, cy - h * 0.35);
      ctx.stroke();
      break;
    case "check":
      ctx.moveTo(cx - h * 0.7, cy);
      ctx.lineTo(cx - h * 0.2, cy + h * 0.5);
      ctx.lineTo(cx + h * 0.75, cy - h * 0.55);
      ctx.stroke();
      break;
    case "inside":
    case "up":
      ctx.rect(cx - h * 0.8, cy - h * 0.8, h * 1.6, h * 1.6);
      ctx.moveTo(cx - h * 0.4, cy + (name === "up" ? -0.4 : 0.4) * h);
      ctx.lineTo(cx + h * 0.4, cy + (name === "up" ? 0.4 : -0.4) * h);
      ctx.moveTo(cx + (name === "up" ? -0.4 : 0.4) * h, cy + (name === "up" ? -0.4 : 0.4) * h);
      ctx.lineTo(cx - h * 0.4, cy + (name === "up" ? -0.4 : 0.4) * h);
      ctx.lineTo(cx - h * 0.4, cy + (name === "up" ? 0.1 : 0.4) * h);
      ctx.stroke();
      break;
    case "desk":
      ctx.moveTo(cx - h * 0.9, cy);
      ctx.lineTo(cx + h * 0.9, cy);
      ctx.moveTo(cx - h * 0.7, cy);
      ctx.lineTo(cx - h * 0.7, cy + h * 0.8);
      ctx.moveTo(cx + h * 0.7, cy);
      ctx.lineTo(cx + h * 0.7, cy + h * 0.8);
      ctx.moveTo(cx - h * 0.3, cy - h * 0.1);
      ctx.lineTo(cx - h * 0.3, cy - h * 0.6);
      ctx.lineTo(cx + h * 0.3, cy - h * 0.6);
      ctx.lineTo(cx + h * 0.3, cy - h * 0.1);
      ctx.stroke();
      break;
    case "wall":
      ctx.rect(cx - h * 0.8, cy - h * 0.8, h * 1.6, h * 1.6);
      ctx.moveTo(cx - h * 0.4, cy + h * 0.3);
      ctx.lineTo(cx, cy - h * 0.3);
      ctx.lineTo(cx + h * 0.4, cy + h * 0.3);
      ctx.stroke();
      break;
    case "room":
      ctx.moveTo(cx - h * 0.8, cy + h * 0.4);
      ctx.lineTo(cx, cy + h * 0.8);
      ctx.lineTo(cx + h * 0.8, cy + h * 0.4);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - h * 0.8);
      ctx.stroke();
      break;
    case "tiers":
      for (const yy of [-0.6, 0, 0.6]) {
        ctx.moveTo(cx - h * 0.8, cy + yy * h + h * 0.15);
        ctx.lineTo(cx - h * 0.3, cy + yy * h - h * 0.15);
        ctx.lineTo(cx + h * 0.8, cy + yy * h - h * 0.15);
        ctx.lineTo(cx + h * 0.3, cy + yy * h + h * 0.15);
        ctx.closePath();
      }
      ctx.stroke();
      break;
    case "next":
    case "prev": {
      const d = name === "next" ? 1 : -1;
      ctx.moveTo(cx - d * h * 0.5, cy - h * 0.7);
      ctx.lineTo(cx + d * h * 0.3, cy);
      ctx.lineTo(cx - d * h * 0.5, cy + h * 0.7);
      ctx.moveTo(cx + d * h * 0.6, cy - h * 0.7);
      ctx.lineTo(cx + d * h * 0.6, cy + h * 0.7);
      ctx.stroke();
      break;
    }
    case "label":
      ctx.moveTo(cx - h * 0.8, cy - h * 0.6);
      ctx.lineTo(cx + h * 0.8, cy - h * 0.6);
      ctx.moveTo(cx, cy - h * 0.6);
      ctx.lineTo(cx, cy + h * 0.8);
      ctx.stroke();
      break;
    case "eye":
      ctx.moveTo(cx - h * 0.9, cy);
      ctx.quadraticCurveTo(cx, cy - h * 0.9, cx + h * 0.9, cy);
      ctx.quadraticCurveTo(cx, cy + h * 0.9, cx - h * 0.9, cy);
      ctx.moveTo(cx + h * 0.28, cy);
      ctx.arc(cx, cy, h * 0.28, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "code":
      ctx.moveTo(cx - h * 0.3, cy - h * 0.6);
      ctx.lineTo(cx - h * 0.85, cy);
      ctx.lineTo(cx - h * 0.3, cy + h * 0.6);
      ctx.moveTo(cx + h * 0.3, cy - h * 0.6);
      ctx.lineTo(cx + h * 0.85, cy);
      ctx.lineTo(cx + h * 0.3, cy + h * 0.6);
      ctx.stroke();
      break;
    default:
      ctx.arc(cx, cy, h * 0.5, 0, Math.PI * 2);
      ctx.stroke();
  }
  ctx.restore();
}

/** A panel drawn as a hologram, with a title bar to grab it by. */
export abstract class HoloPanel extends Panel {
  /** Height (px) of the title bar: a pinch or grip there carries the panel. */
  header = 64;
  /** Pinned where you put it: it doesn't follow you. */
  pinned = false;
  /** Pointed at right now: drawn at full strength. */
  hot = false;

  constructor(name: string, w: number, h: number, private titleText: string) {
    super(name, w, h, 1750);
  }

  /** Close it (the panel's own ✕). Set by whoever shows it. */
  onClose?: () => void;

  protected frameHolo(ctx: CanvasRenderingContext2D, title = this.titleText, sub?: string) {
    const { W, H } = this;
    const c = 26;
    chamfer(ctx, 4, 4, W - 8, H - 8, c);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, GLASS_TOP);
    g.addColorStop(1, GLASS_BOTTOM);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = withAlpha(CYAN, 0.45);
    ctx.stroke();
    // Faint scan lines across the glass.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = withAlpha(CYAN, 0.035);
    for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 1);
    ctx.restore();
    // Bright corners.
    glow(ctx, CYAN, 10);
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(4, 4 + c + 30);
    ctx.lineTo(4, 4 + c);
    ctx.lineTo(4 + c, 4);
    ctx.lineTo(4 + c + 60, 4);
    ctx.moveTo(W - 4, H - 4 - c - 30);
    ctx.lineTo(W - 4, H - 4 - c);
    ctx.lineTo(W - 4 - c, H - 4);
    ctx.lineTo(W - 4 - c - 60, H - 4);
    ctx.stroke();
    noGlow(ctx);
    // Title bar: name, a row of ticks, pin and close.
    ctx.font = cond(28, 600);
    ctx.letterSpacing = "6px";
    glow(ctx, CYAN, 8);
    ctx.fillStyle = CYAN;
    ctx.fillText(title.toUpperCase(), 34, 44);
    noGlow(ctx);
    const tw = ctx.measureText(title.toUpperCase()).width;
    ctx.letterSpacing = "0px";
    if (sub) {
      ctx.font = cond(20, 500);
      ctx.fillStyle = withAlpha(CYAN, 0.55);
      ctx.fillText(sub.toUpperCase(), 34 + tw + 18, 44);
    }
    ctx.fillStyle = withAlpha(CYAN, 0.35);
    for (let x = 34; x < W - 130; x += 9) ctx.fillRect(x, this.header - 6, 1, x % 45 === 34 % 45 ? 6 : 3);
    this.iconButton(ctx, "pin", W - 110, 14, 40, "pin", () => (this.pinned = !this.pinned), this.pinned);
    if (this.onClose) this.iconButton(ctx, "close", W - 62, 14, 40, "close", () => this.onClose?.());
  }

  protected iconButton(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, s: number, name: string, onClick: () => void, active = false, color?: string) {
    const hot = this.hover === id;
    const down = this.pressed === id;
    const col = color ?? (active ? AMBER : CYAN);
    chamfer(ctx, x, y, s, s, s * 0.22);
    ctx.fillStyle = down ? withAlpha(col, 0.35) : active ? withAlpha(col, 0.18) : hot ? withAlpha(col, 0.14) : "rgba(0,0,0,0)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = withAlpha(col, hot || active ? 0.95 : 0.4);
    ctx.stroke();
    if (hot || active) glow(ctx, col, 10);
    icon(ctx, name, x + s / 2, y + s / 2, s * 0.62, hot || active ? "#ffffff" : col);
    noGlow(ctx);
    this.region({ id, x, y, w: s, h: s, onClick });
  }

  /** A chamfered button with a label (and an icon), lit when pointed at, amber when on. */
  protected holoButton(
    ctx: CanvasRenderingContext2D,
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    onClick: () => void,
    o: { active?: boolean; color?: string; icon?: string; size?: number; dot?: string } = {},
  ) {
    const hot = this.hover === id;
    const down = this.pressed === id;
    const col = o.active ? AMBER : o.color ?? CYAN;
    chamfer(ctx, x, y, w, h, Math.min(14, h * 0.3));
    ctx.fillStyle = down ? withAlpha(col, 0.38) : o.active ? withAlpha(col, 0.16) : hot ? withAlpha(col, 0.13) : "rgba(95, 212, 255, 0.04)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = withAlpha(col, hot || o.active ? 0.95 : 0.35);
    ctx.stroke();
    let tx = x + w / 2;
    ctx.textAlign = "center";
    if (o.icon) {
      icon(ctx, o.icon, x + h * 0.55, y + h / 2, h * 0.5, hot || o.active ? "#fff" : col);
      tx = x + h + (w - h) / 2 - 6;
    }
    if (o.dot) {
      ctx.save();
      ctx.translate(x + 18, y + h / 2);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = o.dot;
      glow(ctx, o.dot, 8);
      ctx.fillRect(-5, -5, 10, 10);
      ctx.restore();
      noGlow(ctx);
      tx = x + 18 + (w - 18) / 2;
    }
    const size = o.size ?? 24;
    ctx.font = cond(size, 600);
    ctx.letterSpacing = "2px";
    if (hot || o.active) glow(ctx, col, 8);
    ctx.fillStyle = hot || o.active ? "#ffffff" : "#cfeaf6";
    ctx.fillText(label.toUpperCase(), tx, y + h / 2 + size * 0.36);
    noGlow(ctx);
    ctx.letterSpacing = "0px";
    ctx.textAlign = "left";
    this.region({ id, x, y, w, h, onClick });
  }

  /** A slider: a thin track of light with a diamond to drag. */
  protected holoSlider(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, w: number, o: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; onCommit?: () => void }) {
    const u = (o.value - o.min) / (o.max - o.min || 1);
    const ty = y + 22;
    ctx.fillStyle = withAlpha(CYAN, 0.18);
    ctx.fillRect(x, ty - 2, w, 4);
    glow(ctx, CYAN, 8);
    ctx.fillStyle = CYAN;
    ctx.fillRect(x, ty - 2, w * u, 4);
    ctx.save();
    ctx.translate(x + w * u, ty);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = this.hover === id ? "#ffffff" : CYAN;
    ctx.fillRect(-9, -9, 18, 18);
    ctx.restore();
    noGlow(ctx);
    const snap = (px: number) => {
      const k = Math.max(0, Math.min(1, (px - x) / w));
      const v = Math.round((o.min + k * (o.max - o.min)) / o.step) * o.step;
      o.onChange(Math.max(o.min, Math.min(o.max, +v.toFixed(5))));
    };
    this.region({ id, x: x - 14, y, w: w + 28, h: 44, onClick: () => {}, onDrag: (px) => snap(px), onRelease: o.onCommit });
  }

  protected holoToggle(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, value: boolean, onClick: () => void) {
    const w = 64;
    const h = 30;
    chamfer(ctx, x, y, w, h, 8);
    ctx.fillStyle = value ? withAlpha(AMBER, 0.3) : "rgba(95,212,255,0.05)";
    ctx.fill();
    ctx.strokeStyle = withAlpha(value ? AMBER : CYAN, this.hover === id ? 1 : 0.5);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = value ? AMBER : withAlpha(CYAN, 0.7);
    if (value) glow(ctx, AMBER, 8);
    ctx.fillRect(value ? x + w - 26 : x + 8, y + 7, 18, h - 14);
    noGlow(ctx);
    this.region({ id, x: x - 6, y: y - 6, w: w + 12, h: h + 12, onClick });
  }

  protected caption(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 18, color = LOOK.muted) {
    ctx.font = cond(size, 600);
    ctx.letterSpacing = "4px";
    ctx.fillStyle = color;
    ctx.fillText(text.toUpperCase(), x, y);
    ctx.letterSpacing = "0px";
  }
}

const TOOL_ICON: Record<Tool, string> = { select: "select", connect: "connect", ink: "ink", lasso: "lasso", erase: "erase" };
const KIND_NAME: Partial<Record<ItemKind, string>> = { function: "Lambda", holo: "Hologram" };
const kindName = (k: ItemKind) => KIND_NAME[k] ?? k[0].toUpperCase() + k.slice(1);

/* --------------------------------- dock --------------------------------- */

/** The wrist: the tools, the voice, and the way to every other panel. */
export class Dock extends HoloPanel {
  constructor(
    private ctl: Ctl,
    private on: { palette: () => void; tune: () => void; recenter: () => void; exit: () => void; isOpen: (name: string) => boolean; run: (action: string) => void },
  ) {
    super("dock", 0.3, 0.095, "");
    this.header = 0;
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const { W, H } = this;
    chamfer(ctx, 3, 3, W - 6, H - 6, 18);
    ctx.fillStyle = "rgba(2, 14, 24, 0.55)";
    ctx.fill();
    glow(ctx, CYAN, 8);
    ctx.strokeStyle = withAlpha(CYAN, 0.7);
    ctx.lineWidth = 2;
    ctx.stroke();
    noGlow(ctx);
    const v = this.ctl.voiceState();
    const voiceOn = v === "listening" || v === "speaking";
    type B = [string, string, () => void, boolean, string?];
    const rows: B[][] = [
      [
        ...(["select", "connect", "ink", "lasso", "erase"] as Tool[]).map((t) => [`t:${t}`, TOOL_ICON[t], () => this.ctl.setTool(t), this.ctl.tool() === t, t === "erase" ? LOOK.danger : undefined] as B),
        ["voice", "voice", () => this.ctl.toggleVoice(), voiceOn, v === "speaking" ? AMBER : voiceOn ? "#7dff9a" : undefined],
        ["undo", "undo", () => this.ctl.client.undo(), false],
        ["redo", "redo", () => this.ctl.client.redo(), false],
      ],
      [
        ["palette", "build", this.on.palette, this.on.isOpen("palette")],
        ["wheel", "wheel", () => this.on.run("wheel"), false],
        ["shelf", "shelf", () => this.on.run("shelf"), false],
        ["snapshots", "camera", () => this.on.run("snapshots"), false],
        ["tune", "tune", this.on.tune, this.on.isOpen("tune")],
        ["table", "table", this.on.recenter, false],
        ...(this.ctl.client.board?.parent && this.ctl.up ? ([["up", "up", () => this.ctl.up!(), false, AMBER]] as B[]) : []),
      ],
    ];
    const s = 46;
    rows.forEach((row, r) => {
      const gap = Math.min(22, (W - 24 - row.length * s) / Math.max(1, row.length - 1));
      const x0 = (W - (row.length * s + (row.length - 1) * gap)) / 2;
      row.forEach(([id, ic, f, act, col], i) => this.iconButton(ctx, id, x0 + i * (s + gap), 14 + r * (s + 12), s, ic, f, act, col));
    });
    ctx.font = cond(15, 600);
    ctx.letterSpacing = "3px";
    ctx.fillStyle = withAlpha(CYAN, 0.6);
    ctx.textAlign = "center";
    ctx.fillText(`${this.ctl.tool().toUpperCase()} · VOICE ${voiceOn ? "ON" : "OFF"} · ${(this.ctl.client.board?.name ?? "").toUpperCase().slice(0, 24)}`, W / 2, H - 14);
    ctx.textAlign = "left";
    ctx.letterSpacing = "0px";
  }
}

/* -------------------------------- palette ------------------------------- */

export type PaletteExtras = {
  /** The hologram library: name → make it. */
  library: { name: string; make: () => void }[];
  /** Templates: name → lay it out. */
  templates: { name: string; make: () => void }[];
};

export class Palette extends HoloPanel {
  tab: "blocks" | "board" | "library" | "templates" = "blocks";

  constructor(
    private ctl: Ctl,
    private spawn: (k: ItemKind) => void,
    private extras: () => PaletteExtras,
  ) {
    super("palette", 0.44, 0.3, "Fabricate");
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    this.frameHolo(ctx);
    const tabs: [typeof this.tab, string][] = [
      ["blocks", "Architecture"],
      ["board", "Board"],
      ["library", "Holograms"],
      ["templates", "Templates"],
    ];
    let x = 30;
    for (const [id, label] of tabs) {
      const w = 170;
      this.holoButton(ctx, `tab:${id}`, x, this.header + 8, w, 40, label, () => ((this.tab = id), this.invalidate()), { active: this.tab === id, size: 20 });
      x += w + 10;
    }
    const top = this.header + 66;
    const cols = 4;
    const w = (this.W - 60 - (cols - 1) * 10) / cols;
    const h = 52;
    const grid = (list: { id: string; label: string; f: () => void; dot?: string }[]) =>
      list.forEach((b, i) => this.holoButton(ctx, b.id, 30 + (i % cols) * (w + 10), top + Math.floor(i / cols) * (h + 10), w, h, b.label, b.f, { size: 21, dot: b.dot }));
    const dotOf = (k: ItemKind) => colorOf(({ database: "teal", queue: "amber", cache: "orange", client: "ice", user: "white", api: "blue", function: "violet", storage: "teal", external: "magenta", cloud: "ice" } as Record<string, string>)[k] ?? "cyan");
    if (this.tab === "blocks") grid(ARCH_KINDS.map((k) => ({ id: `add:${k}`, label: kindName(k), f: () => this.spawn(k), dot: dotOf(k) })));
    else if (this.tab === "board") grid((["note", "text", "frame", "holo"] as ItemKind[]).map((k) => ({ id: `add:${k}`, label: kindName(k), f: () => this.spawn(k), dot: k === "note" ? COLORS.gold : k === "frame" ? COLORS.violet : CYAN })));
    else if (this.tab === "library") grid(this.extras().library.map((l, i) => ({ id: `lib:${i}`, label: l.name, f: l.make, dot: CYAN })));
    else grid(this.extras().templates.map((l, i) => ({ id: `tpl:${i}`, label: l.name, f: l.make, dot: AMBER })));
    this.caption(ctx, this.tab === "templates" ? "Lays out a whole board where you're looking" : "Appears on the table where you're looking", 30, this.H - 22, 16);
  }
}

/* ---------------------------------- tune -------------------------------- */

export class TunePanel extends HoloPanel {
  section = BOARD_SECTIONS[0].id;
  presets: BoardPreset[] = BUILT_IN_PRESETS;
  private page = 0;

  constructor(private onPreset: (p: BoardPreset) => void) {
    super("tune", 0.56, 0.44, "Tune");
    this.resizable = false;
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    this.frameHolo(ctx);
    const left = 30;
    const colW = 250;
    let y = this.header + 8;
    for (const s of BOARD_SECTIONS) {
      this.holoButton(ctx, `sec:${s.id}`, left, y, colW, 31, s.title.replace("Headset · ", "⌂ "), () => ((this.section = s.id), (this.page = 0), this.invalidate()), { active: this.section === s.id, size: 16 });
      y += 34;
    }
    const sec = BOARD_SECTIONS.find((s) => s.id === this.section)!;
    const x0 = left + colW + 30;
    const w = this.W - x0 - 30;
    // Pages: as many knobs as fit above the presets.
    const rowH = (k: BoardKnob) => ("min" in k ? 74 : 48);
    const bottom = this.H - 120;
    const pages: BoardKnob[][] = [[]];
    let h = 0;
    for (const k of sec.knobs) {
      if (h + rowH(k) > bottom - this.header - 14 && pages[pages.length - 1].length) {
        pages.push([]);
        h = 0;
      }
      pages[pages.length - 1].push(k);
      h += rowH(k);
    }
    this.page = Math.min(this.page, pages.length - 1);
    y = this.header + 14;
    for (const k of pages[this.page]) {
      ctx.font = sans(20, 500);
      ctx.fillStyle = "#dff6ff";
      ctx.fillText(k.label.slice(0, 30), x0, y + 18);
      if ("toggle" in k) {
        this.holoToggle(ctx, `k:${k.key}`, x0 + w - 64, y, on(k.key), () => {
          setTune({ [k.key]: !on(k.key) });
          this.invalidate();
        });
      } else if ("choices" in k) {
        const v = pick(k.key);
        const i = Math.max(0, k.choices.indexOf(v));
        const step = (d: number) => {
          setTune({ [k.key]: k.choices[(i + d + k.choices.length) % k.choices.length] });
          this.invalidate();
        };
        const bw = 230;
        this.holoButton(ctx, `kp:${k.key}`, x0 + w - bw - 44, y - 4, 38, 36, "‹", () => step(-1), { size: 22 });
        this.holoButton(ctx, `k:${k.key}`, x0 + w - bw, y - 4, bw - 44, 36, (actionById(v)?.label ?? v).slice(0, 18), () => step(1), { size: 16, color: AMBER });
        this.holoButton(ctx, `kn:${k.key}`, x0 + w - 40, y - 4, 38, 36, "›", () => step(1), { size: 22 });
      } else {
        const v = num(k.key);
        ctx.font = cond(20, 600);
        ctx.fillStyle = AMBER;
        const txt = String(+v.toFixed(3));
        ctx.fillText(txt, x0 + w - ctx.measureText(txt).width, y + 18);
        this.holoSlider(ctx, `k:${k.key}`, x0 + 6, y + 22, w - 12, {
          value: v,
          min: k.min,
          max: k.max,
          step: k.step,
          onChange: (nv) => {
            setTune({ [k.key]: nv });
            this.invalidate();
          },
        });
      }
      y += rowH(k);
    }
    if (pages.length > 1) {
      const py = bottom + 6;
      this.holoButton(ctx, "page-", x0, py, 70, 34, "‹", () => ((this.page = Math.max(0, this.page - 1)), this.invalidate()), { size: 22 });
      this.caption(ctx, `${this.page + 1} / ${pages.length}`, x0 + 90, py + 24, 18);
      this.holoButton(ctx, "page+", x0 + 170, py, 70, 34, "›", () => ((this.page = Math.min(pages.length - 1, this.page + 1)), this.invalidate()), { size: 22 });
    }
    // Presets, and a reset for this section.
    let px = left;
    const py = this.H - 62;
    for (const p of this.presets.slice(0, 7)) {
      ctx.font = cond(18, 600);
      const pw = Math.max(90, ctx.measureText(p.name.toUpperCase()).width + 40);
      if (px + pw > this.W - 170) break;
      this.holoButton(ctx, `p:${p.name}`, px, py, pw, 38, p.name, () => this.onPreset(p), { size: 17, color: p.builtIn ? CYAN : AMBER });
      px += pw + 8;
    }
    this.holoButton(ctx, "reset", this.W - 160, py, 130, 38, "Reset", () => resetTune(sec.knobs.map((k) => k.key)), { size: 17, color: LOOK.danger });
  }
}

/* -------------------------------- callout ------------------------------- */

/** The selected item, beside it: colour, status, size, pull apart, delete. */
export class Callout extends HoloPanel {
  item: Item | null = null;
  count = 0;
  private key = "";

  constructor(private ctl: Ctl) {
    super("callout", 0.27, 0.19, "");
    this.header = 56;
  }

  set(b: Board | null, sel: string[]) {
    const it = sel.length === 1 ? b?.items.find((i) => i.id === sel[0]) ?? null : null;
    const key = JSON.stringify([it?.id, it?.color, it?.status, it?.scale, it?.explode, it?.spin, it?.label, it?.body, sel.length]);
    if (key === this.key) return;
    this.key = key;
    this.item = it;
    this.count = sel.length;
    this.invalidate();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const it = this.item;
    const ctl = this.ctl;
    if (!it) {
      this.frameHolo(ctx, `${this.count} selected`);
      this.holoButton(ctx, "del", 30, this.header + 20, 220, 50, "Delete them", () => ctl.remove(ctl.selected()), { color: LOOK.danger });
      this.holoButton(ctx, "none", 266, this.header + 20, 180, 50, "Deselect", () => ctl.select([]));
      return;
    }
    this.frameHolo(ctx, nameOf(it).slice(0, 22), kindName(it.kind));
    const patch = (p: Partial<Item>, merge?: string) => ctl.client.apply([{ op: "update", id: it.id, patch: p }], merge);
    let y = this.header + 8;
    Object.entries(COLORS).forEach(([n, c], i) => {
      const x = 30 + i * 34;
      const isOn = colorOf(it.color) === c;
      ctx.save();
      ctx.translate(x + 13, y + 16);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = c;
      ctx.globalAlpha = isOn ? 1 : 0.6;
      if (isOn) glow(ctx, c, 12);
      ctx.fillRect(isOn ? -11 : -8, isOn ? -11 : -8, isOn ? 22 : 16, isOn ? 22 : 16);
      ctx.restore();
      noGlow(ctx);
      this.region({ id: `c:${n}`, x, y, w: 30, h: 32, onClick: () => patch({ color: n }) });
    });
    y += 46;
    let x = 30;
    for (const s of STATUSES) {
      ctx.font = cond(18, 600);
      const w = ctx.measureText(s.toUpperCase()).width + 34;
      this.holoButton(ctx, `s:${s}`, x, y, w, 36, s, () => patch({ status: (it.status === s ? null : s) as never }), { size: 17, color: STATUS_COLOR[s], active: it.status === s });
      x += w + 6;
    }
    y += 50;
    this.holoButton(ctx, "smaller", 30, y, 52, 44, "−", () => patch({ scale: Math.max(0.1, (it.scale ?? 1) / 1.2) }, `scale:${it.id}`), { size: 26 });
    ctx.font = cond(22, 600);
    ctx.fillStyle = "#dff6ff";
    ctx.fillText(`${Math.round((it.scale ?? 1) * 100)}%`, 92, y + 30);
    this.holoButton(ctx, "bigger", 152, y, 52, 44, "+", () => patch({ scale: Math.min(10, (it.scale ?? 1) * 1.2) }, `scale:${it.id}`), { size: 26 });
    this.holoButton(ctx, "turn", 214, y, 90, 44, "Turn", () => patch({ rotY: ((it.rotY ?? 0) + 45) % 360 }, `rot:${it.id}`), { size: 19 });
    if (ctl.inside && !["frame", "ink", "text"].includes(it.kind)) this.holoButton(ctx, "inside", 314, y, 100, 44, it.sub ? "Inside" : "Open", () => ctl.inside!(it.id), { size: 19, color: AMBER });
    this.holoButton(ctx, "delete", this.W - 30 - 110, y, 110, 44, "Delete", () => ctl.remove([it.id]), { size: 19, color: LOOK.danger });
    y += 58;
    if (it.kind === "holo") {
      this.caption(ctx, "Pull apart", 30, y + 26, 16);
      this.holoSlider(ctx, "explode", 160, y + 2, this.W - 160 - 140, {
        value: it.explode ?? 0,
        min: 0,
        max: 1,
        step: 0.05,
        onChange: (v) => ctl.client.hold(it.id, { explode: v }),
        onCommit: () => ctl.client.release(it.id),
      });
      this.holoButton(ctx, "spin", this.W - 30 - 90, y, 90, 40, "Spin", () => patch({ spin: !it.spin }), { active: !!it.spin, size: 18 });
    } else {
      const body = it.kind === "note" || it.kind === "text" ? it.body ?? "" : it.tags?.join(" · ") ?? "";
      ctx.font = sans(19);
      ctx.fillStyle = LOOK.muted;
      ctx.fillText(body ? body.replace(/\s+/g, " ").slice(0, 52) : "Say what to change: “make this red”, “call it Gateway”…", 30, y + 26);
    }
  }
}

/* ------------------------------- captions ------------------------------- */

/** Subtitles: what the voice says (or heard), and what the builder's doing. No panel, just light. */
export class Captions extends HoloPanel {
  private key = "";
  text = "";
  color = "#dff6ff";

  constructor() {
    super("captions", 0.62, 0.07, "");
    this.header = 0;
  }

  show(text: string, color: string) {
    const key = `${text}|${color}`;
    if (key === this.key) return;
    this.key = key;
    this.text = text;
    this.color = color;
    this.invalidate();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    if (!this.text) return;
    const { W, H } = this;
    ctx.font = sans(30, 500);
    let t = this.text;
    while (ctx.measureText(t).width > W - 60 && t.length > 8) t = `…${t.slice(Math.ceil(t.length * 0.12))}`;
    const tw = ctx.measureText(t).width;
    // A faint band behind the words, so they read against a bright room.
    const g = ctx.createLinearGradient((W - tw) / 2 - 40, 0, (W + tw) / 2 + 40, 0);
    g.addColorStop(0, "rgba(0,8,14,0)");
    g.addColorStop(0.15, "rgba(0,8,14,0.55)");
    g.addColorStop(0.85, "rgba(0,8,14,0.55)");
    g.addColorStop(1, "rgba(0,8,14,0)");
    ctx.fillStyle = g;
    ctx.fillRect((W - tw) / 2 - 40, 8, tw + 80, H - 16);
    ctx.textAlign = "center";
    glow(ctx, this.color, 12);
    ctx.fillStyle = this.color;
    ctx.fillText(t, W / 2, H / 2 + 11);
    noGlow(ctx);
    ctx.textAlign = "left";
  }
}

/* ------------------------------ placement ------------------------------- */

/** The head's pose, flattened: where it is, the way it faces on the floor, and its right. */
export function headFrame(cam: THREE.Camera) {
  const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  return { head, fwd, right };
}

/** Face a panel toward the head, tilted back a little as a desk display is. */
export function faceHead(m: THREE.Object3D, head: THREE.Vector3) {
  m.lookAt(head.x, m.position.y + (head.y - m.position.y) * 0.6, head.z);
}
