import { DEFAULT_TUNING, FORCE_KNOBS, PRESETS, SECTIONS, SHAPE_KNOBS, type Knob, type Tuning } from "../lib/tuning";
import { DEFAULT_XR, XR_SECTIONS, type XRKnob, type XRSettings } from "../lib/xrSettings";
import type { Actions, Model } from "./model";
import { C, Panel, cond, fit, mono, sans, wrap } from "./ui";

/**
 * The desktop's Tune panel, in the headset: every map knob (the same
 * sections, presets and resets, the same tuning object, so a change made in
 * here is there when you take the headset off), and a second tab for the
 * headset's own knobs. Sliders are dragged with the trigger; knobs that
 * rebuild the bodies or reheat the layout apply when you let go, the rest
 * while you drag.
 */

const PAD = 34;
const ROW_RANGE = 100;
const ROW_TOGGLE = 66;
const ROW_SECTION = 64;
/** Live knobs are sent at most this often while dragging: each send re-renders the desktop app. */
const LIVE_MS = 120;

type Tab = "map" | "headset";
type AnyKnob = Knob | XRKnob;

export class TunePanel extends Panel {
  m: Model | null = null;
  tab: Tab = "map";
  private expanded: Record<string, boolean> = { glow: true, bodies: true, sight: true, passthrough: true, floor: true, comfort: true, sound: true };
  /** Values being dragged, not yet (all) sent. */
  private drafts = new Map<string, number>();
  private sentAt = 0;

  constructor(private a: Actions) {
    super("tune", 0.74, 0.92);
  }

  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (!p || p.tuning !== m.tuning || p.settings !== m.settings || p.mode !== m.mode) this.invalidate();
  }

  private value(tab: Tab, key: string): number | boolean {
    const d = this.drafts.get(`${tab}:${key}`);
    if (d !== undefined) return d;
    return tab === "map" ? this.m!.tuning[key as keyof Tuning] : this.m!.settings[key as keyof XRSettings];
  }

  private send(tab: Tab, patch: Record<string, number | boolean>) {
    if (tab === "map") this.a.setTuning(patch as Partial<Tuning>);
    else this.a.setXR(patch as Partial<XRSettings>);
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m) return;
    this.frame(ctx, C.course);
    const W = this.W;

    // Header: title, tabs, close.
    ctx.font = cond(36, 600);
    ctx.fillStyle = C.text;
    ctx.fillText("Tune", PAD, 64);
    let x = PAD + 110;
    x = this.button(ctx, "tab:map", x, 24, "The map", () => this.setTab("map"), { active: this.tab === "map", size: 25 }) + 10;
    this.button(ctx, "tab:headset", x, 24, "The headset", () => this.setTab("headset"), { active: this.tab === "headset", size: 25 });
    this.button(ctx, "close", W - PAD - 58, 22, "✕", this.a.toggleTune, { w: 58, h: 52 });

    // Second row: presets (map) and the resets.
    let y = 96;
    x = PAD;
    if (this.tab === "map") {
      const presetOn = (patch: Partial<Tuning>) => (Object.keys(DEFAULT_TUNING) as (keyof Tuning)[]).every((k) => m.tuning[k] === (patch[k] ?? DEFAULT_TUNING[k]));
      for (const p of PRESETS) {
        ctx.font = cond(22, 600);
        const w = ctx.measureText(p.title).width + 32;
        if (x + w > W - PAD) break;
        x = this.button(ctx, `preset:${p.id}`, x, y, p.title, () => this.a.setTuning({ ...DEFAULT_TUNING, ...p.patch }), { size: 22, w, active: presetOn(p.patch), accent: C.course }) + 8;
      }
      y += 60;
      x = PAD;
      x = this.button(ctx, "relayout", x, y, "Re-layout", this.a.relayout, { size: 22 }) + 8;
      this.button(ctx, "reset", x, y, "Reset all", () => this.a.setTuning(DEFAULT_TUNING), { size: 22 });
    } else {
      // The hints are worth leaving as they were.
      this.button(ctx, "reset", x, y, "Reset all", () => this.a.setXR({ ...DEFAULT_XR, hintsSeen: m.settings.hintsSeen }), { size: 22 });
      ctx.font = sans(21);
      ctx.fillStyle = C.muted;
      ctx.fillText(fit(ctx, m.mode === "ar" ? "In passthrough now." : m.mode === "vr" ? "In VR now." : "", W - x - 200), x + 150, y + 30);
    }
    y += 64;
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, y, W - PAD * 2, 2);
    const top = y + 8;
    const bottom = this.H - 92;

    // Body: the sections, scrolled.
    const sections = this.tab === "map" ? SECTIONS : XR_SECTIONS;
    let total = 0;
    for (const sec of sections) {
      total += ROW_SECTION;
      if (this.expanded[sec.id]) for (const k of sec.knobs) total += "toggle" in k ? ROW_TOGGLE : ROW_RANGE;
    }
    this.maxScroll = Math.max(0, total - (bottom - top) + 16);
    this.scrollY = Math.min(this.scrollY, this.maxScroll);
    const before = this.regions.length;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, W, bottom - top);
    ctx.clip();
    y = top - this.scrollY;
    let hint: string | undefined;
    for (const sec of sections) {
      const isOpen = !!this.expanded[sec.id];
      const defaults = (this.tab === "map" ? DEFAULT_TUNING : DEFAULT_XR) as Record<string, number | boolean>;
      const dirty = sec.knobs.some((k) => this.value(this.tab, k.key) !== defaults[k.key]);
      if (y + ROW_SECTION >= top && y <= bottom) {
        this.row(ctx, `sec:${sec.id}`, PAD - 8, y + 6, W - PAD * 2 - 110, ROW_SECTION - 12, () => ((this.expanded[sec.id] = !isOpen), this.invalidate()));
        ctx.font = cond(27, 600);
        ctx.fillStyle = C.text;
        ctx.fillText(`${isOpen ? "▾" : "▸"}  ${sec.title}`, PAD, y + 42);
        if (dirty) {
          ctx.fillStyle = C.course;
          ctx.beginPath();
          ctx.arc(PAD + 30 + ctx.measureText(`▾  ${sec.title}`).width, y + 33, 6, 0, Math.PI * 2);
          ctx.fill();
          const tab = this.tab;
          this.button(ctx, `secreset:${sec.id}`, W - PAD - 100, y + 12, "Reset", () => this.send(tab, Object.fromEntries(sec.knobs.map((k) => [k.key, defaults[k.key]]))), { size: 20, w: 100, h: 42 });
        }
      }
      y += ROW_SECTION;
      if (!isOpen) continue;
      for (const k of sec.knobs as AnyKnob[]) {
        const h = "toggle" in k ? ROW_TOGGLE : ROW_RANGE;
        if (y + h >= top && y <= bottom) {
          const id = `k:${this.tab}:${k.key}`;
          if (this.hover === id && k.hint) hint = k.hint;
          this.knob(ctx, k, id, y, defaults[k.key]);
        }
        y += h;
      }
    }
    ctx.restore();
    // What scrolled under the header (or the footer) can't be pointed at through it.
    this.regions = [...this.regions.slice(0, before), ...this.regions.slice(before).filter((r) => r.y + r.h > top && r.y < bottom)];
    if (this.maxScroll > 0) {
      const track = bottom - top;
      const thumb = Math.max(40, (track * track) / (track + this.maxScroll));
      ctx.fillStyle = "rgba(91, 214, 255, 0.45)";
      ctx.fillRect(W - 14, top + ((track - thumb) * this.scrollY) / this.maxScroll, 6, thumb);
    }

    // Footer: what the knob under the ray does.
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, bottom + 4, W - PAD * 2, 2);
    ctx.font = sans(21);
    ctx.fillStyle = C.muted;
    const lines = wrap(ctx, hint ?? "Point at a knob to see what it does. Drag a slider with the trigger; the stick scrolls.", W - PAD * 2).slice(0, 2);
    lines.forEach((l, i) => ctx.fillText(l, PAD, bottom + 38 + i * 28));
  }

  private setTab(t: Tab) {
    this.tab = t;
    this.scrollY = 0;
    this.invalidate();
  }

  private knob(ctx: CanvasRenderingContext2D, k: AnyKnob, id: string, y: number, def: number | boolean) {
    const W = this.W;
    const tab = this.tab;
    const v = this.value(tab, k.key);
    const changed = v !== def;
    ctx.font = sans(24);
    ctx.fillStyle = changed ? C.text : withMuted();
    if ("toggle" in k) {
      ctx.fillText(fit(ctx, k.label, W - PAD * 2 - 120), PAD + 8, y + 40);
      this.toggle(ctx, id, W - PAD - 86, y + 12, !!v, () => this.send(tab, { [k.key]: !v }));
      return;
    }
    const n = v as number;
    const digits = k.step >= 1 ? 0 : k.step >= 0.1 ? 1 : 2;
    ctx.fillText(fit(ctx, k.label, W - PAD * 2 - 140), PAD + 8, y + 34);
    ctx.font = mono(21);
    ctx.fillStyle = this.drafts.has(`${tab}:${k.key}`) ? C.course : C.muted;
    ctx.textAlign = "right";
    ctx.fillText(n.toFixed(digits), W - PAD - 8, y + 34);
    ctx.textAlign = "left";
    // Sizes and labels rebuild every body, forces reheat the layout: those wait for the release.
    const deferred = tab === "map" && (SHAPE_KNOBS.includes(k.key as keyof Tuning) || FORCE_KNOBS.includes(k.key as keyof Tuning));
    const dk = `${tab}:${k.key}`;
    this.slider(ctx, id, PAD + 24, y + 46, W - PAD * 2 - 48, {
      value: n,
      min: k.min,
      max: k.max,
      step: k.step,
      changed,
      onChange: (nv) => {
        if (this.drafts.get(dk) === nv) return;
        this.drafts.set(dk, nv);
        this.invalidate();
        const now = performance.now();
        if (!deferred && now - this.sentAt > LIVE_MS) {
          this.sentAt = now;
          this.send(tab, { [k.key]: nv });
        }
      },
      onCommit: () => {
        const d = this.drafts.get(dk);
        this.drafts.delete(dk);
        if (d !== undefined) this.send(tab, { [k.key]: d });
        this.invalidate();
      },
    });
  }
}

const withMuted = () => "#c3cbdb";

/* --------------------------------- hints --------------------------------- */

const HINTS: { title: string; color: string; rows: [string, string][] }[] = [
  {
    title: "Either hand",
    color: C.static,
    rows: [
      ["Trigger", "Pick a file, module or button"],
      ["Trigger + move on a body", "Drag it; the map gives way"],
      ["Trigger on open sky", "Move the map"],
      ["Grip", "Move the map, wherever you point"],
      ["Both grips", "Stretch to scale, twist to turn"],
      ["Grip on a panel, or trigger on its handle", "Carry the panel"],
    ],
  },
  {
    title: "Left controller",
    color: C.course,
    rows: [
      ["Stick", "Fly where you point"],
      ["X", "Voice on / off"],
      ["Y", "Whole map"],
      ["Stick click", "Ask or search"],
    ],
  },
  {
    title: "Right controller",
    color: C.runtime,
    rows: [
      ["Stick left / right", "Turn"],
      ["Stick up / down", "Zoom toward what you point at (or push / pull a held body)"],
      ["A", "Menu"],
      ["B", "Back"],
      ["Stick click", "Frame the selection"],
    ],
  },
  {
    title: "Hands",
    color: C.good,
    rows: [
      ["Pinch", "Same as the trigger"],
      ["Pinch both hands on open sky", "Scale and turn the map"],
    ],
  },
];

/** What every button does: opened from the dock's "?" (and on your first visit). */
export class HintsPanel extends Panel {
  constructor(private a: Actions) {
    super("hints", 1.0, 0.5);
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    this.frame(ctx, C.static);
    const W = this.W;
    ctx.font = cond(36, 600);
    ctx.fillStyle = C.text;
    ctx.fillText("Controls", PAD, 64);
    ctx.font = sans(25);
    ctx.fillStyle = C.muted;
    ctx.fillText("Panels stay where you put them. Lost one? Menu → Recenter panels.", PAD + 180, 62);
    this.button(ctx, "close", W - PAD - 58, 22, "✕", this.a.toggleHints, { w: 58, h: 52 });

    const colW = (W - PAD * 3) / 2;
    const col = (i: number) => PAD + (i % 2) * (colW + PAD);
    const ys = [130, 130];
    const LH = 36;
    HINTS.forEach((g, i) => {
      // Either hand and hands on the left, the two controllers on the right.
      const c = i === 1 || i === 2 ? 1 : 0;
      const x = col(c);
      let y = ys[c];
      ctx.font = cond(32, 600);
      ctx.fillStyle = g.color;
      ctx.fillText(g.title.toUpperCase(), x, y);
      y += 14;
      for (const [k, v] of g.rows) {
        ctx.font = cond(30, 600);
        const kl = wrap(ctx, k, colW * 0.4);
        ctx.fillStyle = C.text;
        kl.forEach((l, j) => ctx.fillText(l, x, y + 34 + j * LH));
        ctx.font = sans(27);
        const vl = wrap(ctx, v, colW * 0.56);
        ctx.fillStyle = C.muted;
        vl.forEach((l, j) => ctx.fillText(l, x + colW * 0.44, y + 34 + j * LH));
        y += 12 + Math.max(kl.length, vl.length) * LH;
      }
      ys[c] = y + 46;
    });
    this.button(ctx, "ok", W - PAD - 160, this.H - 82, "Got it", this.a.toggleHints, { w: 160, h: 56, accent: C.course, active: true });
  }
}
