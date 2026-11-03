import * as THREE from "three";
import type { Item } from "../../shared/board";
import { sfx } from "../xr/sound";
import { cond, sans, withAlpha } from "../xr/ui";
import { HoloPanel, chamfer, faceHead, headFrame } from "./hud";
import { KEYMAP, keyOf } from "./keys";
import { LOOK } from "./look";
import { on, pick } from "./tune";
import { WHEEL_KEYS } from "./wheel";
import type { XRInput, XRPlugin } from "./xr";

/**
 * A keyboard in the headset (a Bluetooth one paired to the Quest): start
 * typing and a text bar opens low in front of you. Enter sends it — to Jarvis,
 * as the selected item's label, or as a new note; Tab switches which. Esc
 * closes it. With the bar closed, the keys you'd expect still work: Delete
 * removes the selection, Esc clears it, ⌘/Ctrl-Z undoes, Space talks.
 */

export type TypeTarget = "ask" | "label" | "note";
const TARGETS: TypeTarget[] = ["ask", "label", "note"];

export class TypeXR implements XRPlugin {
  private bar = new TypeBar(this);
  open = false;
  text = "";
  target: TypeTarget = "ask";
  private sent: string[] = [];
  private recall = -1;
  private at = new THREE.Vector3();
  private blink = 0;
  caret = true;

  constructor(private xr: XRInput) {
    this.bar.mesh.visible = false;
    this.bar.mesh.material.opacity = 1;
    xr.scene.overlay.add(this.bar.mesh);
    // Capture, so the desktop's own shortcuts never see a key meant for the headset.
    window.addEventListener("keydown", this.key, { capture: true });
  }

  panels() {
    return [this.bar];
  }

  handle(action: string): boolean {
    if (action !== "keyboard") return false;
    if (this.open) this.close();
    else this.show("");
    return true;
  }

  left() {
    this.close();
  }

  /** The one selected item, if there's exactly one. */
  item(): Item | null {
    const sel = this.xr.ctl.selected();
    return sel.length === 1 ? this.xr.ctl.client.board?.items.find((i) => i.id === sel[0]) ?? null : null;
  }

  /** Where Enter sends it, given what's selected now (no item: a label can't be). */
  where(): TypeTarget {
    return this.target === "label" && !this.item() ? "ask" : this.target;
  }

  cycle(d = 1) {
    const usable = TARGETS.filter((t) => t !== "label" || this.item());
    this.target = usable[(usable.indexOf(this.where()) + d + usable.length) % usable.length];
    // Into a label: start from what it says now.
    if (this.target === "label" && !this.text) this.text = labelOf(this.item());
    sfx.play("tick");
    this.bar.invalidate();
  }

  private show(text: string) {
    const want = pick("keyboardTarget") as TypeTarget;
    this.target = TARGETS.includes(want) ? want : "ask";
    this.open = true;
    this.text = text;
    this.recall = -1;
    this.at.set(0, 0, 0);
    this.bar.mesh.visible = true;
    this.bar.invalidate();
    sfx.play("pick");
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.text = "";
    this.bar.mesh.visible = false;
  }

  send() {
    const text = this.text.trim();
    const where = this.where();
    if (!text) return this.close();
    const ctl = this.xr.ctl;
    if (where === "ask") {
      ctl.ask(text);
      this.xr.say("Asked");
    } else if (where === "label") {
      const it = this.item()!;
      ctl.client.apply([{ op: "update", id: it.id, patch: it.kind === "note" || it.kind === "text" ? { body: text } : { label: text } }]);
      this.xr.say("Renamed");
    } else {
      const f = this.xr.scene.focusPoint();
      ctl.select([ctl.add("note", [f[0], 0, f[2]], { body: text })]);
      this.xr.say("Note added");
    }
    this.sent = [text, ...this.sent.filter((s) => s !== text)].slice(0, 20);
    sfx.play("place");
    this.close();
  }

  /** A shortcut: from the map, or 1–8 for the wheel's slices. */
  private shortcut(k: string): boolean {
    const n = Number(k);
    const id = n >= 1 && n <= 8 ? pick(WHEEL_KEYS[n - 1]) : KEYMAP.find((s) => s.key === k)?.action;
    if (!id || id === "none") return false;
    this.xr.act(id);
    return true;
  }

  private key = (e: KeyboardEvent) => {
    const scene = this.xr.scene;
    if (scene.mode === "flat" || !on("keyboard") || e.isComposing) return;
    // In the headset every key is ours: the desktop's single-letter shortcuts would fight the typing.
    e.stopImmediatePropagation();
    // Hands on the keys: they rest a moment.
    if (!["Shift", "Alt", "Control", "Meta"].includes(e.key)) this.xr.hushHands();
    const mod = e.metaKey || e.ctrlKey;
    const printable = e.key.length === 1 && !mod && !e.altKey;
    const k = keyOf(e);

    if (e.key === "F1" || (e.altKey && k === "/")) {
      e.preventDefault();
      this.xr.act("keymap");
      return;
    }

    if (!this.open) {
      const lettersAlone = pick("keyboardLetters") === "shortcuts";
      if (mod && (k === "z" || k === "y")) {
        e.preventDefault();
        if (e.shiftKey || k === "y") this.xr.ctl.client.redo();
        else this.xr.ctl.client.undo();
      } else if (e.altKey && !mod && this.shortcut(k)) {
        /* ran */
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const sel = this.xr.ctl.selected();
        if (sel.length) this.xr.ctl.remove(sel);
      } else if (e.key === "Escape") this.xr.ctl.select([]);
      else if (e.key === " ") this.xr.ctl.toggleVoice();
      else if (e.key === "Enter" || e.key === "Tab" || (lettersAlone && e.key === "/")) this.show("");
      else if (lettersAlone && e.key === "?") this.xr.act("keymap");
      else if (lettersAlone && printable && this.shortcut(k)) {
        /* ran */
      } else if (printable && !lettersAlone) this.show(e.key);
      else return;
      e.preventDefault();
      return;
    }

    e.preventDefault();
    if (e.key === "Enter" && !e.shiftKey) return this.send();
    if (e.key === "Escape") return this.close();
    if (e.key === "Tab") return this.cycle(e.shiftKey ? -1 : 1);
    if (e.key === "Backspace") {
      // Alt or Ctrl: the whole last word.
      this.text = e.altKey || e.ctrlKey ? this.text.replace(/\s*\S+\s*$/, "") : this.text.slice(0, -1);
    } else if (e.key === "ArrowUp" && this.sent.length) {
      this.recall = Math.min(this.sent.length - 1, this.recall + 1);
      this.text = this.sent[this.recall];
    } else if (e.key === "ArrowDown") {
      this.recall = Math.max(-1, this.recall - 1);
      this.text = this.recall >= 0 ? this.sent[this.recall] : "";
    } else if (mod && e.key.toLowerCase() === "v") {
      void navigator.clipboard
        ?.readText()
        .then((t) => {
          this.text += t.replace(/\s+/g, " ");
          this.bar.invalidate();
        })
        .catch(() => {});
    } else if (mod && e.key.toLowerCase() === "a") this.text = "";
    else if (e.key === "Enter") this.text += "\n";
    else if (printable) this.text += e.key;
    else return;
    this.caret = true;
    this.blink = 0;
    this.bar.invalidate();
  };

  frame(dt: number) {
    if (!this.open) return;
    const cam = this.xr.scene.renderer.xr.getCamera();
    const { head, fwd } = headFrame(cam);
    // Low in front of you, over the captions; it drifts after you, it doesn't stick to your face.
    const want = head.clone().addScaledVector(fwd, 0.8).add(new THREE.Vector3(0, -0.2, 0));
    if (this.at.lengthSq() === 0 || this.at.distanceTo(want) > 0.5) this.at.copy(want);
    else this.at.lerp(want, 1 - Math.exp(-dt * 2.5));
    this.bar.mesh.position.copy(this.at);
    faceHead(this.bar.mesh, head);
    this.blink += dt;
    if (this.blink > 0.5) {
      this.blink = 0;
      this.caret = !this.caret;
      this.bar.invalidate();
    }
    this.bar.render();
  }

  dispose() {
    window.removeEventListener("keydown", this.key, { capture: true });
  }
}

function labelOf(it: Item | null) {
  if (!it) return "";
  return (it.kind === "note" || it.kind === "text" ? it.body : it.label) ?? "";
}

const NAMES: Record<TypeTarget, string> = { ask: "ASK JARVIS", label: "LABEL", note: "NEW NOTE" };

class TypeBar extends HoloPanel {
  constructor(private t: TypeXR) {
    super("typing", 0.56, 0.085, "");
    this.header = 0;
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const { W, H } = this;
    const t = this.t;
    const where = t.where();
    chamfer(ctx, 3, 3, W - 6, H - 6, 14);
    ctx.fillStyle = "rgba(2, 14, 24, 0.82)";
    ctx.fill();
    ctx.strokeStyle = withAlpha(LOOK.accent, 0.8);
    ctx.lineWidth = 2;
    ctx.stroke();

    // Where it goes: a chip; pointing and pinching it switches, like Tab.
    const it = t.item();
    const chip = where === "label" && it ? `${NAMES.label} · ${(it.label || it.kind).slice(0, 14).toUpperCase()}` : NAMES[where];
    ctx.font = cond(22, 700);
    ctx.letterSpacing = "2px";
    const cw = Math.min(260, ctx.measureText(chip).width + 36);
    ctx.letterSpacing = "0px";
    this.holoButton(ctx, "target", 14, 14, cw, 50, chip, () => t.cycle(), { size: 18, color: LOOK.accent, active: true });

    // What's typed: its tail, if it's long; one line (a newline shows as ⏎).
    const x0 = 14 + cw + 16;
    const room = W - x0 - 110;
    ctx.font = sans(28, 500);
    let s = t.text.replace(/\n/g, " ⏎ ");
    while (ctx.measureText(s).width > room && s.length > 1) s = s.slice(1);
    if (s.length < t.text.length) s = `…${s.slice(1)}`;
    ctx.fillStyle = t.text ? "#ffffff" : withAlpha("#dff6ff", 0.45);
    ctx.fillText(s || (where === "ask" ? "Ask about the board…" : where === "label" ? "New label…" : "Write a note…"), x0, 49);
    if (t.caret) {
      const cx = x0 + (t.text ? ctx.measureText(s).width + 2 : 0);
      ctx.fillStyle = LOOK.accent;
      ctx.fillRect(cx, 22, 3, 36);
    }
    this.holoButton(ctx, "send", W - 100, 14, 86, 50, "Send", () => t.send(), { size: 18 });

    ctx.font = cond(15, 600);
    ctx.letterSpacing = "2px";
    ctx.fillStyle = withAlpha(LOOK.cyan, 0.6);
    ctx.textAlign = "center";
    ctx.fillText("ENTER SEND · TAB SWITCH · ↑ LAST · ESC CLOSE", W / 2, H - 16);
    ctx.textAlign = "left";
    ctx.letterSpacing = "0px";
  }
}
