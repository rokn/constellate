import * as THREE from "three";
import { ARCH_KINDS, COLORS, STATUSES, colorOf, nameOf, type Board, type Item, type ItemKind } from "../../shared/board";
import { BOARD_SECTIONS, BUILT_IN_PRESETS, type BoardPreset } from "../../shared/boardTune";
import { Panel, cond, sans, withAlpha } from "../xr/ui";
import type { Ctl, Tool } from "./ctl";
import { LOOK, STATUS_COLOR } from "./look";
import { num, on, resetTune, setTune } from "./tune";

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

const TOOL_ICON: Record<Tool, string> = { select: "select", connect: "connect", ink: "ink" };
const KIND_NAME: Partial<Record<ItemKind, string>> = { function: "Lambda", holo: "Hologram" };
const kindName = (k: ItemKind) => KIND_NAME[k] ?? k[0].toUpperCase() + k.slice(1);

/* --------------------------------- dock --------------------------------- */

/** The wrist: the tools, the voice, and the way to every other panel. */
export class Dock extends HoloPanel {
  constructor(
    private ctl: Ctl,
    private on: { palette: () => void; tune: () => void; recenter: () => void; exit: () => void; isOpen: (name: string) => boolean },
  ) {
    super("dock", 0.26, 0.1, "");
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
    const buttons: [string, string, () => void, boolean, string?][] = [
      ...(["select", "connect", "ink"] as Tool[]).map((t) => [`t:${t}`, TOOL_ICON[t], () => this.ctl.setTool(t), this.ctl.tool() === t] as [string, string, () => void, boolean]),
      ["voice", "voice", () => this.ctl.toggleVoice(), voiceOn, v === "speaking" ? AMBER : voiceOn ? "#7dff9a" : undefined],
      ["palette", "build", this.on.palette, this.on.isOpen("palette")],
      ["tune", "tune", this.on.tune, this.on.isOpen("tune")],
      ["undo", "undo", () => this.ctl.client.undo(), false],
      ["redo", "redo", () => this.ctl.client.redo(), false],
      ["table", "table", this.on.recenter, false],
    ];
    const s = 46;
    const gap = (W - 24 - buttons.length * s) / (buttons.length - 1);
    buttons.forEach(([id, ic, f, act, col], i) => this.iconButton(ctx, id, 12 + i * (s + gap), (H - s) / 2 - 8, s, ic, f, act, col));
    ctx.font = cond(15, 600);
    ctx.letterSpacing = "3px";
    ctx.fillStyle = withAlpha(CYAN, 0.6);
    ctx.textAlign = "center";
    ctx.fillText(`${this.ctl.tool().toUpperCase()} · VOICE ${voiceOn ? "ON" : "OFF"}`, W / 2, H - 12);
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

  constructor(private onPreset: (p: BoardPreset) => void) {
    super("tune", 0.52, 0.42, "Tune");
    this.resizable = false;
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    this.frameHolo(ctx);
    const left = 30;
    const colW = 230;
    let y = this.header + 10;
    for (const s of BOARD_SECTIONS) {
      this.holoButton(ctx, `sec:${s.id}`, left, y, colW, 34, s.title.replace("Headset · ", "⌂ "), () => ((this.section = s.id), this.invalidate()), { active: this.section === s.id, size: 17 });
      y += 39;
    }
    const sec = BOARD_SECTIONS.find((s) => s.id === this.section)!;
    const x0 = left + colW + 30;
    const w = this.W - x0 - 30;
    y = this.header + 14;
    for (const k of sec.knobs) {
      ctx.font = sans(21, 500);
      ctx.fillStyle = "#dff6ff";
      ctx.fillText(k.label, x0, y + 18);
      if ("toggle" in k) {
        this.holoToggle(ctx, `k:${k.key}`, x0 + w - 64, y, on(k.key), () => {
          setTune({ [k.key]: !on(k.key) });
          this.invalidate();
        });
        y += 46;
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
        y += 74;
      }
      if (y > this.H - 110) break;
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
