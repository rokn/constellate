import { EMPTY_FILTER, isActive } from "../../shared/filter";
import type { MapFilter, SavedFilter } from "../../shared/types";
import type { Actions, Model } from "./model";
import { C, Panel, cond, fit, roundRect, sans, wrap } from "./ui";

/**
 * The desktop's saved views, in the headset: one press switches the map to
 * one (again, back to everything), the current filter can be saved under a
 * name typed on the room's keyboard, and ✕ (pressed twice) deletes one. On a
 * table it lies along the left edge, opposite the shelf; elsewhere it opens
 * from the dock.
 */

const PAD = 22;

const same = (a: MapFilter, b: MapFilter) => JSON.stringify({ ...EMPTY_FILTER, ...a }) === JSON.stringify({ ...EMPTY_FILTER, ...b });

/** A view in a few words: what it keeps and what it hides. */
export function describeFilter(f: MapFilter): string {
  const parts: string[] = [];
  for (const i of f.isolate ?? []) parts.push(`${i.exclude ? "not" : "only"} ${i.label}`);
  if (f.paths) parts.push(`${f.paths.length} chosen files`);
  if (f.include.length) parts.push(`only ${f.include.join(", ")}`);
  if (f.tops.length) parts.push(`in ${f.tops.join(", ")}`);
  if (f.langs.length) parts.push(f.langs.join(", "));
  if (f.exclude.length) parts.push(`not ${f.exclude.join(", ")}`);
  if (f.hideTests) parts.push("no tests");
  if (f.hideDocs) parts.push("no docs");
  if (f.hidden?.length) parts.push(`${f.hidden.length} hidden`);
  return parts.join(" · ") || "everything";
}

export class ViewsPanel extends Panel {
  m: Model | null = null;
  /** The view whose ✕ was pressed once: a second press deletes it. */
  private armed: string | null = null;
  private armedAt = 0;

  constructor(private a: Actions) {
    super("views", 0.26, 0.46);
  }

  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (this.armed && performance.now() - this.armedAt > 3000) this.armed = null;
    if (!p || p.mapFilter !== m.mapFilter || p.savedFilters !== m.savedFilters || p.table !== m.table) this.invalidate();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m) return;
    this.frame(ctx, C.course);
    const W = this.W;
    const f = m.mapFilter;
    ctx.font = cond(34, 600);
    ctx.fillStyle = C.text;
    ctx.fillText("Saved views", PAD, 58);
    if (!m.table) this.button(ctx, "close", W - PAD - 52, 18, "✕", this.a.toggleViews, { w: 52, h: 48, size: 24 });
    const current = m.savedFilters.find((v) => same(v.filter, f));
    ctx.font = sans(21);
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, current ? `Showing ${current.name}` : isActive(f) ? "A filter you haven't saved" : "The whole map", W - PAD * 2), PAD, 90);

    const rowH = 76;
    const saveH = 60;
    let y = 108;
    const bottom = this.H - PAD - saveH - 10;
    const room = Math.max(0, Math.floor((bottom - y) / (rowH + 8)));
    // More than fit: the rest scroll, the way a finger scrolls a page.
    const list = m.savedFilters;
    this.maxScroll = Math.max(0, (list.length - room) * (rowH + 8));
    this.scrollY = Math.min(this.scrollY, this.maxScroll);
    const first = Math.round(this.scrollY / (rowH + 8));
    for (const v of list.slice(first, first + room)) {
      this.viewRow(ctx, v, y, rowH, v === current);
      y += rowH + 8;
    }
    if (!list.length) {
      ctx.font = sans(22);
      ctx.fillStyle = C.muted;
      const lines = wrap(ctx, "Filter the map, then save it here: one press brings it back, here or on the desktop.", W - PAD * 2);
      lines.forEach((l, i) => ctx.fillText(l, PAD, 140 + i * 30));
    } else if (list.length > room) {
      ctx.font = sans(19);
      ctx.fillStyle = C.muted;
      ctx.fillText(`${first + 1}–${first + room} of ${list.length} · drag to scroll`, PAD, bottom + 4);
    }

    const canSave = isActive(f) && !current;
    this.button(ctx, "save", PAD, this.H - PAD - saveH, canSave ? "Save this view…" : current ? "Saved" : "Filter first, then save", () => this.a.openKeyboard("view", undefined, f.label ?? ""), {
      w: W - PAD * 2,
      h: saveH,
      size: 24,
      accent: C.course,
      active: canSave,
      disabled: !canSave,
    });
  }

  private viewRow(ctx: CanvasRenderingContext2D, v: SavedFilter, y: number, h: number, on: boolean) {
    const W = this.W;
    const id = `v:${v.name}`;
    const hot = this.hover === id;
    const down = this.pressed === id;
    const w = W - PAD * 2 - 66;
    roundRect(ctx, PAD, y, w, h, 14);
    ctx.fillStyle = down ? "rgba(255, 79, 216, 0.3)" : on ? "rgba(255, 79, 216, 0.16)" : hot ? "rgba(91, 214, 255, 0.16)" : C.panel2;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = on || down ? C.course : hot ? C.static : C.line;
    ctx.stroke();
    ctx.font = cond(28, 600);
    ctx.fillStyle = on ? C.course : C.text;
    ctx.fillText(fit(ctx, v.name, w - 28), PAD + 14, y + 34);
    ctx.font = sans(18);
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, describeFilter(v.filter), w - 28), PAD + 14, y + 60);
    this.region({ id, x: PAD, y, w, h, onClick: () => this.a.setMapFilter(on ? EMPTY_FILTER : { ...EMPTY_FILTER, ...v.filter }) });
    const armed = this.armed === v.name;
    this.button(
      ctx,
      `del:${v.name}`,
      W - PAD - 58,
      y,
      armed ? "Sure?" : "✕",
      () => {
        if (!armed) {
          this.armed = v.name;
          this.armedAt = performance.now();
          return this.invalidate();
        }
        this.armed = null;
        this.a.setSavedFilters(this.m!.savedFilters.filter((x) => x.name !== v.name));
      },
      { w: 58, h, size: armed ? 18 : 24, accent: C.bad, active: armed },
    );
  }
}
