import { EMPTY_FILTER } from "../../shared/filter";
import type { MapFilter } from "../../shared/types";
import type { Actions, Model } from "./model";
import { C, Panel, cond, fit, fitPath, mono, sans } from "./ui";

/**
 * The desktop's Filter panel, in the headset: saved views, tests and docs,
 * path patterns (typed on the room's keyboard), languages, top-level
 * folders, what's isolated, and the files you've hidden, each one back with
 * a press.
 */

const PAD = 34;

export class FilterPanel extends Panel {
  m: Model | null = null;

  constructor(private a: Actions) {
    super("filter", 0.74, 0.9);
  }

  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (!p || p.mapFilter !== m.mapFilter || p.savedFilters !== m.savedFilters || p.visibleCount !== m.visibleCount || p.langs !== m.langs || p.tops !== m.tops) this.invalidate();
  }

  /** Hand edits drop the navigator's name and file set: they no longer describe what's shown. */
  private set(patch: Partial<MapFilter>) {
    this.a.setMapFilter({ ...this.m!.mapFilter, label: undefined, paths: undefined, ...patch });
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m) return;
    const f = m.mapFilter;
    const W = this.W;
    this.frame(ctx, C.static);
    ctx.font = cond(36, 600);
    ctx.fillStyle = C.text;
    ctx.fillText("Filter the map", PAD, 64);
    ctx.font = sans(22);
    ctx.fillStyle = C.muted;
    ctx.fillText(`${m.visibleCount} of ${m.totalCount} files`, PAD, 100);
    this.button(ctx, "close", W - PAD - 58, 22, "✕", this.a.toggleFilter, { w: 58, h: 52 });
    this.button(ctx, "all", W - PAD - 58 - 12 - 210, 22, "Show everything", () => this.a.setMapFilter(EMPTY_FILTER), { w: 210, h: 52, size: 22, disabled: !m.filter.active });
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, 122, W - PAD * 2, 2);

    const top = 132;
    const bottom = this.H - 18;
    const before = this.regions.length;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, W, bottom - top);
    ctx.clip();
    let y = top + 12 - this.scrollY;

    const heading = (t: string) => {
      ctx.font = cond(23, 600);
      ctx.fillStyle = C.muted;
      ctx.fillText(t.toUpperCase(), PAD, y + 26);
      y += 40;
    };
    /** A wrapping row of chips. */
    const chips = (items: { id: string; label: string; on: boolean; onClick: () => void; accent?: string }[]) => {
      let x = PAD;
      for (const it of items) {
        ctx.font = cond(23, 600);
        const w = Math.min(W - PAD * 2, ctx.measureText(it.label).width + 34);
        if (x + w > W - PAD) {
          x = PAD;
          y += 58;
        }
        x = this.button(ctx, it.id, x, y, fit(ctx, it.label, w - 26), it.onClick, { size: 23, w, h: 48, active: it.on, accent: it.accent }) + 10;
      }
      y += items.length ? 70 : 0;
    };

    if (f.paths) {
      ctx.font = sans(21);
      ctx.fillStyle = C.course;
      ctx.fillText(fit(ctx, `The navigator chose ${f.paths.length} files${f.label ? ` for “${f.label}”` : ""}. Editing replaces its choice.`, W - PAD * 2), PAD, y + 24);
      y += 46;
    }

    if (m.savedFilters.length) {
      heading("Saved views");
      const same = (a: MapFilter, b: MapFilter) => JSON.stringify({ ...EMPTY_FILTER, ...a }) === JSON.stringify({ ...EMPTY_FILTER, ...b });
      chips(
        m.savedFilters.map((v) => {
          const on = same(v.filter, f);
          return { id: `view:${v.name}`, label: v.name, on, accent: C.course, onClick: () => this.a.setMapFilter(on ? EMPTY_FILTER : { ...EMPTY_FILTER, ...v.filter }) };
        }),
      );
    }

    heading("Quick");
    chips([
      { id: "tests", label: "Hide tests", on: f.hideTests, onClick: () => this.set({ hideTests: !f.hideTests }) },
      { id: "docs", label: "Hide docs & config", on: f.hideDocs, onClick: () => this.set({ hideDocs: !f.hideDocs }) },
    ]);

    // Patterns: typed on the room's keyboard.
    const pattern = (id: "include" | "exclude", label: string, list: string[]) => {
      heading(label);
      ctx.font = mono(22);
      ctx.fillStyle = list.length ? C.text : C.muted;
      ctx.fillText(fit(ctx, list.length ? list.join(", ") : "nothing", W - PAD * 2 - 260), PAD, y + 32);
      const bx = W - PAD - 250;
      this.button(ctx, `${id}:edit`, bx, y, "Edit…", () => this.a.openKeyboard(id, undefined, list.join(", ")), { size: 22, w: 120, h: 48 });
      this.button(ctx, `${id}:clear`, bx + 130, y, "Clear", () => this.set({ [id]: [] }), { size: 22, w: 120, h: 48, disabled: !list.length });
      y += 70;
    };
    pattern("include", "Only paths matching", f.include);
    pattern("exclude", "Hide paths matching", f.exclude);

    const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
    if (m.langs.length) {
      heading("Languages · only these");
      chips(m.langs.map((l) => ({ id: `lang:${l}`, label: l, on: f.langs.includes(l), onClick: () => this.set({ langs: toggle(f.langs, l) }) })));
    }
    if (m.tops.length > 1) {
      heading("Top-level folders · only these");
      chips(m.tops.map((t) => ({ id: `top:${t.id}`, label: `${t.id} ${t.count}`, on: f.tops.includes(t.id), onClick: () => this.set({ tops: toggle(f.tops, t.id) }) })));
    }

    if (f.isolate?.length) {
      heading("Modules and folders · press to drop");
      chips(
        f.isolate.map((i) => ({
          id: `iso:${i.kind}:${i.id}`,
          label: `${i.exclude ? "not" : "only"} ${i.label}  ✕`,
          on: true,
          accent: i.exclude ? C.bad : C.course,
          onClick: () => {
            const next = f.isolate!.filter((x) => x !== i);
            this.a.setMapFilter({ ...f, isolate: next.length ? next : undefined });
          },
        })),
      );
    }

    if (f.hidden?.length) {
      heading(`Hidden files · ${f.hidden.length}`);
      this.button(ctx, "hidden:all", W - PAD - 160, y - 46, "Show all", () => this.a.setMapFilter({ ...f, hidden: [] }), { size: 21, w: 160, h: 42 });
      for (const p of f.hidden) {
        ctx.font = mono(21);
        ctx.fillStyle = C.text;
        ctx.fillText(fitPath(ctx, p, W - PAD * 2 - 140), PAD, y + 32);
        this.button(ctx, `show:${p}`, W - PAD - 110, y + 2, "Show", () => this.a.setMapFilter({ ...f, hidden: f.hidden!.filter((x) => x !== p) }), { size: 21, w: 110, h: 42 });
        y += 52;
      }
      y += 16;
    }

    ctx.font = sans(20);
    ctx.fillStyle = C.muted;
    ctx.fillText("Fling a body away (trigger, throw, let go) to hide it.", PAD, y + 24);
    y += 50;

    ctx.restore();
    this.maxScroll = Math.max(0, y + this.scrollY - bottom);
    this.scrollY = Math.min(this.scrollY, this.maxScroll);
    this.regions = [...this.regions.slice(0, before), ...this.regions.slice(before).filter((r) => r.y + r.h > top && r.y < bottom)];
    if (this.maxScroll > 0) {
      const track = bottom - top;
      const thumb = Math.max(40, (track * track) / (track + this.maxScroll));
      ctx.fillStyle = "rgba(91, 214, 255, 0.45)";
      ctx.fillRect(W - 14, top + ((track - thumb) * this.scrollY) / this.maxScroll, 6, thumb);
    }
  }
}

/** Over the dock while a focus made with the right stick is on: how wide it is, and the way to widen it. */
export class FocusBar extends Panel {
  m: Model | null = null;

  constructor(private a: Actions) {
    super("focusbar", 0.62, 0.09);
  }

  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (!p || p.focus !== m.focus) this.invalidate();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const f = this.m?.focus;
    if (!f) return;
    this.frame(ctx, C.course);
    const H = this.H;
    ctx.font = cond(28, 600);
    ctx.fillStyle = C.text;
    const ring = f.depth === 0 ? "just it" : `${f.depth} ring${f.depth > 1 ? "s" : ""} of connections`;
    ctx.fillText(fit(ctx, f.label, 330), PAD, H / 2 - 2);
    ctx.font = sans(20);
    ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, `${ring} · ${f.count} files`, 330), PAD, H / 2 + 28);
    let x = this.W - PAD - 420;
    const y = (H - 60) / 2;
    x = this.button(ctx, "less", x, y, "− Fewer", this.a.focusNarrower, { w: 130, h: 60, size: 24, disabled: f.depth === 0 }) + 10;
    x = this.button(ctx, "more", x, y, "More +", this.a.focusWider, { w: 130, h: 60, size: 24, disabled: !f.more, accent: C.course }) + 10;
    this.button(ctx, "done", x, y, "Whole map", this.a.overview, { w: 140, h: 60, size: 22 });
  }
}
