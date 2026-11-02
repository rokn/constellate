import * as THREE from "three";
import { ARCH_KINDS, COLORS, STATUSES, colorOf, nameOf, type Board, type Item, type ItemKind } from "../../shared/board";
import { Panel, cond, roundRect, sans, withAlpha } from "../xr/ui";
import type { Ctl, Tool } from "./ctl";
import { LOOK, STATUS_COLOR } from "./look";

/**
 * The headset's panels, painted on canvases: the toolbelt (tools and every
 * component), the inspector for what's selected, and a strip under your
 * gaze with what the voice is saying and what the builder is doing.
 * Holographic glass, cyan edges and corner brackets, to match the board.
 */

const GLASS = "rgba(3, 16, 28, 0.78)";
const EDGE = "rgba(95, 212, 255, 0.85)";

function glass(p: Panel, ctx: CanvasRenderingContext2D, title?: string) {
  const { W, H } = p;
  roundRect(ctx, 3, 3, W - 6, H - 6, 18);
  ctx.fillStyle = GLASS;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = withAlpha(LOOK.cyan, 0.35);
  ctx.stroke();
  ctx.strokeStyle = EDGE;
  ctx.lineWidth = 5;
  const k = 34;
  for (const [x, y, dx, dy] of [
    [6, 6, 1, 1],
    [W - 6, 6, -1, 1],
    [6, H - 6, 1, -1],
    [W - 6, H - 6, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * k);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * k, y);
    ctx.stroke();
  }
  if (title) {
    ctx.font = cond(30, 600);
    ctx.letterSpacing = "6px";
    ctx.fillStyle = LOOK.cyan;
    ctx.fillText(title.toUpperCase(), 36, 58);
    ctx.letterSpacing = "0px";
  }
}

function section(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.font = cond(22, 600);
  ctx.letterSpacing = "4px";
  ctx.fillStyle = LOOK.muted;
  ctx.fillText(text.toUpperCase(), x, y);
  ctx.letterSpacing = "0px";
}

const KIND_LABEL: Partial<Record<ItemKind, string>> = { function: "Lambda" };
const label = (k: ItemKind) => KIND_LABEL[k] ?? k[0].toUpperCase() + k.slice(1);

/** Tools, components and the board's own buttons. */
export class Toolbelt extends Panel {
  constructor(private ctl: Ctl, private on: { spawn: (k: ItemKind) => void; reset: () => void; exit: () => void; close: () => void }) {
    super("toolbelt", 0.46, 0.4, 1700);
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    glass(this, ctx, "Workshop");
    const ctl = this.ctl;
    const tool = ctl.tool();
    let x = 36;
    let y = 86;
    section(ctx, "Tools", x, y);
    y += 14;
    for (const t of ["select", "connect", "ink"] as Tool[]) {
      x = this.button(ctx, `tool:${t}`, x, y, t[0].toUpperCase() + t.slice(1), () => ctl.setTool(t), { active: tool === t, accent: LOOK.accent, w: 150 }) + 12;
    }
    const v = ctl.voiceState();
    this.button(ctx, "voice", this.W - 36 - 190, y, v === "idle" || v === "error" ? "Voice off" : v === "connecting" ? "Voice…" : "Voice on", () => ctl.toggleVoice(), { active: v !== "idle" && v !== "error", accent: LOOK.cyan, w: 190 });

    y += 86;
    section(ctx, "Architecture", 36, y);
    y += 14;
    x = 36;
    const cols = 4;
    const w = (this.W - 72 - (cols - 1) * 12) / cols;
    ARCH_KINDS.forEach((k, i) => {
      const cx = 36 + (i % cols) * (w + 12);
      const cy = y + Math.floor(i / cols) * 62;
      this.button(ctx, `add:${k}`, cx, cy, label(k), () => this.on.spawn(k), { w, h: 50, size: 24 });
    });
    y += Math.ceil(ARCH_KINDS.length / cols) * 62 + 22;
    section(ctx, "Board", 36, y);
    y += 14;
    (["note", "text", "frame", "holo"] as ItemKind[]).forEach((k, i) => {
      this.button(ctx, `add:${k}`, 36 + i * (w + 12), y, k === "holo" ? "Hologram" : label(k), () => this.on.spawn(k), { w, h: 50, size: 24, accent: LOOK.accent });
    });
    y += 74;
    x = 36;
    x = this.button(ctx, "undo", x, y, "Undo", () => ctl.client.undo(), { w: 120, h: 50, size: 24 }) + 12;
    x = this.button(ctx, "redo", x, y, "Redo", () => ctl.client.redo(), { w: 120, h: 50, size: 24 }) + 12;
    x = this.button(ctx, "reset", x, y, "Reset table", () => this.on.reset(), { w: 170, h: 50, size: 24 }) + 12;
    this.button(ctx, "exit", this.W - 36 - 120, y, "Exit", () => this.on.exit(), { w: 120, h: 50, size: 24, accent: LOOK.danger });
  }
}

/** The selected item: its colour, status, size, and for a hologram how far apart it's pulled. */
export class Inspector extends Panel {
  item: Item | null = null;
  count = 0;

  constructor(private ctl: Ctl) {
    super("inspector", 0.4, 0.3, 1700);
  }

  set(b: Board | null, sel: string[]) {
    const it = sel.length === 1 ? b?.items.find((i) => i.id === sel[0]) ?? null : null;
    const key = JSON.stringify([it, sel.length]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.item = it;
    this.count = sel.length;
    this.invalidate();
  }
  private lastKey = "";

  protected draw(ctx: CanvasRenderingContext2D) {
    const it = this.item;
    const ctl = this.ctl;
    if (!it) {
      glass(this, ctx, this.count > 1 ? `${this.count} selected` : "Nothing selected");
      if (this.count > 1) this.button(ctx, "del", 36, 90, "Delete them", () => ctl.remove(ctl.selected()), { accent: LOOK.danger, w: 220 });
      else {
        ctx.font = sans(26);
        ctx.fillStyle = LOOK.muted;
        ctx.fillText("Point at something and pinch, or ask the voice.", 36, 110);
      }
      return;
    }
    glass(this, ctx, nameOf(it));
    ctx.font = cond(22, 500);
    ctx.fillStyle = LOOK.muted;
    ctx.fillText(it.kind.toUpperCase(), this.W - 36 - ctx.measureText(it.kind.toUpperCase()).width, 58);
    const patch = (p: Partial<Item>, merge?: string) => ctl.client.apply([{ op: "update", id: it.id, patch: p }], merge);
    let y = 84;
    // Colours.
    const names = Object.keys(COLORS);
    names.forEach((n, i) => {
      const x = 36 + i * 50;
      const c = COLORS[n];
      const on = colorOf(it.color) === c;
      ctx.beginPath();
      ctx.arc(x + 18, y + 20, on ? 18 : 14, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.globalAlpha = on ? 1 : 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (on) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      this.region({ id: `c:${n}`, x, y, w: 40, h: 40, onClick: () => patch({ color: n }) });
    });
    y += 60;
    let x = 36;
    for (const s of STATUSES) {
      x = this.button(ctx, `s:${s}`, x, y, s, () => patch({ status: (it.status === s ? null : s) as never }), { active: it.status === s, accent: STATUS_COLOR[s], size: 22, h: 44 }) + 10;
    }
    y += 64;
    x = 36;
    x = this.button(ctx, "smaller", x, y, "−", () => patch({ scale: Math.max(0.1, (it.scale ?? 1) / 1.2) }, `scale:${it.id}`), { w: 60, h: 48 }) + 8;
    ctx.font = cond(26, 600);
    ctx.fillStyle = LOOK.text;
    ctx.fillText(`${Math.round((it.scale ?? 1) * 100)}%`, x + 6, y + 33);
    x += 80;
    x = this.button(ctx, "bigger", x, y, "+", () => patch({ scale: Math.min(10, (it.scale ?? 1) * 1.2) }, `scale:${it.id}`), { w: 60, h: 48 }) + 20;
    x = this.button(ctx, "turn", x, y, "Turn", () => patch({ rotY: ((it.rotY ?? 0) + 45) % 360 }, `rot:${it.id}`), { w: 100, h: 48 }) + 12;
    this.button(ctx, "delete", this.W - 36 - 140, y, "Delete", () => ctl.remove([it.id]), { w: 140, h: 48, accent: LOOK.danger });
    y += 70;
    if (it.kind === "holo") {
      section(ctx, "Pull apart", 36, y + 28);
      this.slider(ctx, "explode", 220, y, this.W - 220 - 160, {
        value: it.explode ?? 0,
        min: 0,
        max: 1,
        step: 0.05,
        onChange: (v) => ctl.client.hold(it.id, { explode: v }),
        onCommit: () => ctl.client.release(it.id),
      });
      this.button(ctx, "spin", this.W - 36 - 110, y, "Spin", () => patch({ spin: !it.spin }), { active: !!it.spin, w: 110, h: 44, size: 22 });
    } else if (it.kind === "note" || it.kind === "text") {
      ctx.font = sans(24);
      ctx.fillStyle = LOOK.muted;
      ctx.fillText("Say what it should say: “change this note to …”", 36, y + 28);
    }
  }
}

/** Under your gaze: what the voice says or heard, and what the builder's doing. */
export class Strip extends Panel {
  private key = "";
  constructor(private ctl: Ctl, private activity: () => Board["activity"]) {
    super("strip", 0.5, 0.075, 1700);
  }

  refresh() {
    const a = this.activity();
    const key = JSON.stringify([this.ctl.caption(), this.ctl.voiceState(), a?.busy, a?.line, a?.error]);
    if (key !== this.key) {
      this.key = key;
      this.invalidate();
    }
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const a = this.activity();
    const cap = this.ctl.caption();
    const v = this.ctl.voiceState();
    roundRect(ctx, 3, 3, this.W - 6, this.H - 6, 16);
    ctx.fillStyle = "rgba(3, 16, 28, 0.66)";
    ctx.fill();
    ctx.strokeStyle = withAlpha(LOOK.cyan, 0.4);
    ctx.lineWidth = 2;
    ctx.stroke();
    // A dot for the voice: listening, speaking, off.
    ctx.beginPath();
    ctx.arc(34, this.H / 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = v === "speaking" ? LOOK.accent : v === "listening" ? LOOK.cyan : "#33485a";
    ctx.fill();
    ctx.font = sans(28, 500);
    ctx.fillStyle = LOOK.text;
    const line = a?.busy ? `◆ ${a.line ?? "Working"}…` : a?.error ? `Builder: ${a.error}` : cap || (v === "idle" ? "Press X (or pinch your left middle finger) to talk" : "Listening");
    let text = line;
    while (ctx.measureText(text).width > this.W - 80 && text.length > 4) text = `…${text.slice(Math.floor(text.length * 0.15))}`;
    ctx.fillStyle = a?.busy ? LOOK.accent : a?.error ? LOOK.danger : LOOK.text;
    ctx.fillText(text, 56, this.H / 2 + 10);
  }
}

/** Put a panel in front of the head: `dist` out, `drop` below the eye, tilted to face you. */
export function placeBeforeHead(p: Panel, cam: THREE.Camera, o: { dist: number; drop: number; side?: number; tilt?: number }) {
  const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const at = head.clone().addScaledVector(fwd, o.dist).addScaledVector(right, o.side ?? 0);
  at.y -= o.drop;
  p.mesh.position.copy(at);
  p.mesh.lookAt(head.x, at.y + (o.tilt ?? 0.25), head.z);
}
