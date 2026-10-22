import type { Frame, Layer, Story } from "../../shared/types";
import { clock, liveDiagrams, storyMs, absMs, wordAt } from "../lib/story";
import type { Actions, KeyboardMode, Model } from "./model";
import { CodeView, Gap, Heading, RichText, Rows, viewBlocks, type Block, type Links } from "./blocks";
import type { Engine } from "./engine";
import { FilterPanel, FocusBar } from "./filter";
import { HintsPanel, TunePanel } from "./tune";
import { C, Panel, cond, fit, fitPath, mono, roundRect, sans, withAlpha, wrap } from "./ui";

/**
 * The panels in the room, and which of them are open. They are the
 * desktop's panels, laid out for arm's length: the file panel docks on the
 * right, answers and stories on the left, the menu in front, the keyboard low
 * like a lectern, and a small dock under your gaze that follows you round.
 */

const PAD = 34;

/* ----------------------------- scroll panel ----------------------------- */

abstract class ScrollPanel extends Panel {
  protected blocks: Block[] = [];
  protected accent?: string;
  /** Scroll to this many px into the body on the next paint. */
  protected pendingScroll: number | null = null;

  protected abstract header(ctx: CanvasRenderingContext2D): number;

  protected draw(ctx: CanvasRenderingContext2D) {
    this.frame(ctx, this.accent);
    const top = this.header(ctx);
    const bottom = this.H - 18;
    const width = this.W - PAD * 2;
    let total = 0;
    const heights = this.blocks.map((b) => {
      const h = b.measure(ctx, width);
      total += h;
      return h;
    });
    this.maxScroll = Math.max(0, total - (bottom - top) + 24);
    if (this.pendingScroll !== null) {
      this.scrollY = Math.max(0, Math.min(this.maxScroll, this.pendingScroll));
      this.pendingScroll = null;
    }
    this.scrollY = Math.min(this.scrollY, this.maxScroll);
    const before = this.regions.length;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.W, bottom - top);
    ctx.clip();
    let y = top - this.scrollY;
    this.blocks.forEach((b, i) => {
      const h = heights[i];
      if (y + h >= top && y <= bottom) b.draw(ctx, PAD, y, width, { top, bottom }, this);
      y += h;
    });
    ctx.restore();
    // What scrolled under the header can't be clicked through it.
    this.regions = [
      ...this.regions.slice(0, before),
      ...this.regions.slice(before).flatMap((r) => {
        const y0 = Math.max(r.y, top);
        const y1 = Math.min(r.y + r.h, bottom);
        return y1 > y0 ? [{ ...r, y: y0, h: y1 - y0 }] : [];
      }),
    ];
    if (this.maxScroll > 0) {
      const track = bottom - top;
      const thumb = Math.max(40, (track * track) / (track + this.maxScroll));
      const ty = top + ((track - thumb) * this.scrollY) / this.maxScroll;
      roundRect(ctx, this.W - 14, ty, 6, thumb, 3);
      ctx.fillStyle = withAlpha(C.static, 0.45);
      ctx.fill();
    }
  }

  /** Scroll so that body offset `y` is near the top. */
  scrollToBody(y: number) {
    this.pendingScroll = Math.max(0, y - 60);
    this.invalidate();
  }

  protected closeButton(ctx: CanvasRenderingContext2D, onClick: () => void) {
    this.button(ctx, "close", this.W - PAD - 58, 22, "✕", onClick, { w: 58, h: 52, size: 26 });
  }
}

/* --------------------------------- dock --------------------------------- */

/** Under your gaze: what's going on, what the voice is saying, and the way to the menu. */
export class DockPanel extends Panel {
  m: Model | null = null;
  constructor(private a: Actions) {
    super("dock", 0.8, 0.15);
  }
  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (
      !p ||
      p.status !== m.status ||
      p.busy !== m.busy ||
      p.activity !== m.activity ||
      p.voice !== m.voice ||
      p.tour !== m.tour ||
      p.toast !== m.toast ||
      p.menuOpen !== m.menuOpen ||
      p.tuneOpen !== m.tuneOpen ||
      p.hintsOpen !== m.hintsOpen ||
      p.repoName !== m.repoName ||
      p.placing !== m.placing ||
      p.visibleCount !== m.visibleCount
    )
      this.invalidate();
  }
  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m) return;
    this.frame(ctx);
    const W = this.W;
    // Left: the repo and where the map is at.
    ctx.font = cond(30, 600);
    ctx.fillStyle = C.text;
    ctx.fillText(fit(ctx, m.repoName ?? "Constellate", 300), PAD, 56);
    ctx.font = sans(21);
    const status =
      m.status === "scanning" ? "scanning…" : m.status === "analyzing" ? "charting the modules…" : m.status === "error" ? "error" : m.status === "idle" ? "no repository open" : `${m.visibleCount} files${m.filter.active ? " (filtered)" : ""}`;
    ctx.fillStyle = m.status === "error" ? C.bad : C.muted;
    ctx.fillText(fit(ctx, status, 300), PAD, 92);
    if (m.busy) {
      ctx.fillStyle = C.course;
      ctx.beginPath();
      ctx.arc(PAD + 6, 124, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Middle: the voice, a tour caption, a toast, or what the navigator is doing.
    const midX = 360;
    const midW = W - midX - 620;
    ctx.font = sans(23);
    let line = "";
    let color = C.text;
    if (m.placing) line = "Point at a table or the floor and pull the trigger to set the map down.";
    else if (m.toast) line = m.toast.text;
    else if (m.voice.heard) (line = `“${m.voice.heard}”`), (color = C.muted);
    else if (m.voice.caption) line = m.voice.caption;
    else if (m.tour) line = `Tour ${m.tour.index + 1}/${m.tour.total} · ${m.tour.label} — ${m.tour.summary}`;
    else if (m.busy && m.activity.length) (line = m.activity.at(-1)!.detail), (color = C.muted);
    else if (m.voice.error) (line = m.voice.error), (color = C.bad);
    ctx.fillStyle = color;
    const lines = wrap(ctx, line, midW).slice(-3);
    lines.forEach((l, i) => ctx.fillText(l, midX, 52 + i * 32 + (3 - lines.length) * 16));
    if (m.toast?.undo) this.button(ctx, "undo", midX + midW - 100, this.H - 64, "Undo", m.toast.undo, { size: 22, w: 100 });

    // Right: menu, tune, voice, ask, hints.
    let x = W - PAD - 596;
    const y = (this.H - 64) / 2;
    x = this.button(ctx, "menu", x, y, "Menu", this.a.toggleMenu, { w: 112, h: 64, active: m.menuOpen }) + 10;
    x = this.button(ctx, "tune", x, y, "Tune", this.a.toggleTune, { w: 104, h: 64, active: m.tuneOpen }) + 10;
    const v = m.voice.state;
    const voiceLabel = v === "listening" ? "Listening" : v === "speaking" ? "Speaking" : v === "connecting" ? "…" : "Voice";
    x = this.button(ctx, "voice", x, y, voiceLabel, this.a.toggleVoice, { w: 136, h: 64, active: v !== "idle" && v !== "error", accent: C.course, disabled: !m.voice.available }) + 10;
    x = this.button(ctx, "ask", x, y, "Ask", () => this.a.openKeyboard("ask"), { w: 96, h: 64 }) + 10;
    this.button(ctx, "hints", x, y, "?", this.a.toggleHints, { w: 64, h: 64, active: m.hintsOpen });
  }
}

/* --------------------------------- menu --------------------------------- */

type Tab = "map" | "modules" | "answers" | "stories" | "repo";

export class MenuPanel extends Panel {
  m: Model | null = null;
  tab: Tab = "map";
  constructor(private a: Actions) {
    super("menu", 0.78, 0.6);
  }
  update(m: Model) {
    const p = this.m;
    this.m = m;
    if (!p || (["layers", "lensId", "lenses", "legend", "frames", "stories", "repos", "mode", "filter", "visibleCount", "tour", "voice", "overview", "status", "frameId", "story"] as const).some((k) => p[k] !== m[k])) this.invalidate();
  }
  protected draw(ctx: CanvasRenderingContext2D) {
    const m = this.m;
    if (!m) return;
    this.frame(ctx, C.static);
    const tabs: [Tab, string][] = [
      ["map", "Map"],
      ["modules", m.legend.kind === "dir" ? "Folders" : "Modules"],
      ["answers", `Answers${m.frames.length ? ` ${m.frames.length}` : ""}`],
      ["stories", `Stories${m.stories.length ? ` ${m.stories.length}` : ""}`],
      ["repo", "Repo"],
    ];
    let x = PAD;
    for (const [t, label] of tabs) x = this.button(ctx, `tab:${t}`, x, 24, label, () => ((this.tab = t), (this.scrollY = 0), this.invalidate()), { active: this.tab === t, size: 26 }) + 10;
    this.button(ctx, "close", this.W - PAD - 58, 24, "✕", this.a.toggleMenu, { w: 58, h: 50 });
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, 92, this.W - PAD * 2, 2);
    const top = 112;
    if (this.tab === "map") this.mapTab(ctx, m, top);
    else this.listTab(ctx, m, top);
  }

  private section(ctx: CanvasRenderingContext2D, label: string, y: number) {
    ctx.font = cond(21, 600);
    ctx.fillStyle = C.muted;
    ctx.fillText(label.toUpperCase(), PAD, y);
  }

  private mapTab(ctx: CanvasRenderingContext2D, m: Model, top: number) {
    const a = this.a;
    let y = top + 16;
    this.section(ctx, "Fly", y);
    y += 14;
    let x = PAD;
    x = this.button(ctx, "overview", x, y, "Whole map", a.overview, { size: 24 }) + 10;
    x = this.button(ctx, "back", x, y, "◀ Back", a.back, { size: 24 }) + 10;
    x = this.button(ctx, "fwd", x, y, "Forward ▶", a.forward, { size: 24 }) + 10;
    x = this.button(ctx, "frame", x, y, "Frame selection", a.frameSelection, { size: 24 }) + 10;
    x = this.button(ctx, "tour", x, y, m.tour ? "Stop tour" : "Guided tour", m.tour ? a.stopTour : a.startTour, { size: 24, active: !!m.tour, accent: C.course, disabled: !m.overview?.modules.length }) + 10;

    y += 74;
    this.section(ctx, "Layers", y);
    y += 14;
    x = PAD;
    const layer = (l: Layer, label: string, accent?: string) => {
      x = this.button(ctx, `layer:${l}`, x, y, label, () => a.setLayer(l, !m.layers[l]), { size: 24, active: m.layers[l], accent }) + 10;
    };
    layer("imports", "Imports", C.static);
    layer("logical", "Runtime", C.runtime);
    layer("labels", "Labels");
    layer("folders", "Folders");
    layer("beacons", "Markers");
    layer("notes", "Notes", C.note);

    y += 74;
    this.section(ctx, "Organize", y);
    y += 14;
    x = PAD;
    const lenses = [{ id: "folders", title: "Folders" }, ...(m.overview?.modules.length ? [{ id: "modules", title: "Modules" }] : []), ...m.lenses];
    for (const l of lenses) {
      ctx.font = cond(24, 600);
      const w = Math.min(260, ctx.measureText(l.title).width + 36);
      if (x + w > this.W - PAD) break;
      x = this.button(ctx, `lens:${l.id}`, x, y, fit(ctx, l.title, 224), () => a.setLens(l.id), { size: 24, w, active: m.lensId === l.id }) + 10;
    }

    y += 74;
    this.section(ctx, `Filter · ${m.visibleCount} of ${m.totalCount} files`, y);
    y += 14;
    x = PAD;
    x = this.button(ctx, "tests", x, y, "Hide tests", () => a.setFilter({ hideTests: !m.filter.hideTests }), { size: 24, active: m.filter.hideTests }) + 10;
    x = this.button(ctx, "docs", x, y, "Hide docs & config", () => a.setFilter({ hideDocs: !m.filter.hideDocs }), { size: 24, active: m.filter.hideDocs }) + 10;
    x = this.button(ctx, "clear", x, y, "Show everything", a.clearFilter, { size: 24, disabled: !m.filter.active }) + 10;
    x = this.button(ctx, "morefilter", x, y, "More…", a.toggleFilter, { size: 24, accent: C.static }) + 10;
    if (m.filter.label) {
      ctx.font = sans(20);
      ctx.fillStyle = C.muted;
      ctx.fillText(fit(ctx, m.filter.label, this.W - x - PAD), x + 6, y + 30);
    }

    y += 74;
    this.section(ctx, "View", y);
    y += 14;
    x = PAD;
    if (m.mode !== "vr" && m.canVR) x = this.button(ctx, "vr", x, y, "Enter VR", () => a.enter("vr"), { size: 24, accent: C.course }) + 10;
    if (m.mode !== "ar" && m.canAR) x = this.button(ctx, "ar", x, y, "Passthrough (AR)", () => a.enter("ar"), { size: 24, accent: C.course }) + 10;
    if (m.mode === "ar") x = this.button(ctx, "place", x, y, "Place on a surface", a.placeMap, { size: 24, active: m.placing }) + 10;
    x = this.button(ctx, "recenter", x, y, "Recenter panels", a.recenterPanels, { size: 24 }) + 10;
    x = this.button(ctx, "tune", x, y, "Tune…", a.toggleTune, { size: 24 }) + 10;
    x = this.button(ctx, "hints", x, y, "Controls", a.toggleHints, { size: 24 }) + 10;
    if (m.mode !== "flat") x = this.button(ctx, "exit", x, y, "Exit", a.exitXR, { size: 24 }) + 10;
  }

  private listTab(ctx: CanvasRenderingContext2D, m: Model, top: number) {
    const a = this.a;
    const rowH = 66;
    type Row = { id: string; label: string; detail?: string; color?: string; active?: boolean; onClick: () => void; extra?: { label: string; onClick: () => void; active?: boolean }[] };
    let rows: Row[] = [];
    if (this.tab === "modules") {
      rows = m.legend.rows.map((r) => ({
        id: r.id,
        label: r.label,
        detail: `${r.count} files${r.isolated === "in" ? " · showing only" : r.isolated === "out" ? " · hidden" : ""}`,
        color: r.color ?? C.runtime,
        active: r.isolated === "in",
        onClick: () => a.focusModule(r.id),
        extra: [
          { label: "Only", onClick: () => a.isolate(r.id, "isolate"), active: r.isolated === "in" },
          { label: "Hide", onClick: () => a.isolate(r.id, "exclude"), active: r.isolated === "out" },
        ],
      }));
    } else if (this.tab === "answers") {
      rows = [...m.frames].reverse().map((f) => ({
        id: f.id,
        label: f.title || f.request,
        detail: f.state === "working" ? "working…" : f.state === "error" ? f.error ?? "error" : f.request,
        active: m.frameId === f.id,
        onClick: () => a.showFrame(f.id),
      }));
      if (!rows.length) rows = [{ id: "none", label: "Nothing asked yet", detail: "Ask with the dock's Ask button, the left stick click, or the voice.", onClick: () => a.openKeyboard("ask") }];
    } else if (this.tab === "stories") {
      rows = m.stories.map((s) => ({
        id: s.id,
        label: s.title,
        detail: s.state === "ready" ? `${s.summary} · ${clock(storyMs(s))}` : s.state === "error" ? s.error ?? "error" : s.progress ?? s.state,
        active: m.story?.story.id === s.id,
        color: s.intro ? C.course : C.static,
        onClick: () => s.state === "ready" && a.playStory(s.id),
      }));
      rows.push({ id: "new", label: "Write a story…", detail: "Ask for a narrated walkthrough of anything in the code.", onClick: () => a.openKeyboard("ask", "story") });
    } else {
      rows = [];
      if (m.library) {
        rows = m.repos.map((r) => ({ id: r.id, label: r.id, detail: r.headline ?? r.url, active: r.current, onClick: () => !r.current && a.openRepo(r.id) }));
        rows.push({ id: "open", label: "Open a GitHub repo…", detail: "owner/name or a link", onClick: () => a.openKeyboard("repo") });
      } else if (!m.locked) rows.push({ id: "open", label: "Open another repository…", detail: "A path on the server", onClick: () => a.openKeyboard("repo") });
      if (m.overview) rows.push({ id: "re", label: "Re-chart the modules", detail: "Read the code again; your groupings and notes are kept.", onClick: a.reanalyze });
    }
    const bottom = this.H - 18;
    const before = this.regions.length;
    this.maxScroll = Math.max(0, rows.length * rowH - (bottom - top));
    this.scrollY = Math.min(this.scrollY, this.maxScroll);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.W, bottom - top);
    ctx.clip();
    rows.forEach((r, i) => {
      const y = top + i * rowH - this.scrollY;
      if (y + rowH < top || y > bottom) return;
      const extraW = (r.extra?.length ?? 0) * 100;
      this.row(ctx, `row:${r.id}`, PAD - 8, y, this.W - PAD * 2 + 16 - extraW, rowH - 4, r.onClick, r.active);
      let tx = PAD + 4;
      if (r.color) {
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.arc(PAD + 12, y + 24, 9, 0, Math.PI * 2);
        ctx.fill();
        tx = PAD + 34;
      }
      ctx.font = cond(26, 600);
      ctx.fillStyle = C.text;
      ctx.fillText(fit(ctx, r.label, this.W - tx - PAD - extraW - 10), tx, y + 30);
      if (r.detail) {
        ctx.font = sans(19);
        ctx.fillStyle = C.muted;
        ctx.fillText(fit(ctx, r.detail, this.W - tx - PAD - extraW - 10), tx, y + 54);
      }
      r.extra?.forEach((e, k) => this.button(ctx, `x:${r.id}:${k}`, this.W - PAD - extraW + k * 100 + 6, y + 10, e.label, e.onClick, { size: 21, w: 90, h: 44, active: e.active }));
    });
    ctx.restore();
    // Rows scrolled up under the tabs can't be clicked through them.
    this.regions = [...this.regions.slice(0, before), ...this.regions.slice(before).filter((r) => r.y + r.h > top && r.y < bottom)];
  }
}

/* --------------------------------- file --------------------------------- */

export class FilePanel extends ScrollPanel {
  m: Model | null = null;
  private code: CodeView | null = null;
  private codeAt = 0;
  private key = "";
  constructor(
    private a: Actions,
    private links: Links,
  ) {
    super("file", 0.68, 0.84);
    this.resizable = true;
    this.accent = C.course;
  }
  update(m: Model) {
    const p = this.m;
    this.m = m;
    const f = m.file;
    const d = m.fileData && f && m.fileData.path === f.path ? m.fileData : null;
    const key = `${f?.path}:${f?.line}:${f?.endLine}:${!!d}`;
    if (key !== this.key) {
      this.key = key;
      this.build(m, d);
    } else if (!p || p.voice !== m.voice) this.invalidate();
  }
  private build(m: Model, d: Model["fileData"]) {
    const f = m.file;
    this.blocks = [];
    this.code = null;
    if (!f) return;
    if (!d) {
      this.blocks = [new RichText("_Loading…_", null, { color: C.muted })];
      return this.invalidate();
    }
    const row = (p: string, names?: string[], line?: number) => ({
      id: `go:${p}`,
      label: p.split("/").pop()!,
      detail: names?.length ? `${names.slice(0, 6).join(", ")}${names.length > 6 ? " …" : ""}` : p,
      onClick: () => this.a.openFile(p, line),
    });
    const imports = (d.importLinks ?? d.imports.map((p) => ({ path: p, names: [] as string[], line: undefined }))).map((l) => row(l.path, l.names, undefined));
    const importers = (d.importerLinks ?? d.importers.map((p) => ({ path: p, names: [] as string[], line: undefined }))).map((l) => row(l.path, l.names, l.line));
    if (imports.length) this.blocks.push(new Heading(`Imports ${imports.length}`, { size: 22, color: C.static }), new Rows(imports.slice(0, 12), 58));
    if (importers.length) this.blocks.push(new Heading(`Imported by ${importers.length}`, { size: 22, color: C.static }), new Rows(importers.slice(0, 12), 58));
    if (d.externals.length) this.blocks.push(new RichText(`Packages: ${d.externals.slice(0, 12).map((e) => `\`${e}\``).join(" ")}`, null, { size: 21, color: C.muted }));
    this.blocks.push(new Gap(14));
    const hl = new Set<number>();
    if (f.line) for (let n = f.line; n <= (f.endLine ?? f.line); n++) hl.add(n);
    // What comes before the code, so we can scroll to a line.
    const fake = document.createElement("canvas").getContext("2d")!;
    this.codeAt = this.blocks.reduce((h, b) => h + b.measure(fake, this.W - PAD * 2), 0);
    this.code = new CodeView(d.text, d.lang, { highlight: hl, onReady: () => this.invalidate() });
    this.blocks.push(this.code);
    this.scrollY = 0;
    if (f.line) this.scrollToBody(this.codeAt + this.code.yOf(f.line));
    this.invalidate();
  }
  protected header(ctx: CanvasRenderingContext2D) {
    const m = this.m!;
    const f = m.file!;
    const d = m.fileData;
    ctx.font = cond(36, 600);
    ctx.fillStyle = C.text;
    ctx.fillText(fit(ctx, f.path.split("/").pop()!, this.W - PAD * 2 - 80), PAD, 64);
    ctx.font = mono(19);
    ctx.fillStyle = C.muted;
    ctx.fillText(fitPath(ctx, f.path, this.W - PAD * 2 - 80), PAD, 96);
    if (d?.path === f.path) {
      ctx.font = sans(19);
      ctx.fillText(`${d.lang} · ${d.text.split("\n").length} lines${f.line ? ` · line ${f.line}${f.endLine && f.endLine !== f.line ? `–${f.endLine}` : ""}` : ""}`, PAD, 124);
    }
    this.closeButton(ctx, this.a.closeFile);
    let x = PAD;
    const y = 142;
    x = this.button(ctx, "ask", x, y, "Ask about this", () => this.a.openKeyboard("ask"), { size: 23, accent: C.course }) + 10;
    x = this.button(ctx, "frame", x, y, "Connections", this.a.frameSelection, { size: 23 }) + 10;
    x = this.button(ctx, "note", x, y, "Note", () => this.a.openKeyboard("note", f.path), { size: 23, accent: C.note }) + 10;
    x = this.button(ctx, "hide", x, y, "Hide", () => this.a.hide(f.path), { size: 23 }) + 10;
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, 206, this.W - PAD * 2, 2);
    return 220;
  }
  protected draw(ctx: CanvasRenderingContext2D) {
    if (!this.m?.file) return;
    super.draw(ctx);
  }
}

/* ------------------------------- answers ------------------------------- */

/** The dossier: the navigator's answer and the views it built — or, before anything's asked, the intro. */
export class AnswerPanel extends ScrollPanel {
  m: Model | null = null;
  private key = "";
  private answer: RichText | null = null;
  constructor(
    private a: Actions,
    private links: Links,
  ) {
    super("answer", 0.72, 0.84);
    this.resizable = true;
    this.accent = C.static;
  }
  private frame_(m: Model): Frame | undefined {
    return m.frames.find((f) => f.id === m.frameId);
  }
  update(m: Model) {
    const p = this.m;
    this.m = m;
    const f = this.frame_(m);
    const key = f ? `f:${f.id}:${f.views.length}:${JSON.stringify(m.pointer)}` : `i:${m.status}:${!!m.overview}:${m.tour?.index}`;
    if (key !== this.key) {
      this.key = key;
      this.build(m);
    } else if (f && this.answer?.set(f.answer)) this.invalidate();
    else if (!p || p.frames !== m.frames || p.status !== m.status || p.activity !== m.activity) this.invalidate();
  }
  private build(m: Model) {
    const f = this.frame_(m);
    this.blocks = [];
    this.answer = null;
    this.scrollY = 0;
    if (f) {
      this.answer = new RichText(f.answer || (f.state === "working" ? "_Reading the code…_" : ""), this.links);
      this.blocks.push(this.answer, new Gap(18));
      const ptr = m.pointer;
      for (const v of f.views) {
        const mine = !ptr?.viewId || ptr.viewId === v.id;
        this.blocks.push(
          ...viewBlocks(v, this.links, {
            highlight: mine && ptr?.lines ? new Set(ptr.lines) : undefined,
            emphasis: mine && ptr?.nodeIds ? new Set(ptr.nodeIds) : undefined,
            onReady: () => this.invalidate(),
          }),
        );
      }
    } else if (m.overview) {
      const o = m.overview;
      this.blocks.push(new RichText(o.summary, this.links), new Gap(10));
      if (o.stack.length) this.blocks.push(new RichText(o.stack.map((s) => `\`${s}\``).join("  "), null, { size: 21, color: C.muted }), new Gap(12));
      if (o.topics.length) {
        this.blocks.push(
          new Heading("Where to go", { size: 24, color: C.course }),
          new Rows(o.topics.map((t) => ({ id: `topic:${t.id}`, label: t.title, detail: t.hook, onClick: () => this.a.ask(t.title, t.id) })), 66),
        );
      }
      if (o.entryPoints.length) {
        this.blocks.push(
          new Heading("Where it starts", { size: 24, color: C.static }),
          new Rows(o.entryPoints.map((p) => ({ id: `entry:${p}`, label: p.split("/").pop()!, detail: p, onClick: () => this.a.openFile(p) })), 60),
        );
      }
    } else {
      this.blocks.push(new RichText(m.status === "analyzing" ? "The navigator is reading the code and charting its modules. The map is already yours to fly." : m.status === "scanning" ? "Scanning the repository…" : m.error ?? "", null, { color: C.muted }));
    }
    this.invalidate();
  }
  protected header(ctx: CanvasRenderingContext2D) {
    const m = this.m!;
    const f = this.frame_(m);
    const W = this.W;
    if (f) {
      ctx.font = cond(34, 600);
      ctx.fillStyle = C.text;
      ctx.fillText(fit(ctx, f.title || f.request, W - PAD * 2 - 80), PAD, 64);
      ctx.font = sans(20);
      ctx.fillStyle = C.muted;
      ctx.fillText(fit(ctx, `You asked: ${f.request}`, W - PAD * 2 - 80), PAD, 96);
      const i = m.frames.findIndex((x) => x.id === f.id);
      let x = PAD;
      const y = 116;
      x = this.button(ctx, "prev", x, y, "◀", () => this.a.showFrame(m.frames[i - 1].id), { size: 22, w: 60, disabled: i <= 0 }) + 8;
      x = this.button(ctx, "next", x, y, "▶", () => this.a.showFrame(m.frames[i + 1].id), { size: 22, w: 60, disabled: i >= m.frames.length - 1 }) + 12;
      x = this.button(ctx, "follow", x, y, "Ask a follow-up", () => this.a.openKeyboard("ask"), { size: 22, accent: C.course }) + 10;
      if (f.state === "working") {
        x = this.button(ctx, "stop", x, y, "Stop", this.a.interrupt, { size: 22 }) + 14;
        ctx.fillStyle = C.course;
        ctx.font = sans(20);
        const act = m.activity.at(-1)?.detail ?? "working…";
        ctx.fillText(fit(ctx, act, W - x - PAD), x, y + 32);
      } else if (f.state === "error") {
        ctx.fillStyle = C.bad;
        ctx.font = sans(20);
        ctx.fillText(fit(ctx, f.error ?? "Something went wrong.", W - x - PAD), x, y + 32);
      }
      this.closeButton(ctx, this.a.closeFrame);
      ctx.fillStyle = C.line;
      ctx.fillRect(PAD, 178, W - PAD * 2, 2);
      return 194;
    }
    // The intro card.
    ctx.font = cond(22, 600);
    ctx.fillStyle = C.course;
    ctx.fillText((m.repoName ?? "").toUpperCase(), PAD, 52);
    ctx.font = cond(34, 600);
    ctx.fillStyle = C.text;
    const head = m.overview?.headline ?? (m.status === "analyzing" ? "Charting…" : "Constellate");
    const hl = wrap(ctx, head, W - PAD * 2 - 80).slice(0, 2);
    hl.forEach((l, i) => ctx.fillText(l, PAD, 92 + i * 40));
    let y = 92 + hl.length * 40 - 14;
    let x = PAD;
    if (m.overview?.modules.length) x = this.button(ctx, "tour", x, y, "Take the tour", this.a.startTour, { size: 23, accent: C.course }) + 10;
    x = this.button(ctx, "ask", x, y, "Ask anything", () => this.a.openKeyboard("ask"), { size: 23 }) + 10;
    this.closeButton(ctx, this.a.closeFrame);
    y += 66;
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, y, W - PAD * 2, 2);
    return y + 16;
  }
}

/* -------------------------------- stories -------------------------------- */

export class StoryPanel extends ScrollPanel {
  m: Model | null = null;
  private key = "";
  private wordKey = "";
  constructor(
    private a: Actions,
    private links: Links,
  ) {
    super("story", 0.72, 0.8);
    this.resizable = true;
    this.accent = C.course;
  }
  update(m: Model) {
    this.m = m;
    const s = m.story;
    if (!s) return;
    const st = s.stage;
    const key = `${s.story.id}:${st.visual}:${st.lines.join(",")}:${st.emphasis.join(",")}:${JSON.stringify(st.revealed)}`;
    if (key !== this.key) {
      this.key = key;
      this.build(s.story, st);
    }
    // The caption repaints when the spoken word moves on, not every frame.
    const b = s.story.beats[s.beat];
    const w = b ? wordAt(b, s.ms) : null;
    const wk = `${s.beat}:${w?.i}:${s.playing}`;
    if (wk !== this.wordKey) {
      this.wordKey = wk;
      this.invalidate();
    }
  }
  private build(story: Story, st: NonNullable<Model["story"]>["stage"]) {
    this.blocks = [];
    const v = story.visuals.find((x) => x.id === st.visual);
    if (v)
      this.blocks.push(
        ...viewBlocks(v, this.links, {
          spotlight: st.lines.length ? new Set(st.lines) : undefined,
          highlight: st.lines.length ? new Set(st.lines) : undefined,
          emphasis: new Set(st.emphasis),
          // A diagram that builds up as it's narrated starts empty, as on the desktop.
          revealed: liveDiagrams(story).has(v.id) ? new Set(st.revealed[v.id] ?? []) : null,
          onReady: () => this.invalidate(),
        }),
      );
    else if (story.context.length)
      this.blocks.push(
        new Heading("In this story", { size: 22, color: C.static }),
        new Rows(story.context.map((c) => ({ id: `ctx:${c.path}:${c.line}`, label: c.path.split("/").pop()!, detail: c.why, onClick: () => this.a.openFile(c.path, c.line, c.endLine) })), 62),
      );
    this.invalidate();
  }
  protected header(ctx: CanvasRenderingContext2D) {
    const s = this.m!.story!;
    const story = s.story;
    const W = this.W;
    ctx.font = cond(22, 600);
    ctx.fillStyle = C.course;
    ctx.fillText(`STORY · ${s.beat + 1}/${story.beats.length} · ${clock(absMs(story, s.beat, s.ms))} / ${clock(storyMs(story))}`, PAD, 50);
    ctx.font = cond(32, 600);
    ctx.fillStyle = C.text;
    ctx.fillText(fit(ctx, story.title, W - PAD * 2 - 80), PAD, 88);
    this.closeButton(ctx, this.a.closeStory);

    // The caption, with the word being spoken lit.
    const b = story.beats[s.beat];
    let y = 128;
    if (b) {
      ctx.font = sans(26);
      const w = wordAt(b, s.ms);
      const lines = wrap(ctx, b.say, W - PAD * 2);
      let off = 0;
      for (const l of lines.slice(0, 4)) {
        const start = b.say.indexOf(l, off);
        off = start + l.length;
        if (w && w.i >= start && w.i < start + l.length) {
          const pre = l.slice(0, w.i - start);
          const word = l.slice(w.i - start, w.i - start + w.n);
          ctx.fillStyle = C.text;
          ctx.fillText(pre, PAD, y);
          const px = PAD + ctx.measureText(pre).width;
          ctx.fillStyle = C.course;
          ctx.fillText(word, px, y);
          ctx.fillStyle = C.text;
          ctx.fillText(l.slice(w.i - start + w.n), px + ctx.measureText(word).width, y);
        } else {
          ctx.fillStyle = w && start > w.i ? C.muted : C.text;
          ctx.fillText(l, PAD, y);
        }
        y += 36;
      }
    }
    y += 4;
    let x = PAD;
    x = this.button(ctx, "prev", x, y, "⏮", () => this.a.storySeek(Math.max(0, s.beat - 1)), { size: 24, w: 70 }) + 8;
    x = this.button(ctx, "play", x, y, s.playing ? "Pause" : "Play", this.a.storyToggle, { size: 24, w: 120, active: s.playing, accent: C.course }) + 8;
    x = this.button(ctx, "next", x, y, "⏭", () => this.a.storySeek(Math.min(story.beats.length - 1, s.beat + 1)), { size: 24, w: 70 }) + 12;
    x = this.button(ctx, "ask", x, y, "Ask about this", () => this.a.openKeyboard("ask"), { size: 23 }) + 10;
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, y + 68, W - PAD * 2, 2);
    return y + 82;
  }
}

/* -------------------------------- keyboard -------------------------------- */

const ROWS = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm,.?"];
const SHIFTED: Record<string, string> = { "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")", "'": '"', ",": ";", ".": ":", "?": "/" };

/**
 * There's no system keyboard inside an immersive session, so here's one: a
 * lectern of keys under your hands. As on the desktop's command bar, what you
 * type also finds files, modules and symbols to jump to.
 */
export class KeyboardPanel extends Panel {
  text = "";
  private shift = false;
  private mode: KeyboardMode = "ask";
  private target?: string;
  constructor(private a: Actions) {
    super("keyboard", 0.82, 0.44);
  }
  open_(mode: KeyboardMode, target?: string, initial?: string) {
    if (mode !== this.mode || target !== this.target) this.text = "";
    if (initial !== undefined) this.text = initial;
    this.mode = mode;
    this.target = target;
    this.invalidate();
  }
  type(s: string) {
    this.text += s;
    this.invalidate();
  }
  backspace() {
    this.text = this.text.slice(0, -1);
    this.invalidate();
  }
  submit() {
    const t = this.text.trim();
    // An empty pattern list clears it.
    if (!t && this.mode !== "include" && this.mode !== "exclude") return;
    this.a.submitKeyboard(this.target === "story" ? `story:${t}` : t);
    this.text = "";
    this.invalidate();
  }
  protected draw(ctx: CanvasRenderingContext2D) {
    this.frame(ctx, this.mode === "note" ? C.note : C.course);
    const W = this.W;
    const prompt =
      this.mode === "note"
        ? `Note on ${this.target?.split("/").pop()}`
        : this.mode === "repo"
          ? "Open a repository"
          : this.mode === "include"
            ? "Only paths matching (comma-separated: internal/**, *.go, auth)"
            : this.mode === "exclude"
              ? "Hide paths matching (comma-separated)"
              : this.target === "story"
                ? "Write a story about…"
                : "Ask the navigator, or jump to a file";
    ctx.font = cond(22, 600);
    ctx.fillStyle = C.muted;
    ctx.fillText(prompt.toUpperCase(), PAD, 44);
    this.button(ctx, "close", W - PAD - 58, 14, "✕", this.a.closeKeyboard, { w: 58, h: 46 });
    // The line you're typing.
    roundRect(ctx, PAD, 60, W - PAD * 2, 64, 12);
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fill();
    ctx.strokeStyle = withAlpha(C.static, 0.5);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = sans(28);
    ctx.fillStyle = C.text;
    const shown = fitLeft(ctx, this.text, W - PAD * 2 - 40);
    ctx.fillText(shown, PAD + 18, 102);
    ctx.fillStyle = C.course;
    ctx.fillRect(PAD + 20 + ctx.measureText(shown).width, 76, 3, 34);

    // Suggestions: places to jump to.
    let y = 134;
    const jumps = this.mode === "ask" && !this.target && this.text.trim().length >= 2 ? this.a.suggest(this.text.trim()).slice(0, 3) : [];
    let x = PAD;
    for (const j of jumps) {
      ctx.font = cond(22, 600);
      const label = `${j.kind === "module" ? "◆" : j.kind === "symbol" ? "ƒ" : "▸"} ${j.label}`;
      const w = Math.min(330, ctx.measureText(label).width + 36);
      if (x + w > W - PAD) break;
      x = this.button(ctx, `j:${j.kind}:${j.label}:${j.path}`, x, y, fit(ctx, label, w - 30), () => this.a.jump(j), { size: 22, w, h: 46 }) + 10;
    }
    y += jumps.length ? 58 : 6;

    // The keys.
    const keyW = (W - PAD * 2 - 9 * 10) / 10;
    const keyH = Math.min(64, (this.H - y - 92) / 4 - 8);
    ROWS.forEach((row, r) => {
      const off = r === 2 ? keyW * 0.25 : r === 3 ? keyW * 0.5 : 0;
      [...row].forEach((ch, i) => {
        const out = this.shift ? SHIFTED[ch] ?? ch.toUpperCase() : ch;
        this.button(ctx, `k:${r}:${i}`, PAD + off + i * (keyW + 10) - (r === 3 ? keyW * 0.5 : 0), y + r * (keyH + 8), out, () => this.press(out), { w: keyW, h: keyH, size: 28 });
      });
    });
    y += 4 * (keyH + 8);
    let bx = PAD;
    bx = this.button(ctx, "shift", bx, y, "⇧", () => ((this.shift = !this.shift), this.invalidate()), { w: keyW * 1.3, h: keyH, active: this.shift, size: 26 }) + 10;
    bx = this.button(ctx, "space", bx, y, "space", () => this.press(" "), { w: keyW * 5, h: keyH, size: 24 }) + 10;
    bx = this.button(ctx, "back", bx, y, "⌫", () => this.backspace(), { w: keyW * 1.3, h: keyH, size: 26 }) + 10;
    const go = this.mode === "note" ? "Save" : this.mode === "repo" ? "Open" : this.mode === "include" || this.mode === "exclude" ? "Apply" : "Ask";
    this.button(ctx, "enter", bx, y, go, () => this.submit(), { w: W - PAD - bx, h: keyH, size: 26, accent: C.course, active: !!this.text.trim() });
  }
  private press(s: string) {
    this.text += s;
    if (this.shift && s !== " ") this.shift = false;
    this.invalidate();
  }
}

function fitLeft(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  let s = text;
  while (s.length && ctx.measureText(s).width > maxW) s = s.slice(1);
  return s;
}

/* -------------------------------- the set -------------------------------- */

/** Every panel, and the rule for which are open: the same rules as the desktop's docking. */
export class Panels {
  readonly dock: DockPanel;
  readonly menu: MenuPanel;
  readonly file: FilePanel;
  readonly answer: AnswerPanel;
  readonly story: StoryPanel;
  readonly keyboard: KeyboardPanel;
  readonly tune: TunePanel;
  readonly hints: HintsPanel;
  readonly filter: FilterPanel;
  readonly focusBar: FocusBar;
  private lastKeyboard: Model["keyboard"] = null;

  constructor(
    private engine: Engine,
    private a: Actions,
  ) {
    const links: Links = { isFile: a.isFile, open: (p, l, e) => a.openFile(p, l, e) };
    this.dock = new DockPanel(a);
    this.menu = new MenuPanel(a);
    this.file = new FilePanel(a, links);
    this.answer = new AnswerPanel(a, links);
    this.story = new StoryPanel(a, links);
    this.keyboard = new KeyboardPanel(a);
    this.tune = new TunePanel(a);
    this.hints = new HintsPanel(a);
    this.filter = new FilterPanel(a);
    this.focusBar = new FocusBar(a);
    for (const p of [this.dock, this.menu, this.file, this.answer, this.story, this.keyboard, this.tune, this.hints, this.filter, this.focusBar]) engine.addPanel(p);
  }

  update(m: Model) {
    const e = this.engine;
    for (const p of [this.dock, this.menu, this.file, this.answer, this.story, this.tune, this.filter, this.focusBar]) p.update(m);
    e.show(this.dock, "dock");
    if (m.menuOpen) e.show(this.menu, "center");
    else e.hide(this.menu);
    if (m.tuneOpen) e.show(this.tune, "tune");
    else e.hide(this.tune);
    if (m.hintsOpen) e.show(this.hints, "hints");
    else e.hide(this.hints);
    if (m.filterOpen) e.show(this.filter, "filter");
    else e.hide(this.filter);
    if (m.focus) e.show(this.focusBar, "focusbar");
    else e.hide(this.focusBar);
    if (m.file) e.show(this.file, "right");
    else e.hide(this.file);
    // Answers and stories share the left: a story takes the stage while it plays.
    const showIntro = m.intro && (!!m.overview || m.status === "analyzing");
    if (m.story) {
      e.hide(this.answer);
      e.show(this.story, "left");
    } else {
      e.hide(this.story);
      if (m.frameId || showIntro) e.show(this.answer, "left");
      else e.hide(this.answer);
    }
    const kb = m.keyboard;
    if (kb) {
      if (!this.lastKeyboard || kb.mode !== this.lastKeyboard.mode || kb.target !== this.lastKeyboard.target) this.keyboard.open_(kb.mode, kb.target, kb.initial);
      e.show(this.keyboard, "low");
    } else e.hide(this.keyboard);
    this.lastKeyboard = kb;
  }
}
