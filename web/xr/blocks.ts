import dagre from "@dagrejs/dagre";
import { codeToTokens, type BundledLanguage } from "shiki";
import type { DiagramEdge, DiagramNode, View } from "../../shared/types";
import { parseDiff } from "../components/DiffView";
import { C, Panel, cond, fit, fitPath, mono, roundRect, sans, withAlpha, wrap } from "./ui";

/**
 * What goes on a scrolling panel: blocks that measure themselves for a width
 * and paint themselves at a y. Only the blocks (and, in code, only the lines)
 * inside the visible window are painted, so a 3,000-line file scrolls as
 * cheaply as a short one.
 */

export type Clip = { top: number; bottom: number };

export interface Block {
  measure(ctx: CanvasRenderingContext2D, width: number): number;
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, clip: Clip, panel: Panel): void;
}

/** Callbacks a block may need: files named in the text open on the map. */
export type Links = { isFile: (p: string) => boolean; open: (path: string, line?: number, endLine?: number) => void };

/* ------------------------------ rich text ------------------------------ */

type Seg = { text: string; font: string; color: string; x: number; w: number; link?: { path: string; line?: number }; bg?: string };
type Line = { segs: Seg[]; h: number; base: number; bullet?: boolean; indent: number; fence?: boolean };

const BODY = 25;

/**
 * Markdown, as much of it as the navigator writes: headings, bullets,
 * numbered lists, fenced code, bold, inline code and links. Inline code that
 * names a file on the map becomes a link that flies there.
 */
export class RichText implements Block {
  private lines: Line[] = [];
  private width = -1;
  constructor(
    private md: string,
    private links: Links | null,
    private o: { size?: number; color?: string } = {},
  ) {}

  set(md: string) {
    if (md === this.md) return false;
    this.md = md;
    this.width = -1;
    return true;
  }

  measure(ctx: CanvasRenderingContext2D, width: number) {
    if (width !== this.width) this.layout(ctx, width);
    return this.lines.reduce((h, l) => h + l.h, 0);
  }

  private layout(ctx: CanvasRenderingContext2D, width: number) {
    this.width = width;
    const size = this.o.size ?? BODY;
    const out: Line[] = [];
    let fence = false;
    for (const raw of this.md.replace(/\r/g, "").split("\n")) {
      if (/^\s*```/.test(raw)) {
        fence = !fence;
        out.push({ segs: [], h: 8, base: 0, indent: 0 });
        continue;
      }
      if (fence) {
        ctx.font = mono(size - 4);
        const t = fit(ctx, raw.replace(/\t/g, "  "), width - 24);
        out.push({ segs: [{ text: t, font: mono(size - 4), color: "#c0caf5", x: 12, w: 0 }], h: size * 1.35, base: size, indent: 0, fence: true });
        continue;
      }
      if (!raw.trim()) {
        out.push({ segs: [], h: size * 0.55, base: 0, indent: 0 });
        continue;
      }
      const h = raw.match(/^(#{1,4})\s+(.*)$/);
      const li = raw.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
      const quote = raw.match(/^>\s?(.*)$/);
      let text = raw;
      let fsize = size;
      let weight = 400;
      let face: "sans" | "cond" = "sans";
      let indent = 0;
      let bullet = false;
      let color = this.o.color ?? C.text;
      if (h) {
        text = h[2];
        fsize = size + (h[1].length <= 2 ? 9 : 4);
        face = "cond";
        weight = 600;
        out.push({ segs: [], h: size * 0.35, base: 0, indent: 0 });
      } else if (li) {
        text = (/\d/.test(li[2]) ? `${li[2]} ` : "") + li[3];
        indent = 28 + Math.min(2, Math.floor(li[1].length / 2)) * 24;
        bullet = !/\d/.test(li[2]);
      } else if (quote) {
        text = quote[1];
        indent = 24;
        color = C.muted;
      }
      out.push(...this.wrapInline(ctx, text, width - indent, indent, { size: fsize, weight, face, color, bullet }));
    }
    this.lines = out;
  }

  private wrapInline(
    ctx: CanvasRenderingContext2D,
    text: string,
    width: number,
    indent: number,
    s: { size: number; weight: number; face: "sans" | "cond"; color: string; bullet: boolean },
  ): Line[] {
    // Tokens: `code`, **bold**, [text](target), plain words.
    const toks: { text: string; kind: "plain" | "code" | "bold" | "link"; target?: string }[] = [];
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
    let last = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
      if (m.index > last) toks.push({ text: text.slice(last, m.index), kind: "plain" });
      if (m[1] !== undefined) toks.push({ text: m[1], kind: "code" });
      else if (m[2] !== undefined) toks.push({ text: m[2], kind: "bold" });
      else toks.push({ text: m[3], kind: "link", target: m[4] });
      last = m.index + m[0].length;
    }
    if (last < text.length) toks.push({ text: text.slice(last), kind: "plain" });

    const fontFor = (kind: string) =>
      kind === "code" ? mono(s.size - 3) : s.face === "cond" ? cond(s.size, s.weight) : sans(s.size, kind === "bold" ? 600 : s.weight);
    const lines: Line[] = [];
    let cur: Seg[] = [];
    let x = indent;
    const lh = s.size * 1.42;
    const flush = () => {
      lines.push({ segs: cur, h: lh, base: s.size * 1.05, indent, bullet: s.bullet && lines.length === 0 });
      cur = [];
      x = indent;
    };
    for (const t of toks) {
      const font = fontFor(t.kind);
      ctx.font = font;
      const link = this.linkFor(t);
      const color = link ? C.static : t.kind === "code" ? "#9ecbff" : t.kind === "bold" ? "#ffffff" : s.color;
      // Code spans and links don't break inside; words do.
      const parts = t.kind === "plain" || t.kind === "bold" ? t.text.split(/(\s+)/) : [t.text];
      for (const p of parts) {
        if (!p) continue;
        let w = ctx.measureText(p).width;
        if (x + w > indent + width && x > indent && p.trim()) flush();
        if (x === indent && !p.trim()) continue;
        let piece = p;
        if (w > width) {
          piece = fit(ctx, p, width);
          w = ctx.measureText(piece).width;
        }
        cur.push({ text: piece, font, color, x, w, link, bg: t.kind === "code" ? "rgba(91, 214, 255, 0.08)" : undefined });
        x += w;
      }
    }
    flush();
    return lines;
  }

  private linkFor(t: { text: string; kind: string; target?: string }) {
    if (!this.links) return undefined;
    const raw = t.kind === "link" ? t.target! : t.kind === "code" ? t.text : null;
    if (!raw) return undefined;
    const m = raw.replace(/^\.?\//, "").match(/^([^:#\s]+?)(?::(\d+)(?:-\d+)?|#L(\d+))?$/);
    if (!m || !this.links.isFile(m[1])) return undefined;
    return { path: m[1], line: Number(m[2] ?? m[3]) || undefined };
  }

  draw(ctx: CanvasRenderingContext2D, x0: number, y0: number, width: number, clip: Clip, panel: Panel) {
    this.measure(ctx, width);
    let y = y0;
    this.lines.forEach((l, i) => {
      if (y + l.h >= clip.top && y <= clip.bottom) {
        if (l.fence) {
          ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
          ctx.fillRect(x0, y, width, l.h);
        }
        if (l.bullet) {
          ctx.fillStyle = C.course;
          ctx.beginPath();
          ctx.arc(x0 + l.indent - 14, y + l.base - (BODY * 0.33), 4, 0, Math.PI * 2);
          ctx.fill();
        }
        for (const s of l.segs) {
          if (s.bg) {
            ctx.fillStyle = s.bg;
            ctx.fillRect(x0 + s.x - 2, y + 4, s.w + 4, l.h - 6);
          }
          ctx.font = s.font;
          const id = s.link ? `link:${i}:${s.x}` : "";
          ctx.fillStyle = s.link && panel.hover === id ? "#ffffff" : s.color;
          ctx.fillText(s.text, x0 + s.x, y + l.base);
          if (s.link) {
            ctx.fillRect(x0 + s.x, y + l.base + 4, s.w, 2);
            const link = s.link;
            panel.region({ id, x: x0 + s.x, y, w: s.w, h: l.h, onClick: () => this.links!.open(link.path, link.line) });
          }
        }
      }
      y += l.h;
    });
  }
}

/* --------------------------------- code --------------------------------- */

type Tok = { content: string; color?: string };

/** Scanner language ids -> shiki grammar ids, where they differ (as on the desktop). */
const GRAMMAR: Record<string, string> = { docker: "dockerfile", make: "makefile" };
const LARGE = 4000;
const tokenCache = new Map<string, Promise<Tok[][] | null>>();

function tokenize(code: string, lang: string): Promise<Tok[][] | null> {
  const key = `${lang}\0${code}`;
  let p = tokenCache.get(key);
  if (!p) {
    if (code.split("\n").length > LARGE) p = Promise.resolve(null);
    else {
      const run = (l: string) => codeToTokens(code, { lang: l as BundledLanguage, theme: "tokyo-night" }).then((r) => r.tokens as Tok[][]);
      p = run(GRAMMAR[lang] ?? lang).catch(() => run("text").catch(() => null));
    }
    tokenCache.set(key, p);
    if (tokenCache.size > 40) tokenCache.delete(tokenCache.keys().next().value!);
  }
  return p;
}

export class CodeView implements Block {
  readonly lines: string[];
  private tokens: Tok[][] | null = null;
  lineH = 30;
  private font = mono(20);
  constructor(
    code: string,
    lang: string,
    private o: { startLine?: number; highlight?: Set<number>; annotations?: Map<number, string>; spotlight?: Set<number>; onReady?: () => void } = {},
  ) {
    this.lines = code.replace(/\r/g, "").split("\n");
    void tokenize(code, lang).then((t) => {
      this.tokens = t;
      o.onReady?.();
    });
  }

  setHighlight(h: Set<number>) {
    this.o.highlight = h;
  }

  /** The y (relative to the block's top) of a line number. */
  yOf(line: number) {
    return Math.max(0, line - (this.o.startLine ?? 1)) * this.lineH;
  }

  measure() {
    return this.lines.length * this.lineH + (this.o.annotations?.size ?? 0) * this.lineH + 8;
  }

  draw(ctx: CanvasRenderingContext2D, x0: number, y0: number, width: number, clip: Clip) {
    const start = this.o.startLine ?? 1;
    const gutter = 74;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, Math.max(y0, clip.top), width, clip.bottom - Math.max(y0, clip.top));
    ctx.clip();
    ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
    ctx.fillRect(x0, y0, width, this.measure());
    let y = y0 + 4;
    const spot = this.o.spotlight;
    for (let i = 0; i < this.lines.length; i++) {
      const n = start + i;
      const note = this.o.annotations?.get(n);
      const h = this.lineH * (note ? 2 : 1);
      if (y + h >= clip.top && y <= clip.bottom) {
        const lit = this.o.highlight?.has(n);
        const dim = spot && spot.size > 0 && !spot.has(n);
        if (lit) {
          ctx.fillStyle = "rgba(255, 79, 216, 0.16)";
          ctx.fillRect(x0, y, width, this.lineH);
          ctx.fillStyle = C.course;
          ctx.fillRect(x0, y, 4, this.lineH);
        }
        ctx.globalAlpha = dim ? 0.35 : 1;
        ctx.font = this.font;
        ctx.fillStyle = lit ? C.course : "#3b4a6b";
        ctx.textAlign = "right";
        ctx.fillText(String(n), x0 + gutter - 16, y + 22);
        ctx.textAlign = "left";
        let x = x0 + gutter;
        const toks = this.tokens?.[i] ?? [{ content: this.lines[i] }];
        for (const t of toks) {
          const s = t.content.replace(/\t/g, "    ");
          if (x > x0 + width) break;
          ctx.fillStyle = t.color ?? "#a9b1d6";
          ctx.fillText(s, x, y + 22);
          x += ctx.measureText(s).width;
        }
        ctx.globalAlpha = 1;
        if (note) {
          ctx.font = sans(20, 500);
          ctx.fillStyle = C.runtime;
          ctx.fillText(fit(ctx, `↳ ${note}`, width - gutter - 10), x0 + gutter, y + this.lineH + 22);
        }
      }
      y += h;
      if (y > clip.bottom) break;
    }
    ctx.restore();
  }
}

/* -------------------------------- diffs -------------------------------- */

/**
 * A unified diff as the desktop's DiffView draws it: the change in diff
 * colours, both line numbers, and the code still syntax-highlighted.
 */
export class DiffBlock implements Block {
  private rows: ReturnType<typeof parseDiff>["rows"];
  private tokens: Tok[][] | null = null;
  private lineH = 30;
  constructor(diff: string, lang = "text", onReady?: () => void) {
    this.rows = parseDiff(diff).rows;
    // Every changed and context line as one block: hunks are pieces of the same file, so the grammar mostly stays in step.
    const code = this.rows.filter((r) => r.kind !== "hunk").map((r) => r.text);
    void tokenize(code.join("\n"), lang).then((t) => {
      this.tokens = t;
      onReady?.();
    });
  }
  measure() {
    return this.rows.length * this.lineH + 8;
  }
  draw(ctx: CanvasRenderingContext2D, x0: number, y0: number, width: number, clip: Clip) {
    const gutter = 128;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, Math.max(y0, clip.top), width, clip.bottom - Math.max(y0, clip.top));
    ctx.clip();
    ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
    ctx.fillRect(x0, y0, width, this.measure());
    ctx.font = mono(20);
    let y = y0 + 4;
    let i = 0;
    for (const r of this.rows) {
      const visible = y + this.lineH >= clip.top && y <= clip.bottom;
      if (r.kind === "hunk") {
        if (visible) {
          ctx.fillStyle = withAlpha(C.static, 0.1);
          ctx.fillRect(x0, y, width, this.lineH);
          ctx.fillStyle = C.muted;
          ctx.fillText(fit(ctx, r.text || "…", width - 20), x0 + 10, y + 22);
        }
        y += this.lineH;
        continue;
      }
      const toks = this.tokens?.[i];
      i++;
      if (visible) {
        const add = r.kind === "add";
        const del = r.kind === "del";
        if (add || del) {
          ctx.fillStyle = add ? "rgba(110, 231, 168, 0.12)" : "rgba(255, 107, 107, 0.13)";
          ctx.fillRect(x0, y, width, this.lineH);
          ctx.fillStyle = add ? C.good : C.bad;
          ctx.fillRect(x0, y, 4, this.lineH);
        }
        ctx.fillStyle = "#3b4a6b";
        ctx.textAlign = "right";
        ctx.fillText(r.old !== undefined ? String(r.old) : "", x0 + 52, y + 22);
        ctx.fillText(r.neu !== undefined ? String(r.neu) : "", x0 + 102, y + 22);
        ctx.textAlign = "left";
        ctx.fillStyle = add ? C.good : del ? C.bad : "#3b4a6b";
        ctx.fillText(add ? "+" : del ? "−" : "", x0 + 110, y + 22);
        ctx.globalAlpha = del ? 0.75 : 1;
        let x = x0 + gutter;
        for (const t of toks ?? [{ content: r.text }]) {
          if (x > x0 + width) break;
          const text = t.content.replace(/\t/g, "    ");
          ctx.fillStyle = t.color ?? "#a9b1d6";
          ctx.fillText(text, x, y + 22);
          x += ctx.measureText(text).width;
        }
        ctx.globalAlpha = 1;
      }
      y += this.lineH;
      if (y > clip.bottom) break;
    }
    ctx.restore();
  }
}

/* ------------------------------- diagrams ------------------------------- */

/**
 * The navigator's box-and-arrow diagrams, laid out by dagre as on the
 * desktop. Boxes that stand for a file fly there when pointed at and clicked.
 */
export class DiagramBlock implements Block {
  private laid: { nodes: (DiagramNode & { x: number; y: number; w: number; h: number })[]; edges: { e: DiagramEdge; pts: { x: number; y: number }[] }[]; w: number; h: number } | null = null;
  private scale = 1;
  emphasis = new Set<string>();
  /** Diagrams that build up as a story is told: only these nodes are drawn. */
  revealed: Set<string> | null = null;

  constructor(
    private view: Extract<View, { kind: "diagram" }>,
    private links: Links | null,
  ) {}

  private layout(ctx: CanvasRenderingContext2D, rankdir: "LR" | "TB") {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir, nodesep: 34, ranksep: 54, marginx: 10, marginy: 10 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of this.view.nodes) {
      ctx.font = cond(26, 600);
      const lw = ctx.measureText(n.label).width;
      ctx.font = sans(19);
      const dw = n.detail ? Math.min(300, ctx.measureText(n.detail).width) : 0;
      g.setNode(n.id, { width: Math.max(lw, dw) + 40, height: n.detail ? 74 : 50 });
    }
    for (const e of this.view.edges) if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
    dagre.layout(g);
    const nodes = this.view.nodes.map((n) => {
      const d = g.node(n.id) as { x: number; y: number; width: number; height: number };
      return { ...n, x: d.x - d.width / 2, y: d.y - d.height / 2, w: d.width, h: d.height };
    });
    const edges = this.view.edges
      .filter((e) => g.hasEdge(e.from, e.to))
      .map((e) => ({ e, pts: ((g.edge(e.from, e.to) as { points?: { x: number; y: number }[] }).points ?? []) }));
    const gg = g.graph() as { width?: number; height?: number };
    this.laid = { nodes, edges, w: gg.width ?? 100, h: gg.height ?? 100 };
  }

  measure(ctx: CanvasRenderingContext2D, width: number) {
    if (!this.laid) {
      this.layout(ctx, this.view.dir === "LR" ? "LR" : "TB");
      // A long left-to-right chain would shrink past reading on a panel; it reads top to bottom instead.
      if (this.view.dir === "LR" && this.laid!.w > width * 1.15) this.layout(ctx, "TB");
    }
    this.scale = Math.min(1, width / this.laid!.w);
    return this.laid!.h * this.scale + 16;
  }

  draw(ctx: CanvasRenderingContext2D, x0: number, y0: number, width: number, _clip: Clip, panel: Panel) {
    const h = this.measure(ctx, width);
    const L = this.laid!;
    const s = this.scale;
    const ox = x0 + (width - L.w * s) / 2;
    const oy = y0 + 8;
    ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
    roundRect(ctx, x0, y0, width, h, 12);
    ctx.fill();
    const shown = (id: string) => !this.revealed || this.revealed.has(id);
    const lit = (id: string) => this.emphasis.size === 0 || this.emphasis.has(id);
    const runtime = this.view.layer === "logical";
    const edgeColor = runtime ? C.runtime : C.static;
    for (const { e, pts } of L.edges) {
      if (!shown(e.from) || !shown(e.to) || pts.length < 2) continue;
      ctx.strokeStyle = withAlpha(edgeColor, lit(e.from) && lit(e.to) ? 0.85 : 0.2);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * s, oy + p.y * s) : ctx.moveTo(ox + p.x * s, oy + p.y * s)));
      ctx.stroke();
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const bx = ox + b.x * s;
      const by = oy + b.y * s;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - 12 * Math.cos(ang - 0.4), by - 12 * Math.sin(ang - 0.4));
      ctx.lineTo(bx - 12 * Math.cos(ang + 0.4), by - 12 * Math.sin(ang + 0.4));
      ctx.fill();
      if (e.label) {
        ctx.font = sans(17);
        const mid = pts[Math.floor(pts.length / 2)];
        ctx.fillStyle = C.muted;
        ctx.textAlign = "center";
        ctx.fillText(fit(ctx, e.label, 180), ox + mid.x * s, oy + mid.y * s - 6);
        ctx.textAlign = "left";
      }
    }
    for (const n of L.nodes) {
      if (!shown(n.id)) continue;
      const x = ox + n.x * s;
      const y = oy + n.y * s;
      const id = `node:${n.id}`;
      const hot = panel.hover === id;
      ctx.globalAlpha = lit(n.id) ? 1 : 0.3;
      roundRect(ctx, x, y, n.w * s, n.h * s, 10);
      ctx.fillStyle = this.emphasis.has(n.id) ? "rgba(255, 79, 216, 0.18)" : hot ? "rgba(91, 214, 255, 0.18)" : C.panel2;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = this.emphasis.has(n.id) ? C.course : n.path ? withAlpha(C.static, 0.6) : C.line;
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.font = cond(26 * s, 600);
      ctx.textAlign = "center";
      ctx.fillText(fit(ctx, n.label, n.w * s - 12), x + (n.w * s) / 2, y + (n.detail ? 32 : 33) * s);
      if (n.detail) {
        ctx.font = sans(19 * s);
        ctx.fillStyle = C.muted;
        ctx.fillText(fit(ctx, n.detail, n.w * s - 12), x + (n.w * s) / 2, y + 58 * s);
      }
      ctx.textAlign = "left";
      ctx.globalAlpha = 1;
      if (n.path && this.links) {
        const path = n.path;
        panel.region({ id, x, y, w: n.w * s, h: n.h * s, onClick: () => this.links!.open(path) });
      }
    }
  }
}

/* ------------------------------ small ones ------------------------------ */

export class Gap implements Block {
  constructor(private h: number) {}
  measure() {
    return this.h;
  }
  draw() {}
}

/** A heading line inside a scrolling body, with an optional action at its right. */
export class Heading implements Block {
  constructor(
    private text: string,
    private o: { color?: string; size?: number; action?: { id: string; label: string; onClick: () => void } } = {},
  ) {}
  measure() {
    return (this.o.size ?? 28) * 1.7;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, _c: Clip, panel: Panel) {
    const size = this.o.size ?? 28;
    ctx.font = cond(size, 600);
    ctx.fillStyle = this.o.color ?? C.text;
    const aw = this.o.action ? 200 : 0;
    ctx.fillText(fit(ctx, this.text, width - aw), x, y + size * 1.15);
    if (this.o.action) {
      const a = this.o.action;
      ctx.font = cond(22, 600);
      const w = ctx.measureText(a.label).width + 28;
      panel.button(ctx, a.id, x + width - w, y + 2, a.label, a.onClick, { size: 22, w });
    }
  }
}

/** A list of clickable rows: a label and a muted detail line. */
export class Rows implements Block {
  constructor(
    /** `path`: the label is a file path, cut from the left so the name shows, its folder dimmed. */
    private rows: { id: string; label: string; detail?: string; color?: string; active?: boolean; path?: boolean; onClick: () => void }[],
    private rowH = 64,
  ) {}
  measure() {
    return this.rows.length * this.rowH;
  }
  draw(ctx: CanvasRenderingContext2D, x: number, y0: number, width: number, clip: Clip, panel: Panel) {
    this.rows.forEach((r, i) => {
      const y = y0 + i * this.rowH;
      if (y + this.rowH < clip.top || y > clip.bottom) return;
      panel.row(ctx, r.id, x - 8, y + 2, width + 16, this.rowH - 4, r.onClick, r.active);
      if (r.color) {
        ctx.fillStyle = r.color;
        ctx.beginPath();
        ctx.arc(x + 10, y + this.rowH / 2 - (r.detail ? 8 : 0), 8, 0, Math.PI * 2);
        ctx.fill();
      }
      const tx = x + (r.color ? 30 : 4);
      ctx.font = cond(26, 600);
      ctx.fillStyle = C.text;
      const ty = y + (r.detail ? 28 : this.rowH / 2 + 9);
      if (r.path) {
        const shown = fitPath(ctx, r.label, width - (tx - x) - 8);
        const cut = shown.lastIndexOf("/") + 1;
        ctx.fillStyle = C.muted;
        ctx.fillText(shown.slice(0, cut), tx, ty);
        ctx.fillStyle = C.text;
        ctx.fillText(shown.slice(cut), tx + ctx.measureText(shown.slice(0, cut)).width, ty);
      } else ctx.fillText(fit(ctx, r.label, width - (tx - x) - 8), tx, ty);
      if (r.detail) {
        ctx.font = sans(19);
        ctx.fillStyle = C.muted;
        ctx.fillText(fit(ctx, r.detail, width - (tx - x) - 8), tx, y + 52);
      }
    });
  }
}

/** One of the navigator's views, as blocks: the same views the desktop dossier shows. */
export function viewBlocks(v: View, links: Links | null, o: { highlight?: Set<number>; spotlight?: Set<number>; emphasis?: Set<string>; revealed?: Set<string> | null; onReady?: () => void } = {}): Block[] {
  const out: Block[] = [];
  const title = "title" in v && v.title ? v.title : v.kind === "code" || v.kind === "diff" ? v.path : "";
  if (title) {
    const action =
      (v.kind === "code" || v.kind === "diff") && links
        ? { id: `open:${v.id}`, label: "Open on map", onClick: () => links.open(v.path, v.kind === "code" ? v.startLine : undefined, v.kind === "code" ? v.startLine + v.code.split("\n").length - 1 : undefined) }
        : undefined;
    out.push(new Heading(title, { size: 24, color: C.static, action }));
  }
  switch (v.kind) {
    case "text":
      out.push(new RichText(v.markdown, links));
      break;
    case "code": {
      if (v.note) out.push(new RichText(v.note, links, { size: 22, color: C.muted }));
      const hl = new Set([...v.highlight, ...(o.highlight ?? [])]);
      out.push(new CodeView(v.code, v.lang, { startLine: v.startLine, highlight: hl, spotlight: o.spotlight, annotations: new Map(v.annotations.map((a) => [a.line, a.text])), onReady: o.onReady }));
      break;
    }
    case "diagram": {
      const d = new DiagramBlock(v, links);
      d.emphasis = o.emphasis ?? new Set();
      d.revealed = o.revealed ?? null;
      out.push(d);
      break;
    }
    case "diff":
      if (v.note) out.push(new RichText(v.note, links, { size: 22, color: C.muted }));
      out.push(new DiffBlock(v.diff, v.lang, o.onReady));
      break;
    case "custom":
      out.push(new RichText("_An interactive view — open the desktop map to run it._", null, { size: 22, color: C.muted }));
      break;
  }
  out.push(new Gap(22));
  return out;
}

/** Plain wrapped text of fixed style, for short captions. */
export function drawWrapped(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines = 99) {
  const lines = wrap(ctx, text, maxW);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = fit(ctx, shown[maxLines - 1] + " …", maxW);
  shown.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
  return shown.length * lh;
}
