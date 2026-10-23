import type { Actions, Model } from "./model";
import { C, Panel, cond, fit, roundRect, sans, wrap } from "./ui";

/**
 * Panels for a map set down on a real table (passthrough), and the one on
 * your wrist. They lie flat on the table itself, where your hands already
 * are: a strip of controls along the edge nearest you, on the right-hand edge
 * the modules you've thrown off the map, each waiting, collapsed, to be put
 * back with a press, and on the left the saved views (views.ts). All of them
 * are pressed with a fingertip, against the table.
 */

const PAD = 22;

/** Along the table's front edge: the controls you reach for most. */
export class TableMenu extends Panel {
  m: Model | null = null;

  constructor(private a: Actions) {
    super("table-menu", 0.72, 0.12);
  }

  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (!p || p.menuOpen !== m.menuOpen || p.tuneOpen !== m.tuneOpen || p.filterOpen !== m.filterOpen || p.hintsOpen !== m.hintsOpen || p.voice !== m.voice || p.filter !== m.filter) this.invalidate();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m) return;
    this.frame(ctx, C.static);
    const v = m.voice.state;
    const buttons: { id: string; label: string; run: () => void; active?: boolean; accent?: string; disabled?: boolean }[] = [
      { id: "back", label: "Back", run: this.a.back },
      { id: "overview", label: "Whole map", run: this.a.overview },
      { id: "menu", label: "Menu", run: this.a.toggleMenu, active: m.menuOpen },
      { id: "filter", label: "Filter", run: this.a.toggleFilter, active: m.filterOpen || m.filter.active },
      { id: "tune", label: "Tune", run: this.a.toggleTune, active: m.tuneOpen },
      { id: "voice", label: v === "listening" ? "Listening" : v === "speaking" ? "Speaking" : "Voice", run: this.a.toggleVoice, active: v !== "idle" && v !== "error", accent: C.course, disabled: !m.voice.available },
      { id: "ask", label: "Ask", run: () => this.a.openKeyboard("ask") },
      { id: "hints", label: "?", run: this.a.toggleHints, active: m.hintsOpen },
      { id: "lift", label: "Off table", run: this.a.leaveTable },
    ];
    const gap = 10;
    const h = this.H - PAD * 2;
    const w = (this.W - PAD * 2 - gap * (buttons.length - 1)) / buttons.length;
    buttons.forEach((b, i) => this.button(ctx, `t:${b.id}`, PAD + i * (w + gap), PAD, b.label, b.run, { w, h, size: 30, active: b.active, accent: b.accent, disabled: b.disabled }));
  }
}

/** Along the table's right edge: what's off the map, a press away from coming back. */
export class Shelf extends Panel {
  m: Model | null = null;

  constructor(private a: Actions) {
    super("shelf", 0.26, 0.46);
  }

  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (!p || p.legend !== m.legend || p.mapFilter !== m.mapFilter) this.invalidate();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m) return;
    this.frame(ctx, C.runtime);
    const W = this.W;
    ctx.font = cond(34, 600);
    ctx.fillStyle = C.text;
    ctx.fillText("Off the map", PAD, 58);
    const parked = m.legend.rows.filter((r) => r.isolated === "out");
    const hidden = m.mapFilter.hidden?.length ?? 0;
    ctx.font = sans(21);
    ctx.fillStyle = C.muted;
    ctx.fillText(parked.length ? "Press one to put it back" : "", PAD, 90);

    const rowH = 64;
    let y = 112;
    const bottom = this.H - (hidden ? rowH + PAD : PAD);
    const room = Math.max(0, Math.floor((bottom - y) / (rowH + 8)));
    const shown = parked.length > room ? parked.slice(0, Math.max(0, room - 1)) : parked;
    for (const r of shown) {
      const id = `p:${r.id}`;
      const hot = this.hover === id;
      ctx.fillStyle = hot ? "rgba(91, 214, 255, 0.16)" : C.panel2;
      roundRect(ctx, PAD, y, W - PAD * 2, rowH, 14);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = hot ? C.static : C.line;
      ctx.stroke();
      // The module, collapsed: a body in its own colour.
      const color = r.color ?? C.static;
      const g = ctx.createRadialGradient(PAD + 34, y + rowH / 2, 2, PAD + 34, y + rowH / 2, 20);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.35, color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(PAD + 34, y + rowH / 2, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = cond(28, 600);
      ctx.fillStyle = C.text;
      ctx.fillText(fit(ctx, r.label, W - PAD * 2 - 130), PAD + 66, y + rowH / 2 + 10);
      ctx.font = sans(20);
      ctx.fillStyle = C.muted;
      ctx.textAlign = "right";
      ctx.fillText(String(r.count), W - PAD - 16, y + rowH / 2 + 8);
      ctx.textAlign = "left";
      this.region({ id, x: PAD, y, w: W - PAD * 2, h: rowH, onClick: () => this.a.isolate(r.id, "exclude") });
      y += rowH + 8;
    }
    if (shown.length < parked.length) {
      this.button(ctx, "more", PAD, y, `${parked.length - shown.length} more…`, this.a.toggleFilter, { w: W - PAD * 2, h: rowH - 8, size: 24 });
    }
    if (!parked.length) {
      ctx.font = sans(23);
      ctx.fillStyle = C.muted;
      const lines = wrap(ctx, "Throw a module off the map, or drop a dragged one here, and it waits on the table.", W - PAD * 2);
      lines.forEach((l, i) => ctx.fillText(l, PAD, 140 + i * 32));
    }
    if (hidden) {
      const f = m.mapFilter;
      this.button(ctx, "files", PAD, this.H - PAD - rowH, `Show ${hidden} hidden file${hidden > 1 ? "s" : ""}`, () => this.a.setMapFilter({ ...f, hidden: undefined }), { w: W - PAD * 2, h: rowH, size: 24 });
    }
  }
}

/** On the left palm, turned up: the dock's buttons, to poke with the other hand. */
export class WristPanel extends Panel {
  m: Model | null = null;

  constructor(private a: Actions) {
    super("wrist", 0.27, 0.13);
  }

  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (!p || p.menuOpen !== m.menuOpen || p.filterOpen !== m.filterOpen || p.viewsOpen !== m.viewsOpen || p.hintsOpen !== m.hintsOpen || p.voice !== m.voice || p.table !== m.table) this.invalidate();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m) return;
    this.frame(ctx, C.good);
    const v = m.voice.state;
    const cells: { id: string; label: string; run: () => void; active?: boolean; accent?: string; disabled?: boolean }[] = [
      { id: "menu", label: "Menu", run: this.a.toggleMenu, active: m.menuOpen },
      { id: "voice", label: v === "listening" ? "Listening" : "Voice", run: this.a.toggleVoice, active: v !== "idle" && v !== "error", accent: C.course, disabled: !m.voice.available },
      { id: "overview", label: "Whole map", run: this.a.overview },
      { id: "ask", label: "Ask", run: () => this.a.openKeyboard("ask") },
      { id: "filter", label: "Filter", run: this.a.toggleFilter, active: m.filterOpen },
      { id: "views", label: "Views", run: this.a.toggleViews, active: m.viewsOpen || m.table, accent: C.course, disabled: m.table },
      { id: "hints", label: "?", run: this.a.toggleHints, active: m.hintsOpen },
    ];
    const gap = 8;
    const pad = 14;
    const cols = 4;
    const w = (this.W - pad * 2 - gap * (cols - 1)) / cols;
    const h = (this.H - pad * 2 - gap) / 2;
    cells.forEach((c, i) => this.button(ctx, `w:${c.id}`, pad + (i % cols) * (w + gap), pad + Math.floor(i / cols) * (h + gap), c.label, c.run, { w, h, size: 24, active: c.active, accent: c.accent, disabled: c.disabled }));
  }
}

/** While you trace the table by hand: what to do, and Undo / Done / Cancel. */
export class OutlinePanel extends Panel {
  m: Model | null = null;

  constructor(private a: Actions) {
    super("outline", 0.62, 0.26);
  }

  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (!p || p.outlining !== m.outlining || p.inputs !== m.inputs) this.invalidate();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m || !m.outlining) return;
    this.frame(ctx, C.good);
    const n = m.outlining.corners;
    const what = m.outlining.kind === "table" ? "the table" : "the surface";
    const press = m.inputs.hands && !m.inputs.controllers ? "pinch" : "pull the trigger";
    ctx.font = cond(34, 600);
    ctx.fillStyle = C.text;
    ctx.fillText(n ? `${n} corner${n > 1 ? "s" : ""}` : m.outlining.kind === "table" ? "Trace your table" : "Trace a surface for panels", PAD, 58);
    ctx.font = sans(23);
    ctx.fillStyle = C.muted;
    const say =
      n < 3
        ? `Touch each corner of ${what} in turn and ${press} right there. Three corners make a rectangle.`
        : n === 3
          ? `Done makes a rectangle of these three corners, or go on round ${what} to trace its shape.`
          : "Done when you've been all the way round.";
    wrap(ctx, say, this.W - PAD * 2)
      .slice(0, 2)
      .forEach((l, i) => ctx.fillText(l, PAD, 98 + i * 30));
    const y = this.H - PAD - 64;
    let x = PAD;
    x = this.button(ctx, "done", x, y, "Done", this.a.finishOutline, { w: 170, h: 64, active: n >= 3, accent: C.good, disabled: n < 3 }) + 12;
    x = this.button(ctx, "undo", x, y, "Undo", this.a.undoOutline, { w: 150, h: 64, disabled: !n }) + 12;
    this.button(ctx, "cancel", x, y, "Cancel", this.a.cancelOutline, { w: 170, h: 64 });
  }
}
