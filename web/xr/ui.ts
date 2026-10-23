import * as THREE from "three";
import { sfx } from "./sound";

/**
 * Panels in the room. There is no DOM inside an immersive session, so every
 * panel is a canvas painted with 2D calls and shown on a plane; what can be
 * pointed at is a list of rectangles the painting registers as it goes. A ray
 * from a controller or a pinching hand lands on the plane, the hit's UV turns
 * into canvas pixels, and the panel finds the rectangle under them.
 *
 * The look follows the desktop's "navigation display": a night panel, a
 * condensed instrument face, cyan for static routes, amber for runtime,
 * magenta only for the course.
 */

export const C = {
  night: "#060b16",
  panel: "rgba(10, 17, 33, 0.94)",
  panelSolid: "#0c1426",
  panel2: "#111b31",
  line: "#1d2a45",
  text: "#e4eaf4",
  muted: "#7d89a1",
  course: "#ff4fd8",
  static: "#5bd6ff",
  runtime: "#ffb547",
  good: "#6ee7a8",
  bad: "#ff6b6b",
  note: "#ffd75e",
};

export const FONT_COND = '"Barlow Condensed", "Barlow", ui-sans-serif, sans-serif';
export const FONT_SANS = '"Barlow", ui-sans-serif, system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono", ui-monospace, monospace';
export const cond = (px: number, weight = 600) => `${weight} ${px}px ${FONT_COND}`;
export const sans = (px: number, weight = 400) => `${weight} ${px}px ${FONT_SANS}`;
export const mono = (px: number, weight = 400) => `${weight} ${px}px ${FONT_MONO}`;

export type Region = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  onClick?: () => void;
  onHold?: () => void;
  /** A slider: called with the pointer's canvas px while it's held down on (or dragged from) the region. */
  onDrag?: (x: number, y: number) => void;
  /** The end of a drag. */
  onRelease?: () => void;
};

export type PointerKind = "move" | "down" | "up" | "leave";

/** How far a press may travel (canvas px) and still count as a click rather than a scroll. */
const CLICK_SLOP = 14;

export abstract class Panel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  W: number;
  H: number;
  regions: Region[] = [];
  hover: string | null = null;
  /** The region a pointer or fingertip is pressing right now: it shows pushed in. */
  pressed: string | null = null;
  dirty = true;
  /** Body scroll, in canvas px. */
  scrollY = 0;
  maxScroll = 0;
  /** Whether both hands can stretch it (panels whose painting follows their size). */
  resizable = false;
  /** Presses in progress, per pointer: two hands can be on one panel, and one mustn't move the other's. */
  private presses = new Map<string, { y: number; x: number; scroll: number; region: Region | null; moved: boolean; drag?: boolean }>();

  constructor(
    readonly name: string,
    public widthM: number,
    public heightM: number,
    private pxPerM = 1650,
  ) {
    this.W = Math.round(widthM * pxPerM);
    this.H = Math.round(heightM * pxPerM);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = this.makeTexture();
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, heightM),
      // Never depth-tested: the engine draws a panel either over the map, or,
      // when the map stands in front of it, before the map so it covers it.
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.name = name;
    this.mesh.userData.panel = this;
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;
  }

  private makeTexture() {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }

  /** A new size in metres: a bigger canvas, so more of the code or the answer fits, not bigger letters. */
  resize(widthM: number, heightM: number) {
    this.widthM = widthM;
    this.heightM = heightM;
    this.W = Math.round(widthM * this.pxPerM);
    this.H = Math.round(heightM * this.pxPerM);
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    // A texture's size is fixed once it's on the GPU: a new one for the new canvas.
    this.texture.dispose();
    this.texture = this.makeTexture();
    this.mesh.material.map = this.texture;
    this.mesh.material.needsUpdate = true;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(widthM, heightM);
    this.invalidate();
  }

  get open() {
    return this.mesh.visible;
  }

  invalidate() {
    this.dirty = true;
  }

  /** Paint, if anything changed. Called once per frame for open panels. */
  render() {
    if (!this.dirty || !this.mesh.visible) return;
    this.dirty = false;
    this.regions = [];
    const { ctx } = this;
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.textBaseline = "alphabetic";
    this.draw(ctx);
    this.texture.needsUpdate = true;
  }

  protected abstract draw(ctx: CanvasRenderingContext2D): void;

  /** Register something that can be pointed at. Later regions win over earlier ones. */
  region(r: Region) {
    this.regions.push(r);
  }

  regionAt(x: number, y: number): Region | null {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  /** A pointer event at canvas px (x, y) from pointer `who`. Returns true if something under it is clickable. */
  pointer(kind: PointerKind, x: number, y: number, who = "main"): boolean {
    const r = this.regionAt(x, y);
    if (kind === "leave") {
      this.presses.delete(who);
      this.setPressed();
      return this.setHover(null), false;
    }
    if (kind === "down") {
      this.presses.set(who, { x, y, scroll: this.scrollY, region: r, moved: false, drag: !!r?.onDrag });
      r?.onDrag?.(x, y);
      this.setPressed();
      return !!r;
    }
    if (kind === "move") {
      const p = this.presses.get(who);
      // A slider follows the pointer anywhere on the panel until it's let go.
      if (p?.drag) {
        p.region!.onDrag!(x, y);
        return true;
      }
      if (p) {
        // Dragging the body scrolls it, the way a finger does on a page.
        if (Math.abs(y - p.y) > CLICK_SLOP || Math.abs(x - p.x) > CLICK_SLOP) {
          if (!p.moved) (p.moved = true), this.setPressed();
        }
        if (p.moved && this.maxScroll > 0) this.scrollTo(p.scroll - (y - p.y) * 1.4);
      }
      this.setHover(r?.onClick ? r.id : null);
      return !!r?.onClick;
    }
    // up
    const p = this.presses.get(who);
    this.presses.delete(who);
    this.setPressed();
    if (p?.drag) {
      p.region!.onRelease?.();
      return true;
    }
    if (p && !p.moved && r && p.region?.id === r.id && r.onClick) {
      sfx.play("tick", this.mesh.getWorldPosition(new THREE.Vector3()));
      r.onClick();
    }
    return !!r;
  }

  /** What's held down now, from the presses in progress that haven't wandered off into a scroll. */
  private setPressed() {
    const held = [...this.presses.values()].find((p) => !p.moved && p.region?.onClick && !p.drag);
    const id = held?.region?.id ?? null;
    if (id === this.pressed) return;
    this.pressed = id;
    this.dirty = true;
  }

  setHover(id: string | null) {
    if (id === this.hover) return;
    this.hover = id;
    this.dirty = true;
  }

  scrollTo(y: number) {
    const s = Math.max(0, Math.min(this.maxScroll, y));
    if (s === this.scrollY) return;
    this.scrollY = s;
    this.dirty = true;
  }

  scrollBy(dy: number) {
    this.scrollTo(this.scrollY + dy);
  }

  /* ------------------------------ painting ------------------------------ */

  protected frame(ctx: CanvasRenderingContext2D, accent?: string) {
    roundRect(ctx, 2, 2, this.W - 4, this.H - 4, 22);
    ctx.fillStyle = C.panel;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.line;
    ctx.stroke();
    if (accent) {
      ctx.fillStyle = accent;
      ctx.fillRect(24, 2, 120, 4);
    }
  }

  /** A button that lights when pointed at. Returns its right edge. */
  button(
    ctx: CanvasRenderingContext2D,
    id: string,
    x: number,
    y: number,
    label: string,
    onClick: () => void,
    o: { w?: number; h?: number; active?: boolean; accent?: string; size?: number; disabled?: boolean; icon?: string } = {},
  ) {
    const size = o.size ?? 26;
    ctx.font = cond(size, 600);
    const text = o.icon ? `${o.icon}  ${label}` : label;
    const w = o.w ?? Math.ceil(ctx.measureText(text).width + 36);
    const h = o.h ?? Math.round(size * 1.9);
    const hot = this.hover === id && !o.disabled;
    const down = this.pressed === id && !o.disabled;
    const accent = o.accent ?? C.static;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = down ? withAlpha(accent, 0.42) : o.active ? withAlpha(accent, 0.22) : hot ? "rgba(91, 214, 255, 0.16)" : C.panel2;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = o.active || down ? accent : hot ? withAlpha(C.static, 0.7) : C.line;
    ctx.stroke();
    ctx.fillStyle = o.disabled ? withAlpha(C.muted, 0.6) : o.active ? accent : C.text;
    ctx.textAlign = "center";
    ctx.fillText(text, x + w / 2, y + h / 2 + size * 0.36);
    ctx.textAlign = "left";
    if (!o.disabled) this.region({ id, x, y, w, h, onClick });
    return x + w;
  }

  /**
   * A slider from `min` to `max` across `w` px, with its value shown at the
   * right. `onChange` fires as it's dragged, `onCommit` when it's let go.
   */
  slider(
    ctx: CanvasRenderingContext2D,
    id: string,
    x: number,
    y: number,
    w: number,
    o: { value: number; min: number; max: number; step: number; changed?: boolean; onChange: (v: number) => void; onCommit: () => void },
  ) {
    const h = 44;
    const hot = this.hover === id;
    const u = (o.value - o.min) / (o.max - o.min || 1);
    const ty = y + h / 2;
    roundRect(ctx, x, ty - 5, w, 10, 5);
    ctx.fillStyle = C.panel2;
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    roundRect(ctx, x, ty - 5, Math.max(10, w * u), 10, 5);
    ctx.fillStyle = withAlpha(o.changed ? C.course : C.static, 0.75);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + w * u, ty, hot ? 17 : 14, 0, Math.PI * 2);
    ctx.fillStyle = C.text;
    ctx.fill();
    const snap = (px: number) => {
      const t = Math.max(0, Math.min(1, (px - x) / w));
      const raw = o.min + t * (o.max - o.min);
      const v = Math.round(raw / o.step) * o.step;
      o.onChange(Math.max(o.min, Math.min(o.max, +v.toFixed(6))));
    };
    // The region is taller than the track, so it's easy to catch.
    this.region({ id, x: x - 16, y, w: w + 32, h, onClick: () => {}, onDrag: (px) => snap(px), onRelease: o.onCommit });
  }

  /** An on/off switch. */
  toggle(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, on: boolean, onClick: () => void) {
    const w = 76;
    const h = 40;
    const hot = this.hover === id;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = on ? withAlpha(C.course, 0.7) : C.line;
    ctx.fill();
    if (hot) {
      ctx.strokeStyle = withAlpha(C.static, 0.8);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(on ? x + w - h / 2 : x + h / 2, y + h / 2, h / 2 - 5, 0, Math.PI * 2);
    ctx.fillStyle = C.text;
    ctx.fill();
    this.region({ id, x: x - 10, y: y - 6, w: w + 20, h: h + 12, onClick });
  }

  /** A clickable row of text: lights when pointed at. */
  row(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, w: number, h: number, onClick: () => void, active = false) {
    const hot = this.hover === id;
    if (hot || active) {
      roundRect(ctx, x, y, w, h, 10);
      ctx.fillStyle = active ? "rgba(255, 79, 216, 0.14)" : "rgba(91, 214, 255, 0.12)";
      ctx.fill();
    }
    this.region({ id, x, y, w, h, onClick });
  }
}

/* ------------------------------- helpers ------------------------------- */

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function withAlpha(color: string, a: number) {
  const c = new THREE.Color(color);
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a})`;
}

/** Text cut to a width, with an ellipsis. */
export function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** A path cut from the left, so the file name always shows. */
export function fitPath(ctx: CanvasRenderingContext2D, path: string, maxW: number) {
  if (ctx.measureText(path).width <= maxW) return path;
  let s = path;
  while (s.length > 4 && ctx.measureText("…" + s).width > maxW) s = s.slice(1);
  return "…" + s;
}

/** Greedy word wrap in the current font. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (line && ctx.measureText(next).width > maxW && w.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
        // A single word longer than the line: break it.
        while (ctx.measureText(line).width > maxW && line.length > 1) {
          let k = line.length - 1;
          while (k > 1 && ctx.measureText(line.slice(0, k)).width > maxW) k--;
          out.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * A label that floats in the room: a canvas sprite that keeps its angular size
 * whatever the distance, for hover tags and captions on the map.
 */
export class Tag {
  readonly sprite: THREE.Sprite;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private texture: THREE.CanvasTexture;
  private key = "";
  aspect = 1;

  constructor() {
    this.canvas.width = 1024;
    this.canvas.height = 256;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false, toneMapped: false }));
    this.sprite.renderOrder = 20;
    this.sprite.visible = false;
    this.sprite.center.set(0.5, 0);
  }

  /** Lines: the first in bold; colour per line optional. */
  set(lines: { text: string; color?: string; bold?: boolean; mono?: boolean }[]) {
    const key = JSON.stringify(lines);
    if (key === this.key) return;
    this.key = key;
    const { ctx, canvas } = this;
    const pad = 22;
    const lh = 40;
    const fontOf = (l: (typeof lines)[number]) => (l.mono ? mono(26) : l.bold ? cond(34, 600) : sans(27));
    let w = 0;
    for (const l of lines) {
      ctx.font = fontOf(l);
      w = Math.max(w, ctx.measureText(l.text).width);
    }
    w = Math.min(canvas.width, Math.ceil(w + pad * 2));
    const h = Math.min(canvas.height, lines.length * lh + pad * 1.4);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    roundRect(ctx, 0, canvas.height - h, w, h, 14);
    ctx.fillStyle = "rgba(6, 11, 22, 0.92)";
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 3;
    ctx.stroke();
    lines.forEach((l, i) => {
      ctx.font = fontOf(l);
      ctx.fillStyle = l.color ?? (i === 0 ? C.text : C.muted);
      ctx.fillText(fit(ctx, l.text, canvas.width - pad * 2), pad, canvas.height - h + pad + 22 + i * lh);
    });
    this.texture.needsUpdate = true;
    // The sprite shows the whole canvas; what's drawn sits at its bottom left.
    this.aspect = canvas.width / canvas.height;
    this.sprite.center.set(w / 2 / canvas.width, 0);
  }

  /** Place it at `at` (world), sized to `angle` radians of canvas height as seen from `eye`. */
  place(at: THREE.Vector3, eye: THREE.Vector3, angle = 0.05) {
    const d = at.distanceTo(eye);
    const h = d * angle;
    this.sprite.position.copy(at);
    this.sprite.scale.set(h * this.aspect, h, 1);
  }
}
