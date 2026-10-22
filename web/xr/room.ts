import type { Story } from "../../shared/types";
import { stageAt } from "../lib/story";
import { Engine, type EngineHandlers } from "./engine";
import type { MapInput, MapStyle } from "./map";
import type { Actions, Model } from "./model";
import { Panels } from "./panels";

/**
 * The headset's side of the app: its renderer, map and panels. Loaded only
 * when a headset is found (see useXR), so the desktop never pays for it.
 * While no session is running it draws nothing; the desktop map is on screen.
 */

export type StorySource = () => { story: Story; beat: number; ms: number; playing: boolean } | null;

export class Room {
  readonly engine: Engine;
  private panels: Panels;
  private model: Model | null = null;
  /** The story position the panels last painted; null forces a paint. */
  private storyKey: string | null = null;

  constructor(
    handlers: EngineHandlers,
    private actions: Actions,
    private story: StorySource,
  ) {
    // The headset draws into its own framebuffer; the canvas only needs to exist.
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(host);
    // ?debug mirrors the headset's view over the page, for checking it without one on.
    const mirror = location.search.includes("debug");
    if (mirror) host.style.cssText = "position:fixed;inset:0;z-index:100;pointer-events:none;visibility:hidden";
    const onMode = handlers.onMode;
    this.engine = new Engine(host, {
      ...handlers,
      onFrame: () => this.tick(),
      onKey: (e) => this.key(e),
      onMode: (m) => {
        if (mirror) host.style.visibility = m === "flat" ? "hidden" : "visible";
        onMode(m);
      },
    });
    this.panels = new Panels(this.engine, actions);
  }

  setMap(input: MapInput) {
    this.engine.map.setData(input);
  }

  setStyle(style: MapStyle) {
    this.engine.map.setStyle(style);
  }

  update(model: Model) {
    this.model = model;
    this.storyKey = null;
    this.tick();
  }

  /**
   * A real keyboard in the headset (a Bluetooth one paired with the Quest, or
   * the PC's over Link). With the room's keyboard open it types there: Enter
   * sends, Esc closes. Closed, Enter or / opens it to ask, as / does on the
   * desktop. What's not used here flies (see Engine) or reaches the desktop's
   * own shortcuts.
   */
  private key(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const kb = this.panels.keyboard;
    if (!kb.open) {
      if (e.key !== "Enter" && e.key !== "/") return false;
      this.actions.openKeyboard("ask");
      return true;
    }
    if (e.key === "Enter") kb.submit();
    else if (e.key === "Escape") this.actions.closeKeyboard();
    else if (e.key === "Backspace") kb.backspace();
    else if (e.key.length === 1) kb.type(e.key);
    // Anything else is swallowed while typing, so no shortcut fires under the keyboard.
    return true;
  }

  /**
   * A story's position moves every frame but lives in the desktop's player:
   * read it here, so the caption follows the spoken word without a React
   * render per frame. The panels repaint only when the word changes.
   */
  private tick() {
    const m = this.model;
    if (!m) return;
    const s = this.story();
    const key = s ? `${s.story.id}:${s.beat}:${Math.floor(s.ms / 100)}:${s.playing}` : "";
    if (key === this.storyKey) return;
    this.storyKey = key;
    m.story = s ? { ...s, stage: stageAt(s.story, s.beat, s.ms) } : null;
    this.panels.update(m);
  }
}
