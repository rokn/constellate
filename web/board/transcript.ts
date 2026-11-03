import * as THREE from "three";
import type { LogEntry } from "../lib/useVoice";
import { cond, sans, withAlpha, wrap } from "../xr/ui";
import { HoloPanel, faceHead, headFrame } from "./hud";
import { LOOK } from "./look";
import { on } from "./tune";
import type { XRInput, XRPlugin } from "./xr";

/**
 * The transcript in the headset: everything said, newest at the bottom, with
 * what happened along the way (talked over, a sound it ignored, reconnecting).
 * A panel like the others: pin it where it is, carry it by its title, or
 * throw it at a wall and it stays there.
 */

type Live = { log: LogEntry[]; heard: string; caption: string };

export class TranscriptXR implements XRPlugin {
  private panel: TranscriptPanel;

  constructor(
    private xr: XRInput,
    live: () => Live,
    clear: () => void,
  ) {
    this.panel = new TranscriptPanel(live, clear);
    this.panel.onClose = () => (this.panel.mesh.visible = false);
    this.panel.mesh.visible = false;
    xr.scene.overlay.add(this.panel.mesh);
  }

  panels() {
    return [this.panel];
  }

  handle(action: string): boolean {
    if (action !== "transcript") return false;
    const m = this.panel.mesh;
    if (m.visible) {
      m.visible = false;
      return true;
    }
    if (!on("transcriptLog")) {
      this.xr.say("Transcript log is off in Tune");
      return true;
    }
    if (!this.panel.pinned) {
      // To your left, where it won't cover the board.
      const { head, fwd, right } = headFrame(this.xr.scene.renderer.xr.getCamera());
      m.position.copy(head).addScaledVector(fwd, 0.65).addScaledVector(right, -0.38).add(new THREE.Vector3(0, -0.08, 0));
      faceHead(m, head);
    }
    m.visible = true;
    this.panel.invalidate();
    return true;
  }

  frame() {
    if (this.panel.mesh.visible) this.panel.tick();
  }
}

class TranscriptPanel extends HoloPanel {
  private key = "";
  private scroll = 0;

  constructor(
    private live: () => Live,
    private clear: () => void,
  ) {
    super("transcript", 0.42, 0.5, "Transcript");
  }

  /** Redrawn when something new is said (or being said). */
  tick() {
    const l = this.live();
    const key = `${l.log.length}|${l.log.at(-1)?.at}|${l.heard}|${l.caption}`;
    if (key !== this.key) {
      this.key = key;
      this.scroll = 0;
      this.invalidate();
    }
    this.render();
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const { W, H } = this;
    const l = this.live();
    this.frameHolo(ctx, "Transcript", `${l.log.filter((e) => e.who !== "note").length} lines`);
    this.holoButton(ctx, "clear", W - 290, 14, 100, 40, "Clear", () => this.clear(), { size: 17 });
    this.holoButton(ctx, "up", 30, H - 62, 120, 44, "▲ Older", () => ((this.scroll += 4), this.invalidate()), { size: 17 });
    this.holoButton(ctx, "down", 160, H - 62, 120, 44, "Newest ▼", () => ((this.scroll = 0), this.invalidate()), { size: 17, active: this.scroll === 0 });

    // Lines from the bottom up: the newest (and what's being said) last.
    type Line = { text: string; color: string; font: string };
    const lines: Line[] = [];
    const left = 30;
    const width = W - 60;
    const add = (who: string, text: string, color: string, italic = false, extra = "") => {
      ctx.font = sans(22, italic ? 400 : 500);
      const head = who ? `${who}  ` : "";
      wrap(ctx, `${head}${text}${extra}`, width).forEach((t) => lines.push({ text: t, color, font: ctx.font }));
    };
    for (const e of l.log.slice(-80)) {
      if (e.who === "note") add("·", e.text, withAlpha("#7fa6bd", 0.85), true);
      else add(e.who === "you" ? "YOU" : "VOICE", e.text, e.who === "you" ? "#bff0ff" : "#ffd79a", false, e.cut ? "  — cut off" : "");
    }
    if (l.heard) add("YOU", `${l.heard}…`, withAlpha("#bff0ff", 0.65), true);
    if (l.caption) add("VOICE", `${l.caption}…`, withAlpha("#ffd79a", 0.65), true);

    const top = this.header + 16;
    const bottom = H - 80;
    const lh = 30;
    const fit = Math.floor((bottom - top) / lh);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - fit)));
    const end = lines.length - this.scroll;
    const view = lines.slice(Math.max(0, end - fit), end);
    view.forEach((ln, i) => {
      ctx.font = ln.font;
      ctx.fillStyle = ln.color;
      ctx.fillText(ln.text, left, top + (i + 1) * lh - 6);
    });
    if (!lines.length) {
      ctx.font = sans(22);
      ctx.fillStyle = withAlpha("#dff6ff", 0.6);
      ctx.fillText("Nothing said yet. Turn the voice on and talk.", left, top + 34);
    }
    ctx.font = cond(16, 600);
    ctx.fillStyle = withAlpha(LOOK.cyan, 0.55);
    ctx.textAlign = "right";
    ctx.fillText("PIN IT · CARRY IT BY THE TITLE · THROW IT AT A WALL", W - 30, H - 34);
    ctx.textAlign = "left";
  }
}
