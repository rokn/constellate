import * as THREE from "three";
import { actionById } from "../../shared/boardActions";
import { sfx } from "../xr/sound";
import { cond, sans, withAlpha, wrap } from "../xr/ui";
import { HoloPanel, chamfer, faceHead, headFrame, icon } from "./hud";
import { FIXED_KEYS, KEYMAP } from "./keys";
import { LOOK } from "./look";
import { on, pick } from "./tune";
import { TypeXR } from "./typing";
import { WHEEL_KEYS } from "./wheel";
import type { XRInput, XRPlugin } from "./xr";

/**
 * The guide: a tour you play through — controllers, hands, two hands and
 * nested boards, the room, the keyboard — each step drawn (the controller
 * with the button lit, the hand in the pose) and, when it can tell, waiting
 * for you to do it. And a map of every control as it's set in Tune now.
 */

const CYAN = LOOK.cyan;
const AMBER = LOOK.accent;
const DONE_KEY = "workshop.guide";

type Part = "trigger" | "grip" | "stick" | "stickPress" | "a" | "b";
type Pose = "pinch" | "grab" | "fist" | "point" | "palmUp" | "palmIn" | "middle" | "thumbsUp" | "flat";
type Art =
  | { kind: "controller"; side: "left" | "right"; lit: Part[]; both?: boolean }
  | { kind: "hand"; side: "left" | "right"; pose: Pose; two?: Pose; arrows?: boolean }
  | { kind: "keys"; keys: string[] }
  | { kind: "icon"; name: string };

type Step = {
  title: string;
  text: () => string;
  art: Art;
  /** Done when any of these actions runs. */
  acts?: () => string[];
  /** Or when this is true (polled). */
  check?: (x: XRInput, s: StepState) => boolean;
  /** A button on the step that does it for you, to see. */
  tryIt?: string;
};
type StepState = { board: string | undefined; seen: Set<string> };
type Chapter = { id: string; name: string; icon: string; steps: Step[] };

const label = (id: string) => actionById(id)?.label ?? id;
const btn = (k: string) => label(pick(k));
const twoOf = (x: XRInput) => x.twoHandsMode;
const anyHand = (x: XRInput, f: (p: XRInput["ptrs"][number]) => boolean, hand: boolean) => x.ptrs.some((p) => !!p.source && x.isHand(p) === hand && f(p));

const CHAPTERS: Chapter[] = [
  {
    id: "controllers",
    name: "Controllers",
    icon: "play",
    steps: [
      {
        title: "Point and select",
        text: () => "Point the ray at an item and pull the trigger: it's selected. Keep the trigger held to drag it along the ray.",
        art: { kind: "controller", side: "right", lit: ["trigger"] },
        check: (x) => anyHand(x, (p) => p.press?.kind === "ray", false),
      },
      {
        title: "Grab and carry",
        text: () => "Squeeze the grip on an item to carry it in your hand. Fling it away to delete it; pull the trigger while gripping to crumple it.",
        art: { kind: "controller", side: "right", lit: ["grip"] },
        check: (x) => anyHand(x, (p) => !!p.carry, false),
      },
      {
        title: "The stick, while holding",
        text: () => "Dragging or carrying something: tilt the stick left and right to turn it, up and down to push it away or pull it in.",
        art: { kind: "controller", side: "right", lit: ["stick"] },
      },
      {
        title: "A and B",
        text: () => `A: ${btn("btnA")} (held: ${btn("btnAHold")}).\nB: ${btn("btnB")} (held: ${btn("btnBHold")}).`,
        art: { kind: "controller", side: "right", lit: ["a", "b"] },
        acts: () => [pick("btnA"), pick("btnAHold"), pick("btnB"), pick("btnBHold")],
      },
      {
        title: "X and Y",
        text: () => `X: ${btn("btnX")} (held: ${btn("btnXHold")}).\nY: ${btn("btnY")} (held: ${btn("btnYHold")}).`,
        art: { kind: "controller", side: "left", lit: ["a", "b"] },
        acts: () => [pick("btnX"), pick("btnXHold"), pick("btnY"), pick("btnYHold")],
      },
      {
        title: "The command wheel",
        text: () => "Hold the right stick in: the wheel opens around the controller. Tilt toward a slice and let go to run it. Its eight slices are yours to set in Tune.",
        art: { kind: "controller", side: "right", lit: ["stickPress"] },
        check: (x) => x.wheelOpen,
      },
      {
        title: "Move the table",
        text: () => "Squeeze the grip on empty space to move the whole table. Both grips: turn it and scale it. The left stick slides it; the right stick turns it. Point at an item and push the right stick up to go inside it.",
        art: { kind: "controller", side: "right", lit: ["grip"], both: true },
        check: (x) => x.ptrs.some((p) => p.grabbing),
      },
    ],
  },
  {
    id: "hands",
    name: "Hands",
    icon: "hand",
    steps: [
      {
        title: "Point and pinch",
        text: () => "Aim your hand at an item and pinch thumb and index: it's selected. Keep pinching to drag it. Hold still on it and the voice listens.",
        art: { kind: "hand", side: "right", pose: "pinch" },
        check: (x) => anyHand(x, (p) => p.press?.kind === "ray", true),
      },
      {
        title: "Grab",
        text: () => "Pinch right on an item, or close your hand around it, to carry it. Throw it away to delete it.",
        art: { kind: "hand", side: "right", pose: "grab" },
        check: (x) => anyHand(x, (p) => !!p.carry, true),
      },
      {
        title: "Crumple",
        text: () => "Holding an item, close your fist on it: it crumples and it's gone (undo brings it back).",
        art: { kind: "hand", side: "right", pose: "fist" },
      },
      {
        title: "The wrist dock",
        text: () => "Turn your left palm toward your face: the dock rises from your wrist — tools, voice, undo, the shelf, Tune, passthrough and leaving.",
        art: { kind: "hand", side: "left", pose: "palmIn" },
        check: (x) => x.dockOpen,
      },
      {
        title: "The palm menu",
        text: () => `Turn your ${pick("palmMenu") === "left" ? "left" : "right"} palm up to the ceiling: the command wheel blooms from it. Touch a slice, or point and pinch.`,
        art: { kind: "hand", side: pick("palmMenu") === "left" ? "left" : "right", pose: "palmUp" },
        check: (x) => x.wheelOpen,
      },
      {
        title: "Middle-finger pinch",
        text: () => `Middle finger to thumb. Left hand: ${btn("leftMiddlePinch")}. Right hand: ${btn("rightMiddlePinch")}.`,
        art: { kind: "hand", side: "right", pose: "middle" },
        acts: () => [pick("leftMiddlePinch"), pick("rightMiddlePinch")],
      },
      {
        title: "Poke",
        text: () => "Any panel, this one too: press it with a fingertip, like a touch screen.",
        art: { kind: "hand", side: "right", pose: "point" },
        check: (x) => x.ptrs.some((p) => !!p.poke?.down),
      },
      {
        title: "Your own gestures",
        text: () => "Record a pose — a thumbs-up, a fist, a peace sign — and bind it to any action. Hold it a moment and it runs.",
        art: { kind: "hand", side: "right", pose: "thumbsUp" },
        tryIt: "gestures",
        acts: () => ["gestures"],
      },
    ],
  },
  {
    id: "nesting",
    name: "Two hands · inside",
    icon: "inside",
    steps: [
      {
        title: "Two hands on one item",
        text: () => "Hold an item with one hand and take it with the other too. Stretch your hands apart: it scales. A tag between your hands says what stretching does.",
        art: { kind: "hand", side: "right", pose: "pinch", two: "pinch", arrows: true },
        check: (x) => !!twoOf(x),
      },
      {
        title: "Scale, pull apart, go inside",
        text: () => "While stretching, the helping hand's trigger (or middle pinch) swaps what it does: scale → pull a hologram apart → go inside.",
        art: { kind: "hand", side: "left", pose: "middle", two: "pinch" },
        check: (x) => twoOf(x) === "explode" || twoOf(x) === "open",
      },
      {
        title: "Dive inside",
        text: () => "In “go inside”, spread wide until the tag says Let go, and let go: you're inside its own board. Or select it and press Inside on its card.",
        art: { kind: "icon", name: "inside" },
        check: (x, s) => !!x.ctl.client.board?.parent && x.ctl.client.board.id !== s.board,
        tryIt: "inside",
      },
      {
        title: "Back up",
        text: () => "The dock's amber Up button takes you out a level. Or grab empty air with both hands and shrink the table under half its size.",
        art: { kind: "icon", name: "up" },
        check: (x, s) => x.ctl.client.board?.id !== s.board,
        tryIt: "up",
      },
      {
        title: "Zoom through levels",
        text: () => "Grab empty air with both hands and stretch the table past twice its size: you dive into the item between your hands. Context → containers → components → code.",
        art: { kind: "hand", side: "right", pose: "grab", two: "grab", arrows: true },
      },
    ],
  },
  {
    id: "room",
    name: "Boards · room",
    icon: "room",
    steps: [
      {
        title: "The board shelf",
        text: () => "Every board, as a little hologram on an arc beside you. Pinch one to switch; carry one to the table, into the room, or throw it at a wall.",
        art: { kind: "icon", name: "shelf" },
        acts: () => ["shelf"],
        tryIt: "shelf",
      },
      {
        title: "Desk, wall, room",
        text: () => "Desk mode fits the board on your real desk; wall mode stands it on a wall; room scale lets you walk inside it. Table mode brings it back. Wall ↔ table flips the board you point at (or the one you're on) between a wall and a table.",
        art: { kind: "icon", name: "desk" },
        acts: () => ["desk-mode", "wall-mode", "room-scale", "table-mode", "wall-toggle"],
        tryIt: "desk-mode",
      },
      {
        title: "Lock the items",
        text: () => "The dock's padlock freezes every item: grabs, pinches and drags all move the board itself, so you can handle it without knocking anything. Press it again to unlock.",
        art: { kind: "icon", name: "lock" },
        acts: () => ["lock"],
        tryIt: "lock",
      },
      {
        title: "Scrub history",
        text: () => "Run Scrub (the wheel, a key, or a button you set), then twist your wrist like a dial: left goes back, right forward. Pinch to go there; grip to leave it.",
        art: { kind: "icon", name: "clock" },
        acts: () => ["scrub"],
        tryIt: "scrub",
      },
      {
        title: "Snapshots",
        text: () => "A snapshot keeps where you're standing and looking, as a card. Tap the card later to stand there again.",
        art: { kind: "icon", name: "camera" },
        acts: () => ["snapshot"],
        tryIt: "snapshot",
      },
      {
        title: "Passthrough and leaving",
        text: () => "The dock's eye covers your room with the virtual one and back, without leaving. The red door ends the headset session.",
        art: { kind: "icon", name: "eye" },
        acts: () => ["passthrough"],
        tryIt: "passthrough",
      },
    ],
  },
  {
    id: "keyboard",
    name: "Keyboard",
    icon: "label",
    steps: [
      {
        title: "Just type",
        text: () => "With a Bluetooth keyboard paired to the headset, start typing: a text bar opens in front of you. Enter sends it; Tab switches between asking Jarvis, the selected item's label, and a new note. Esc closes it.",
        art: { kind: "keys", keys: ["H", "I", "⏎"] },
        check: (x) => !!x.plugins.find((p): p is TypeXR => p instanceof TypeXR)?.open,
      },
      {
        title: "Shortcuts",
        text: () =>
          pick("keyboardLetters") === "shortcuts"
            ? "Letters are shortcuts now (Tune → Letter keys): V select, C connect, D ink, I inside, U up… Enter or / opens the text bar. F1 shows them all."
            : "Alt plus a letter runs a shortcut: Alt-V select, Alt-C connect, Alt-I inside, Alt-U up, Alt-1…8 the wheel's slices. F1 shows them all.",
        art: { kind: "keys", keys: pick("keyboardLetters") === "shortcuts" ? ["I"] : ["Alt", "I"] },
        acts: () => KEYMAP.map((k) => k.action),
      },
      {
        title: "Hands rest while you type",
        text: () => "Your hands on the keys don't pinch or poke anything: hand tracking pauses while you type and comes back a moment after the last key.",
        art: { kind: "hand", side: "right", pose: "flat" },
      },
    ],
  },
];

export class GuideXR implements XRPlugin {
  private panel: GuidePanel;
  tab: "tour" | "map" = "tour";
  chapter: Chapter | null = null;
  step = 0;
  done = false;
  private state: StepState = { board: undefined, seen: new Set() };
  finished: Set<string>;

  constructor(readonly xr: XRInput) {
    this.panel = new GuidePanel(this);
    this.panel.onClose = () => this.close();
    this.panel.mesh.visible = false;
    this.panel.mesh.material.opacity = 1;
    xr.scene.overlay.add(this.panel.mesh);
    let f: string[] = [];
    try {
      f = JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]") as string[];
    } catch {
      /* none */
    }
    this.finished = new Set(Array.isArray(f) ? f : []);
  }

  get chapters() {
    return CHAPTERS;
  }

  panels() {
    return [this.panel];
  }

  handle(action: string): boolean {
    if (action !== "guide" && action !== "keymap") return false;
    if (this.panel.mesh.visible && ((action === "keymap") === (this.tab === "map"))) this.close();
    else this.open(action === "keymap" ? "map" : "tour");
    return true;
  }

  entered() {
    const when = pick("guideStart");
    if (when === "always" || (when === "first time" && !this.finished.has("seen"))) {
      // A moment in, once the room's there.
      setTimeout(() => this.open("tour"), 1500);
    }
  }

  left() {
    this.panel.mesh.visible = false;
  }

  open(tab: "tour" | "map") {
    this.tab = tab;
    const m = this.panel.mesh;
    const cam = this.xr.scene.renderer.xr.getCamera();
    const { head, fwd, right } = headFrame(cam);
    m.position.copy(head).addScaledVector(fwd, 0.7).addScaledVector(right, 0.12).add(new THREE.Vector3(0, -0.1, 0));
    faceHead(m, head);
    m.visible = true;
    this.finished.add("seen");
    this.save();
    this.panel.invalidate();
    sfx.play("pick");
  }

  close() {
    this.panel.mesh.visible = false;
  }

  begin(c: Chapter) {
    this.chapter = c;
    this.go(0);
  }

  go(i: number) {
    const c = this.chapter;
    if (!c) return;
    if (i >= c.steps.length) {
      this.finished.add(c.id);
      this.save();
      this.chapter = null;
      sfx.play("snap");
      this.xr.say(`${c.name} · done`);
    } else {
      this.step = Math.max(0, i);
      this.done = false;
      this.state = { board: this.xr.ctl.client.board?.id, seen: new Set() };
    }
    this.panel.invalidate();
  }

  current(): Step | null {
    return this.chapter?.steps[this.step] ?? null;
  }

  tryIt(id: string) {
    this.xr.act(id);
  }

  private save() {
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify([...this.finished]));
    } catch {
      /* not kept */
    }
  }

  private succeed() {
    if (this.done) return;
    this.done = true;
    sfx.play("place");
    this.panel.invalidate();
    // A breath to see it lit, then on.
    const at = this.step;
    const c = this.chapter;
    setTimeout(() => {
      if (this.chapter === c && this.step === at && this.done) this.go(at + 1);
    }, 1400);
  }

  acted(id: string) {
    const s = this.current();
    if (!s || !this.panel.mesh.visible || this.done || !on("guideChecks")) return;
    if (s.acts?.().includes(id)) this.succeed();
  }

  frame() {
    if (!this.panel.mesh.visible) return;
    const s = this.current();
    if (s?.check && !this.done && on("guideChecks") && s.check(this.xr, this.state)) this.succeed();
    this.panel.render();
  }
}

class GuidePanel extends HoloPanel {
  private page = 0;
  constructor(private g: GuideXR) {
    super("guide", 0.66, 0.44, "Guide");
  }

  protected draw(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    this.frameHolo(ctx, "Guide", g.tab === "map" ? "every control" : g.chapter ? g.chapter.name : "pick a chapter");
    const top = this.header + 8;
    this.holoButton(ctx, "tab:tour", 30, top, 140, 40, "Tour", () => ((g.tab = "tour"), this.invalidate()), { active: g.tab === "tour", size: 19 });
    this.holoButton(ctx, "tab:map", 180, top, 140, 40, "Map", () => ((g.tab = "map"), this.invalidate()), { active: g.tab === "map", size: 19 });
    if (g.tab === "map") return this.drawMap(ctx, top + 56);
    if (!g.chapter) return this.drawChapters(ctx, top + 56);
    this.drawStep(ctx, top + 56);
  }

  private drawChapters(ctx: CanvasRenderingContext2D, y0: number) {
    const g = this.g;
    const cols = 3;
    const w = (this.W - 60 - (cols - 1) * 16) / cols;
    const h = 150;
    g.chapters.forEach((c, i) => {
      const x = 30 + (i % cols) * (w + 16);
      const y = y0 + Math.floor(i / cols) * (h + 16);
      const id = `ch:${c.id}`;
      const hot = this.hover === id;
      const fin = g.finished.has(c.id);
      chamfer(ctx, x, y, w, h, 16);
      ctx.fillStyle = hot ? withAlpha(CYAN, 0.14) : "rgba(95, 212, 255, 0.04)";
      ctx.fill();
      ctx.strokeStyle = withAlpha(fin ? "#7dff9a" : CYAN, hot ? 0.95 : 0.4);
      ctx.lineWidth = 2;
      ctx.stroke();
      icon(ctx, c.icon, x + 46, y + 52, 40, hot ? "#fff" : fin ? "#7dff9a" : CYAN);
      let fs = 26;
      ctx.font = cond(fs, 700);
      while (ctx.measureText(c.name.toUpperCase()).width > w - 100 && fs > 16) ctx.font = cond(--fs, 700);
      ctx.fillStyle = "#dff6ff";
      ctx.fillText(c.name.toUpperCase(), x + 84, y + 62);
      ctx.font = sans(19);
      ctx.fillStyle = withAlpha("#dff6ff", 0.65);
      ctx.fillText(`${c.steps.length} steps${fin ? " · done ✓" : ""}`, x + 26, y + 118);
      this.region({ id, x, y, w, h, onClick: () => g.begin(c) });
    });
    ctx.font = sans(19);
    ctx.fillStyle = withAlpha("#dff6ff", 0.6);
    ctx.fillText(on("guideChecks") ? "Each step waits for you to try it, then moves on. Next always skips ahead." : "Next moves on (Tune → Guide waits for you to try it).", 30, this.H - 30);
  }

  private drawStep(ctx: CanvasRenderingContext2D, y0: number) {
    const g = this.g;
    const c = g.chapter!;
    const s = g.current()!;
    const artW = 400;
    const artH = this.H - y0 - 30;
    // The picture.
    chamfer(ctx, 30, y0, artW, artH, 18);
    ctx.fillStyle = "rgba(0, 10, 18, 0.55)";
    ctx.fill();
    ctx.strokeStyle = withAlpha(g.done ? "#7dff9a" : CYAN, 0.35);
    ctx.lineWidth = 2;
    ctx.stroke();
    drawArt(ctx, s.art, 30, y0, artW, artH, performance.now());
    this.invalidate(); // it moves

    // The words.
    const x = 30 + artW + 30;
    const tw = this.W - x - 30;
    ctx.font = cond(18, 600);
    ctx.letterSpacing = "3px";
    ctx.fillStyle = withAlpha(CYAN, 0.7);
    ctx.fillText(`${c.name.toUpperCase()} · ${g.step + 1} / ${c.steps.length}`, x, y0 + 22);
    ctx.letterSpacing = "0px";
    // Step dots.
    c.steps.forEach((_, i) => {
      ctx.beginPath();
      ctx.arc(x + i * 18 + 6, y0 + 42, 5, 0, Math.PI * 2);
      ctx.fillStyle = i < g.step || (i === g.step && g.done) ? "#7dff9a" : i === g.step ? AMBER : withAlpha(CYAN, 0.3);
      ctx.fill();
    });
    ctx.font = cond(36, 700);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(s.title.toUpperCase(), x, y0 + 92);
    ctx.font = sans(22);
    ctx.fillStyle = "#dff6ff";
    let y = y0 + 132;
    for (const para of s.text().split("\n")) {
      for (const line of wrap(ctx, para, tw)) {
        ctx.fillText(line, x, y);
        y += 30;
      }
      y += 6;
    }
    // Waiting for you, or done.
    const waits = on("guideChecks") && (s.check || s.acts);
    if (g.done || waits) {
      ctx.font = cond(22, 700);
      ctx.letterSpacing = "2px";
      ctx.fillStyle = g.done ? "#7dff9a" : withAlpha(AMBER, 0.6 + 0.4 * Math.sin(performance.now() / 300));
      ctx.fillText(g.done ? "✓ NICE" : "◆ YOUR TURN — TRY IT", x, this.H - 104);
      ctx.letterSpacing = "0px";
    }
    const by = this.H - 82;
    this.holoButton(ctx, "back", x, by, 110, 50, "Back", () => (g.step ? g.go(g.step - 1) : ((g.chapter = null), this.invalidate())), { size: 19 });
    this.holoButton(ctx, "chapters", x + 120, by, 150, 50, "Chapters", () => ((g.chapter = null), this.invalidate()), { size: 19 });
    if (s.tryIt) this.holoButton(ctx, "try", x + 280, by, 130, 50, "Show me", () => g.tryIt(s.tryIt!), { size: 19, color: AMBER });
    const last = g.step === c.steps.length - 1;
    this.holoButton(ctx, "next", this.W - 30 - 130, by, 130, 50, last ? "Finish" : "Next", () => g.go(g.step + 1), { size: 19, active: g.done });
  }

  /** Every control as it's set now: the controllers, the wheel, the hands, the keys. */
  private drawMap(ctx: CanvasRenderingContext2D, y0: number) {
    const lettersAlone = pick("keyboardLetters") === "shortcuts";
    const sections: [string, [string, string][]][] = [
      [
        "Right controller",
        [
          ["Trigger", "Select · drag · hold to talk"],
          ["Grip", "Carry · on air: move table"],
          ["A", `${btn("btnA")} · held ${btn("btnAHold")}`],
          ["B", `${btn("btnB")} · held ${btn("btnBHold")}`],
          ["Stick ◉", btn("btnRStick")],
          ["Stick", pick("rightStick") === "off" ? "—" : pick("rightStick") === "snap-turn" ? "Turn table in steps" : "Turn · scale table"],
        ],
      ],
      [
        "Left controller",
        [
          ["Trigger", "Select · drag"],
          ["Grip", "Carry · move table"],
          ["X", `${btn("btnX")} · held ${btn("btnXHold")}`],
          ["Y", `${btn("btnY")} · held ${btn("btnYHold")}`],
          ["Stick ◉", btn("btnLStick")],
          ["Stick", pick("leftStick") === "off" ? "—" : "Slide table"],
        ],
      ],
      ["Wheel", WHEEL_KEYS.map((k, i) => [String(i + 1), btn(k)] as [string, string])],
      [
        "Hands",
        [
          ["Pinch", "Select · drag · hold to talk"],
          ["Grab", "Carry · fist crumples"],
          ["2 hands", "Scale · pull apart · inside"],
          ["L palm in", "Wrist dock"],
          [`${pick("palmMenu") === "left" ? "L" : "R"} palm up`, pick("palmMenu") === "off" ? "—" : "Wheel"],
          ["L middle", btn("leftMiddlePinch")],
          ["R middle", btn("rightMiddlePinch")],
          ["Fingertip", "Poke panels"],
        ],
      ],
      ["Keyboard", [...KEYMAP.map((k) => [`${lettersAlone ? "" : "Alt "}${k.key.toUpperCase()}`, label(k.action)] as [string, string]), ...FIXED_KEYS]],
    ];
    // Laid out in columns, paged when they don't fit.
    const colW = (this.W - 60 - 2 * 20) / 3;
    const rowH = 27;
    const bottom = this.H - 40;
    type Block = { title: string; rows: [string, string][] };
    const blocks: Block[] = [];
    for (const [title, rows] of sections) {
      // A long section splits across columns.
      const per = Math.floor((bottom - y0 - 40) / rowH);
      for (let i = 0; i < rows.length; i += per) blocks.push({ title: i ? `${title} ·` : title, rows: rows.slice(i, i + per) });
    }
    const pages: Block[][][] = [[[]]];
    let col = 0;
    let used = 0;
    for (const b of blocks) {
      const h = 40 + b.rows.length * rowH + 14;
      if (used + h > bottom - y0) {
        col++;
        used = 0;
        if (col === 3) {
          pages.push([[]]);
          col = 0;
        } else pages[pages.length - 1].push([]);
      }
      pages[pages.length - 1][col].push(b);
      used += h;
    }
    this.page = Math.min(this.page, pages.length - 1);
    pages[this.page].forEach((blocksInCol, ci) => {
      const x = 30 + ci * (colW + 20);
      let y = y0;
      for (const b of blocksInCol) {
        ctx.font = cond(20, 700);
        ctx.letterSpacing = "3px";
        ctx.fillStyle = AMBER;
        ctx.fillText(b.title.toUpperCase(), x, y + 22);
        ctx.letterSpacing = "0px";
        y += 40;
        for (const [k, v] of b.rows) {
          ctx.font = cond(19, 700);
          ctx.fillStyle = CYAN;
          ctx.fillText(k, x, y);
          ctx.font = sans(18);
          ctx.fillStyle = "#dff6ff";
          let t = v;
          while (ctx.measureText(t).width > colW - 112 && t.length > 4) t = `${t.slice(0, -2)}…`;
          ctx.fillText(t, x + 106, y);
          y += rowH;
        }
        y += 14;
      }
    });
    if (pages.length > 1) {
      this.holoButton(ctx, "pg-", this.W - 230, this.header + 8, 60, 40, "‹", () => ((this.page = Math.max(0, this.page - 1)), this.invalidate()), { size: 22 });
      ctx.font = cond(20, 600);
      ctx.fillStyle = withAlpha(CYAN, 0.7);
      ctx.textAlign = "center";
      ctx.fillText(`${this.page + 1} / ${pages.length}`, this.W - 135, this.header + 36);
      ctx.textAlign = "left";
      this.holoButton(ctx, "pg+", this.W - 100, this.header + 8, 60, 40, "›", () => ((this.page = Math.min(pages.length - 1, this.page + 1)), this.invalidate()), { size: 22 });
    }
  }
}

/* ------------------------------- the pictures ------------------------------ */

function drawArt(ctx: CanvasRenderingContext2D, a: Art, x: number, y: number, w: number, h: number, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (a.kind === "controller") {
    if (a.both) {
      const R = Math.min(h * 0.26, w * 0.2);
      drawController(ctx, cx - w * 0.24, cy - R * 0.3, R, "left", a.lit, pulse);
      drawController(ctx, cx + w * 0.24, cy - R * 0.3, R, "right", a.lit, pulse);
    } else {
      const R = Math.min(h * 0.36, w * 0.5);
      drawController(ctx, cx, cy - R * 0.3, R, a.side, a.lit, pulse);
    }
  } else if (a.kind === "hand") {
    if (a.two) {
      const spread = a.arrows ? 0.04 * Math.sin(now / 500) : 0;
      const S = Math.min(h * 0.32, w * 0.3);
      drawHand(ctx, cx - w * (0.24 + spread), cy + 10, S, "left", a.two, pulse);
      drawHand(ctx, cx + w * (0.24 + spread), cy + 10, S, "right", a.pose, pulse);
      if (a.arrows) arrows(ctx, cx, cy + 10, w * 0.08, pulse);
    } else drawHand(ctx, cx + (a.side === "left" ? -1 : 1) * w * 0.04, cy + 10, Math.min(h * 0.5, w * 0.58), a.side, a.pose, pulse);
  } else if (a.kind === "keys") {
    const kw = Math.min(110, (w - 60) / a.keys.length - 14);
    const total = a.keys.length * (kw + 14) - 14;
    a.keys.forEach((k, i) => {
      const kx = cx - total / 2 + i * (kw + 14);
      const lit = Math.floor(now / 500) % a.keys.length === i;
      const ky = cy - kw / 2 + (lit ? 4 : 0);
      chamfer(ctx, kx, ky, kw, kw, 12);
      ctx.fillStyle = lit ? withAlpha(AMBER, 0.3) : "rgba(95, 212, 255, 0.06)";
      ctx.fill();
      ctx.strokeStyle = lit ? AMBER : withAlpha(CYAN, 0.6);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.font = cond(k.length > 1 ? 30 : 46, 700);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(k, kx + kw / 2, ky + kw / 2 + (k.length > 1 ? 11 : 16));
      ctx.textAlign = "left";
    });
  } else {
    const s = h * 0.4 * (1 + pulse * 0.06);
    ctx.shadowColor = CYAN;
    ctx.shadowBlur = 24;
    icon(ctx, a.name, cx, cy, s, CYAN);
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

function arrows(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, pulse: number) {
  ctx.strokeStyle = withAlpha(AMBER, 0.6 + 0.4 * pulse);
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  for (const s of [-1, 1]) {
    ctx.moveTo(cx + s * r - s * 14, cy - 12);
    ctx.lineTo(cx + s * r, cy);
    ctx.lineTo(cx + s * r - s * 14, cy + 12);
  }
  ctx.stroke();
}

/** A Quest controller seen from above: the ring, the face with its stick and two buttons, the trigger in front, the grip on the side. */
function drawController(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, side: "left" | "right", lit: Part[], pulse: number) {
  const s = side === "right" ? 1 : -1;
  const line = withAlpha(CYAN, 0.75);
  const on = (p: Part) => lit.includes(p);
  const litFill = withAlpha(AMBER, 0.35 + 0.35 * pulse);
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // The handle, below the face.
  ctx.beginPath();
  ctx.moveTo(cx - R * 0.32, cy + R * 0.35);
  ctx.quadraticCurveTo(cx - R * 0.36, cy + R * 1.05, cx - R * 0.12, cy + R * 1.2);
  ctx.lineTo(cx + R * 0.12, cy + R * 1.2);
  ctx.quadraticCurveTo(cx + R * 0.36, cy + R * 1.05, cx + R * 0.32, cy + R * 0.35);
  ctx.strokeStyle = line;
  ctx.stroke();
  // The grip: on the handle's inner side.
  const gx = cx - s * R * 0.34;
  ctx.beginPath();
  ctx.ellipse(gx, cy + R * 0.75, R * 0.09, R * 0.3, 0, 0, Math.PI * 2);
  ctx.fillStyle = on("grip") ? litFill : "rgba(95,212,255,0.05)";
  ctx.fill();
  ctx.strokeStyle = on("grip") ? AMBER : line;
  ctx.stroke();
  tag(ctx, "GRIP", gx - s * R * 0.04, cy + R * 1.26, on("grip"), "center");
  // The tracking ring, arching over the face.
  ctx.beginPath();
  ctx.ellipse(cx + s * R * 0.12, cy - R * 0.3, R * 0.62, R * 0.52, 0, Math.PI * 0.85, Math.PI * 2.15);
  ctx.strokeStyle = withAlpha(CYAN, 0.45);
  ctx.stroke();
  // The trigger, at the front.
  ctx.beginPath();
  ctx.ellipse(cx, cy - R * 0.62, R * 0.2, R * 0.08, 0, 0, Math.PI * 2);
  ctx.fillStyle = on("trigger") ? litFill : "rgba(95,212,255,0.05)";
  ctx.fill();
  ctx.strokeStyle = on("trigger") ? AMBER : line;
  ctx.stroke();
  tag(ctx, "TRIGGER", cx, cy - R * 0.82, on("trigger"), "center");
  // The face.
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(2, 14, 24, 0.8)";
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.stroke();
  // The stick.
  const sx = cx - s * R * 0.16;
  const sy = cy - R * 0.08;
  const stickLit = on("stick") || on("stickPress");
  ctx.beginPath();
  ctx.arc(sx, sy, R * 0.13, 0, Math.PI * 2);
  ctx.fillStyle = stickLit ? litFill : "rgba(95,212,255,0.08)";
  ctx.fill();
  ctx.strokeStyle = stickLit ? AMBER : line;
  ctx.stroke();
  if (on("stickPress")) {
    ctx.beginPath();
    ctx.arc(sx, sy, R * (0.17 + 0.08 * pulse), 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(AMBER, 1 - pulse);
    ctx.stroke();
  }
  if (on("stick")) {
    ctx.strokeStyle = withAlpha(AMBER, 0.8);
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      ctx.beginPath();
      ctx.moveTo(sx + dx * R * 0.2, sy + dy * R * 0.2);
      ctx.lineTo(sx + dx * R * 0.27, sy + dy * R * 0.27);
      ctx.stroke();
    }
  }
  // The two buttons: A and B (right), X and Y (left).
  const names = side === "right" ? ["A", "B"] : ["X", "Y"];
  const spots: [number, number][] = [
    [cx + s * R * 0.16, cy + R * 0.2],
    [cx + s * R * 0.26, cy - R * 0.1],
  ];
  (["a", "b"] as const).forEach((p, i) => {
    const [bx, by] = spots[i];
    ctx.beginPath();
    ctx.arc(bx, by, R * 0.085, 0, Math.PI * 2);
    ctx.fillStyle = on(p) ? litFill : "rgba(95,212,255,0.08)";
    ctx.fill();
    ctx.strokeStyle = on(p) ? AMBER : line;
    ctx.stroke();
    ctx.font = cond(Math.round(R * 0.11), 700);
    ctx.fillStyle = on(p) ? "#fff" : CYAN;
    ctx.textAlign = "center";
    ctx.fillText(names[i], bx, by + R * 0.04);
    ctx.textAlign = "left";
  });
  tag(ctx, side === "right" ? "RIGHT" : "LEFT", cx + s * R * 0.3, cy + R * 1.5, false, "center");
}

function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, lit: boolean, align: CanvasTextAlign) {
  ctx.font = cond(18, 700);
  ctx.letterSpacing = "2px";
  ctx.fillStyle = lit ? AMBER : withAlpha(CYAN, 0.55);
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
  ctx.letterSpacing = "0px";
}

/** A hand, palm toward you, fingers up, in a pose: how curled each finger is and where the thumb goes. */
function drawHand(ctx: CanvasRenderingContext2D, cx: number, cy: number, S: number, side: "left" | "right", pose: Pose, pulse: number) {
  ctx.save();
  ctx.translate(cx, cy);
  if (side === "left") ctx.scale(-1, 1);
  const k = S / 200;
  ctx.scale(k, k);
  // Curl per finger (index, middle, ring, pinky): 0 straight … 1 folded.
  const curls: Record<Pose, number[]> = {
    flat: [0, 0, 0, 0],
    palmUp: [0, 0, 0, 0],
    palmIn: [0, 0, 0, 0],
    point: [0, 1, 1, 1],
    pinch: [0.45, 0.1, 0.1, 0.1],
    middle: [0.1, 0.5, 0.15, 0.1],
    grab: [0.6, 0.65, 0.65, 0.6],
    fist: [1, 1, 1, 1],
    thumbsUp: [1, 1, 1, 1],
  };
  const c = curls[pose];
  const line = withAlpha(CYAN, 0.85);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // The palm.
  ctx.beginPath();
  ctx.moveTo(-62, -10);
  ctx.quadraticCurveTo(-70, 70, -30, 100);
  ctx.lineTo(34, 100);
  ctx.quadraticCurveTo(70, 70, 64, -10);
  ctx.closePath();
  ctx.fillStyle = "rgba(95, 212, 255, 0.07)";
  ctx.fill();
  ctx.strokeStyle = line;
  ctx.lineWidth = 4;
  ctx.stroke();
  // The fingers, from their knuckles: straight up, or folding toward the palm (shorter, seen end-on).
  const bases = [-44, -14, 16, 44];
  const lens = [92, 104, 96, 74];
  const tips: [number, number][] = [];
  bases.forEach((bx, i) => {
    const len = lens[i] * (1 - c[i] * 0.78);
    const tipY = -14 - len;
    ctx.beginPath();
    ctx.moveTo(bx, -10);
    // A slight bend: a curled finger's tip comes forward (down the picture) a little.
    ctx.quadraticCurveTo(bx + (i - 1.5) * 3, -14 - len * 0.6, bx + (i - 1.5) * 2, tipY);
    ctx.lineWidth = 22;
    ctx.strokeStyle = withAlpha(CYAN, 0.18);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = line;
    ctx.stroke();
    if (c[i] > 0.7) {
      // Folded: the knuckle row shows.
      ctx.beginPath();
      ctx.arc(bx, -16, 10, Math.PI, 0);
      ctx.stroke();
    }
    tips.push([bx + (i - 1.5) * 2, tipY]);
  });
  // The thumb: out to the side, up (thumbs-up), across the fingers (fist), or to a fingertip (pinches).
  let to: [number, number];
  if (pose === "pinch") to = [tips[0][0] - 4, tips[0][1] + 8];
  else if (pose === "middle") to = [tips[1][0] - 6, tips[1][1] + 8];
  else if (pose === "fist") to = [-6, -12];
  else if (pose === "thumbsUp") to = [-96, -110];
  else if (pose === "grab") to = [-40, -40];
  else to = [-110, -30];
  ctx.beginPath();
  ctx.moveTo(-58, 60);
  ctx.quadraticCurveTo(-100, 40, to[0], to[1]);
  ctx.lineWidth = 24;
  ctx.strokeStyle = withAlpha(CYAN, 0.18);
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.strokeStyle = line;
  ctx.stroke();
  // Where it happens: the pinch's spark, the grabbed block, the palm's way.
  if (pose === "pinch" || pose === "middle") {
    ctx.beginPath();
    ctx.arc(to[0] + 2, to[1] - 4, 10 + pulse * 8, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(AMBER, 0.25 + 0.5 * pulse);
    ctx.fill();
  }
  if (pose === "grab") {
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 3;
    ctx.strokeRect(-30, -78, 56, 50);
  }
  if (pose === "point") {
    ctx.beginPath();
    ctx.arc(tips[0][0], tips[0][1] - 8, 8 + pulse * 10, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(AMBER, 1 - pulse);
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  if (pose === "fist") {
    ctx.strokeStyle = withAlpha(AMBER, 0.5 + 0.5 * pulse);
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 110, 30 + Math.sin(a) * 110);
      ctx.lineTo(Math.cos(a) * (95 - pulse * 15), 30 + Math.sin(a) * (95 - pulse * 15));
      ctx.stroke();
    }
  }
  ctx.restore();
  // Words don't mirror.
  if (pose === "palmUp" || pose === "palmIn" || pose === "flat") {
    const up = pose === "palmUp";
    ctx.strokeStyle = withAlpha(AMBER, 0.6 + 0.4 * pulse);
    ctx.lineWidth = 4;
    ctx.beginPath();
    const ax = cx + (side === "left" ? -1 : 1) * S * 0.72;
    const ay = cy - S * 0.1;
    if (pose === "flat") {
      // Resting: a keyboard under it.
      chamfer(ctx, cx - S * 0.7, cy + S * 0.62, S * 1.4, S * 0.22, 10);
      ctx.stroke();
      for (let i = 1; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - S * 0.7 + (i * S * 1.4) / 8, cy + S * 0.62);
        ctx.lineTo(cx - S * 0.7 + (i * S * 1.4) / 8, cy + S * 0.84);
        ctx.stroke();
      }
    } else {
      ctx.moveTo(ax, ay + 40);
      ctx.lineTo(ax, ay - 40);
      ctx.moveTo(ax - 14, ay - 26);
      ctx.lineTo(ax, ay - 40);
      ctx.lineTo(ax + 14, ay - 26);
      ctx.stroke();
      tag(ctx, up ? "PALM UP" : "PALM TO YOU", cx, cy + S * 0.78, true, "center");
    }
  }
}
