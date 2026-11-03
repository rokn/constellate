/**
 * Every knob in the workshop, in one place: how it looks (glow, holograms,
 * labels, links, the table), how it moves (camera, editing), and the
 * headset's own settings (placement, panels, hands, sound, voice). Kept per
 * browser, like the map's Tune: it's how *you* like to work. Presets — the
 * built-in looks and the ones you save — are kept on the server.
 *
 * The voice and Jarvis turn the same knobs by key (see server/board/tune.ts).
 */

import { ACTION_IDS } from "./boardActions";

export type TuneValue = number | boolean | string;
export type BoardKnob = { key: string; label: string; hint?: string } & ({ toggle: true } | { min: number; max: number; step: number } | { choices: string[] });
export type BoardSection = { id: string; title: string; knobs: BoardKnob[]; where?: "headset" | "flat" | "both" };

const n = (key: string, label: string, min: number, max: number, step: number, hint?: string): BoardKnob => ({ key, label, min, max, step, hint });
const t = (key: string, label: string, hint?: string): BoardKnob => ({ key, label, toggle: true, hint });
const c = (key: string, label: string, choices: string[], hint?: string): BoardKnob => ({ key, label, choices, hint });
/** A knob that picks an action (a button, a wheel slice). */
const act = (key: string, label: string, hint?: string): BoardKnob => c(key, label, ACTION_IDS, hint);

export const BOARD_SECTIONS: BoardSection[] = [
  {
    id: "glow",
    title: "Glow",
    knobs: [t("bloom", "Bloom"), n("bloomStrength", "Bloom strength", 0, 2, 0.05), n("bloomRadius", "Bloom spread", 0, 1, 0.05), n("bloomThreshold", "Bloom threshold", 0, 1, 0.01, "What's brighter than this glows")],
  },
  {
    id: "holo",
    title: "Holograms",
    knobs: [
      n("fill", "Fill", 0, 3, 0.05, "How solid the holograms' faces are"),
      n("rim", "Rim light", 0, 3, 0.05, "The glow at their silhouettes"),
      n("edges", "Edges", 0, 3, 0.05),
      n("scanlines", "Scan lines", 0, 2, 0.05),
      n("flicker", "Flicker", 0, 3, 0.1),
      n("itemSize", "Item size", 0.5, 2, 0.05, "Every item, bigger or smaller"),
      n("printSeconds", "Print-in time", 0, 4, 0.1, "How long a new item takes to appear"),
      n("spinSpeed", "Spin speed", 0, 4, 0.1),
      n("explodeReach", "Pull-apart reach", 0.2, 3, 0.1),
      t("glide", "Glide into place", "Items move smoothly to a new spot instead of jumping"),
    ],
  },
  {
    id: "labels",
    title: "Labels",
    knobs: [t("labels", "Labels"), n("labelSize", "Label size", 0.4, 2.5, 0.05), n("labelBrightness", "Label brightness", 0.2, 2, 0.05), t("tags", "Tags under labels"), t("insideMarker", "Mark what has a board inside", "Plates over it, a dashed ring round it, and '▣ inside · n items' under its name"), t("linkLabels", "Link labels")],
  },
  {
    id: "links",
    title: "Links",
    knobs: [
      n("linkWidth", "Width", 0.3, 3, 0.05),
      n("linkBrightness", "Brightness", 0, 3, 0.05),
      n("flowSpeed", "Flow speed", 0, 4, 0.1),
      n("packets", "Packets", 0, 3, 0.1, "How many pulses run along each link"),
      n("arcHeight", "Arc height", 0, 3, 0.1),
      t("arrows", "Arrowheads"),
      t("protocolStyles", "Protocol styles", "REST, gRPC, Kafka, WebSocket, SQL… each moves its own way"),
      t("payloadSamples", "Payload samples", "A sample message rides along the link now and then"),
      n("payloadEvery", "Sample every (s)", 2, 30, 1),
      t("drawnLinks", "Drawn links keep their shape", "A link drawn by hand in the air follows your curve"),
    ],
  },
  {
    id: "table",
    title: "Table and room",
    knobs: [
      t("table", "Holotable"),
      n("tableBrightness", "Table brightness", 0, 3, 0.05),
      n("tableMotion", "Table motion", 0, 4, 0.1, "How fast the rings turn"),
      n("lightColumn", "Light column", 0, 3, 0.1),
      n("dust", "Dust", 0, 3, 0.1),
      t("statusRing", "Progress ring", "The board's progress round the rim"),
      t("grid", "Floor grid"),
      t("stars", "Stars"),
    ],
  },
  {
    id: "camera",
    title: "Camera",
    where: "flat",
    knobs: [
      n("orbitSpeed", "Orbit speed", 0.2, 3, 0.1),
      n("zoomSpeed", "Zoom speed", 0.2, 3, 0.1),
      n("damping", "Damping", 0.01, 0.3, 0.01),
      n("flySeconds", "Flight time", 0.1, 3, 0.1),
      n("fov", "Field of view", 30, 90, 1),
      t("autoRotate", "Turn slowly on its own"),
      n("autoRotateSpeed", "Turn speed", 0.1, 3, 0.1),
    ],
  },
  {
    id: "editing",
    title: "Editing",
    knobs: [
      t("snap", "Snap to grid"),
      n("gridSize", "Grid size", 0.01, 0.3, 0.01),
      t("frameCarries", "Frames carry their contents", "Moving a frame moves what's in it"),
      t("lockItems", "Lock items", "Nothing on the board stays moved: rays, pinches and grips on open air move the board itself, and an item grabbed right at the hand (a pinch or grip on it) can be carried, stretched open or thrown at a wall, then springs back when let go (the voice and Jarvis can still change things)"),
      t("magnet", "Magnetic snapping", "Items line up with their neighbours and stack on each other as you place them"),
      n("magnetReach", "Magnet reach (m)", 0.005, 0.08, 0.005),
      t("magnetGuides", "Alignment guides"),
      n("tierGap", "Tier gap (m)", 0.05, 0.6, 0.01, "How far apart the depth tiers float"),
      t("c4Zoom", "Zoom through levels", "Scale into an item to dive inside it (context → containers → components → code), out to come back"),
      n("morphSeconds", "Dive time", 0.2, 3, 0.1),
    ],
  },
  {
    id: "placement",
    title: "Headset · Placement",
    where: "headset",
    knobs: [
      n("arScale", "Table scale (passthrough)", 0.1, 1.5, 0.01),
      n("arHeight", "Table height", 0.3, 1.4, 0.01),
      n("arDistance", "Table distance", 0.3, 2, 0.05),
      n("vrScale", "Table scale (VR)", 0.1, 2, 0.01),
      n("renderScale", "Sharpness", 0.5, 1.6, 0.05, "Render resolution; lower is faster"),
      n("foveation", "Foveation", 0, 1, 0.05, "Blurrier edges, faster frames"),
    ],
  },
  {
    id: "panels",
    title: "Headset · Panels",
    where: "headset",
    knobs: [
      n("panelScale", "Panel size", 0.5, 2, 0.05),
      n("panelDistance", "Panel distance", 0.3, 1.2, 0.05),
      n("panelDrop", "Panel height below eyes", 0, 0.6, 0.01),
      t("panelFollow", "Panels follow you", "They drift after you when you turn away; grab one to pin it"),
      n("followSpeed", "Follow speed", 0.5, 10, 0.5),
      n("panelOpacity", "Panel opacity", 0.3, 1, 0.05),
      t("captions", "Captions"),
      t("callout", "Inspector beside the item"),
      t("wristMenu", "Wrist menu"),
      t("snapshotThumbs", "Pictures on snapshot cards"),
    ],
  },
  {
    id: "hands",
    title: "Headset · Hands",
    where: "headset",
    knobs: [
      t("rays", "Rays"),
      n("rayBrightness", "Ray brightness", 0, 1, 0.05),
      t("handModels", "Hand models"),
      t("controllerModels", "Controller models"),
      n("grabReach", "Grab reach", 0.02, 0.2, 0.01, "How close a hand has to be to take an item"),
      n("flingSpeed", "Throw-away speed", 1, 6, 0.1, "How hard a throw deletes"),
      t("haptics", "Haptics"),
      t("pinchMovesTable", "Pinch open air to move the table"),
      n("stickSpeed", "Thumbstick speed", 0.2, 4, 0.1),
      n("hapticStrength", "Haptic strength", 0, 1, 0.05),
      c("twoHandMode", "Two hands on one item", ["auto", "scale", "explode"], "Auto: holograms pull apart, the rest stretch. Swap mid-stretch with the other hand's trigger or middle pinch"),
      t("spreadOpens", "Spread to open", "Two hands pulled wide apart on an item with an inside: dive into it"),
      t("crumple", "Crumple to delete", "Close your fist (or squeeze grip and trigger) on an item you're holding"),
      t("flingDeletes", "Throw away to delete"),
      t("pinchToVoice", "Hold to talk about it", "Hold a pinch still on an item: it's selected and the voice listens (move away and it drags after all). A controller's trigger always drags"),
      n("holdToVoiceMs", "Hold time (ms)", 300, 2000, 50),
      t("poke", "Poke panels", "Touch a panel's button with your fingertip"),
    ],
  },
  {
    id: "controls",
    title: "Headset · Controller buttons",
    where: "headset",
    knobs: [
      act("btnA", "A"),
      act("btnAHold", "A held"),
      act("btnB", "B"),
      act("btnBHold", "B held"),
      act("btnX", "X"),
      act("btnXHold", "X held"),
      act("btnY", "Y"),
      act("btnYHold", "Y held"),
      act("btnRStick", "Right stick press", "Held, the command wheel opens around the controller: tilt to a slice, let go"),
      act("btnLStick", "Left stick press"),
      c("rightStick", "Right stick", ["table", "snap-turn", "off"], "Turn and scale the table, or turn it in steps"),
      c("leftStick", "Left stick", ["move", "off"], "Slide the table around the room"),
      t("carryStickTurns", "Stick turns what you hold", "While carrying or dragging: left/right turns it, up/down pushes it away or pulls it in"),
      n("holdMs", "Held press (ms)", 250, 1200, 50),
      t("buttonHints", "Button labels on the controllers"),
      t("actionToasts", "Say what a button did"),
      t("inputDebug", "Show where each trigger press goes", "A chip by the hand naming what took the press: a panel, an item, the table, the room, the shelf…"),
      t("keyboard", "Type with a keyboard", "A Bluetooth keyboard paired to the headset: start typing and a text bar opens (Enter sends, Tab switches, Esc closes)"),
      c("keyboardTarget", "Typing goes to", ["ask", "label", "note"], "Ask Jarvis, the selected item's label, or a new note"),
      c("keyboardLetters", "Letter keys", ["type", "shortcuts"], "Type: letters open the text bar, shortcuts need Ctrl or Alt. Shortcuts: letters are shortcuts, Enter or / opens the bar"),
      t("typingHushesHands", "Hands rest while typing", "Hand pinches, pokes, the palm menu and your gestures pause while keys are pressed"),
      n("typingHandsBackMs", "Hands back after (ms)", 150, 2000, 50, "How soon after the last key the hands work again"),
      t("guideChecks", "Guide waits for you to try it", "The tour moves on when you do each step (Next always works too)"),
      c("guideStart", "Guide when you enter", ["first time", "always", "never"]),
    ],
  },
  {
    id: "wheel",
    title: "Headset · Wheel and palm menu",
    where: "headset",
    knobs: [
      c("palmMenu", "Palm menu", ["right", "left", "off"], "Turn that palm to the ceiling: the wheel blooms from it"),
      act("wheel1", "Wheel · top"),
      act("wheel2", "Wheel · top right"),
      act("wheel3", "Wheel · right"),
      act("wheel4", "Wheel · bottom right"),
      act("wheel5", "Wheel · bottom"),
      act("wheel6", "Wheel · bottom left"),
      act("wheel7", "Wheel · left"),
      act("wheel8", "Wheel · top left"),
      act("leftMiddlePinch", "Left middle pinch"),
      act("rightMiddlePinch", "Right middle pinch"),
      t("customGestures", "Your gestures", "Hand poses you recorded, each doing its action"),
      n("gestureHoldMs", "Gesture hold (ms)", 150, 1500, 50),
      n("gestureTolerance", "Gesture tolerance", 0.05, 0.6, 0.01, "How closely a pose must match the one you recorded"),
    ],
  },
  {
    id: "room",
    title: "Headset · Room",
    where: "headset",
    knobs: [
      t("planes", "Find walls and desks", "Use the room's walls and tables from Space Setup"),
      t("showPlanes", "Show the walls and desks found"),
      t("roomAnchors", "Anchor boards in the room", "Each board stays where you left it, across sessions"),
      t("throwToWall", "Throw to a wall", "Throw a panel or a board card at a wall: it sticks there"),
      n("deskFit", "Desk mode fit", 0.4, 1, 0.05, "How much of the desk the board fills"),
      t("deskShadows", "Shadows on the desk"),
      n("shadowStrength", "Shadow strength", 0, 1, 0.05),
      n("wallScale", "Wall board scale", 0.2, 2, 0.05),
      n("roomScale", "Room scale", 1.5, 8, 0.1, "How big the board gets when you walk inside it"),
      t("shelfOn", "Board shelf"),
      c("shelfSide", "Shelf side", ["left", "right"]),
      n("shelfDistance", "Shelf distance", 0.4, 1.5, 0.05),
      t("autoActivate", "Walk up to a board to use it", "In a room of boards, the one you stand at is the one you edit"),
      n("satelliteDim", "Other boards' brightness", 0.1, 1, 0.05),
    ],
  },
  {
    id: "sound",
    title: "Sound",
    knobs: [
      t("sfx", "Effects"),
      n("sfxVolume", "Effects volume", 0, 1, 0.05),
      t("ambience", "Ambience"),
      n("ambienceVolume", "Ambience volume", 0, 1, 0.05),
      t("hum", "Board hum", "A quiet hum from the board itself, louder as you lean in"),
      n("humVolume", "Hum volume", 0, 1, 0.05),
      t("pitchBySize", "Pitch by size", "Big things sound low, small ones high"),
      t("richSfx", "Layered effects", "Materialise, crumple, whoosh and the rest in full; off for simple clicks"),
    ],
  },
  {
    id: "voice",
    title: "Voice",
    knobs: [
      n("voiceVolume", "Volume", 0, 3, 0.05),
      n("voiceSpeed", "Speaking speed", 0.6, 1.5, 0.05),
      n("eagerness", "Eagerness", 1, 3, 1, "1 waits for you to finish, 3 jumps in"),
      t("interrupt", "You can talk over it"),
      t("echoLoopback", "Echo-cancel its voice", "Plays it through WebRTC so the mic's echo canceller takes it out (else it can hear itself and stop mid-sentence)"),
      t("echoGuard", "Don't hear itself", "While it speaks, the mic only goes through when you're clearly louder than its echo"),
      n("talkOverDb", "Talk-over margin (dB)", 3, 24, 1, "How much louder than its echo you need to be to cut in"),
      n("bargeConfirmMs", "Talk-over confirm (ms)", 0, 1200, 50, "It ducks at once, and stops only if you're still talking after this (or words come through)"),
      n("voicePrebufferMs", "Playback buffer (ms)", 0, 400, 20, "Audio queued before it plays: smooths a patchy connection, adds that much delay"),
      t("transcriptLog", "Transcript log", "Everything said, and what happened (talked over, reconnecting…), on a panel you can pin"),
      n("idleMinutes", "Off after silence (min)", 1, 60, 1),
      t("macros", "Voice macros", "Phrases you taught it that run several things"),
    ],
  },
];

export const DEFAULT_BOARD_TUNE: Record<string, TuneValue> = {
  bloom: true,
  bloomStrength: 0.5,
  bloomRadius: 0.45,
  bloomThreshold: 0.22,
  fill: 1,
  rim: 1,
  edges: 1,
  scanlines: 1,
  flicker: 1,
  itemSize: 1,
  printSeconds: 0.9,
  spinSpeed: 1,
  explodeReach: 1,
  glide: true,
  labels: true,
  labelSize: 1,
  labelBrightness: 1,
  tags: true,
  linkLabels: true,
  linkWidth: 1,
  linkBrightness: 1,
  flowSpeed: 1,
  packets: 1,
  arcHeight: 1,
  arrows: true,
  protocolStyles: true,
  payloadSamples: true,
  payloadEvery: 7,
  drawnLinks: true,
  table: true,
  tableBrightness: 1,
  tableMotion: 1,
  lightColumn: 1,
  dust: 1,
  statusRing: true,
  grid: true,
  stars: true,
  orbitSpeed: 1,
  zoomSpeed: 1,
  damping: 0.08,
  flySeconds: 0.7,
  fov: 50,
  autoRotate: false,
  autoRotateSpeed: 0.5,
  snap: false,
  gridSize: 0.05,
  frameCarries: true,
  lockItems: false,
  insideMarker: true,
  magnet: true,
  magnetReach: 0.025,
  magnetGuides: true,
  tierGap: 0.22,
  c4Zoom: true,
  morphSeconds: 0.9,
  arScale: 0.45,
  arHeight: 0.76,
  arDistance: 0.7,
  vrScale: 0.75,
  renderScale: 1.2,
  foveation: 0.5,
  panelScale: 1,
  panelDistance: 0.6,
  panelDrop: 0.24,
  panelFollow: true,
  followSpeed: 3,
  panelOpacity: 0.92,
  captions: true,
  callout: true,
  wristMenu: true,
  snapshotThumbs: true,
  rays: true,
  rayBrightness: 0.55,
  handModels: true,
  controllerModels: true,
  grabReach: 0.06,
  flingSpeed: 2.4,
  haptics: true,
  pinchMovesTable: true,
  stickSpeed: 1.2,
  hapticStrength: 0.6,
  twoHandMode: "auto",
  spreadOpens: true,
  crumple: true,
  flingDeletes: true,
  pinchToVoice: true,
  holdToVoiceMs: 750,
  poke: true,
  btnA: "palette",
  btnAHold: "shelf",
  btnB: "undo",
  btnBHold: "redo",
  btnX: "voice",
  btnXHold: "dictate",
  btnY: "tune",
  btnYHold: "snapshot",
  btnRStick: "wheel",
  btnLStick: "dock",
  rightStick: "table",
  leftStick: "move",
  carryStickTurns: true,
  holdMs: 450,
  buttonHints: true,
  actionToasts: true,
  inputDebug: false,
  keyboard: true,
  keyboardTarget: "ask",
  keyboardLetters: "type",
  typingHushesHands: true,
  typingHandsBackMs: 450,
  guideChecks: true,
  guideStart: "first time",
  palmMenu: "right",
  wheel1: "voice",
  wheel2: "snapshot",
  wheel3: "redo",
  wheel4: "shelf",
  wheel5: "delete-selection",
  wheel6: "tool-lasso",
  wheel7: "undo",
  wheel8: "code",
  leftMiddlePinch: "voice",
  rightMiddlePinch: "undo",
  customGestures: true,
  gestureHoldMs: 350,
  gestureTolerance: 0.22,
  planes: true,
  showPlanes: false,
  roomAnchors: true,
  throwToWall: true,
  deskFit: 0.85,
  deskShadows: true,
  shadowStrength: 0.45,
  wallScale: 0.6,
  roomScale: 3,
  shelfOn: true,
  shelfSide: "left",
  shelfDistance: 0.7,
  autoActivate: true,
  satelliteDim: 0.55,
  sfx: true,
  sfxVolume: 0.6,
  ambience: true,
  ambienceVolume: 0.4,
  hum: true,
  humVolume: 0.35,
  pitchBySize: true,
  richSfx: true,
  voiceVolume: 1,
  voiceSpeed: 1,
  eagerness: 2,
  interrupt: true,
  echoLoopback: true,
  echoGuard: true,
  talkOverDb: 10,
  bargeConfirmMs: 350,
  voicePrebufferMs: 100,
  transcriptLog: true,
  idleMinutes: 10,
  macros: true,
};

export type BoardTune = typeof DEFAULT_BOARD_TUNE;

export type BoardPreset = { name: string; values: Record<string, TuneValue>; builtIn?: boolean };

export const BUILT_IN_PRESETS: BoardPreset[] = [
  { name: "Stark", values: {}, builtIn: true },
  { name: "Neon", values: { bloomStrength: 0.95, bloomThreshold: 0.12, edges: 1.5, rim: 1.4, flowSpeed: 1.6, packets: 1.6, linkBrightness: 1.4 }, builtIn: true },
  { name: "Calm", values: { bloomStrength: 0.3, flicker: 0, scanlines: 0.4, tableMotion: 0.3, dust: 0.3, flowSpeed: 0.5, lightColumn: 0.4 }, builtIn: true },
  { name: "Readable", values: { labelSize: 1.6, labelBrightness: 1.4, bloomStrength: 0.35, fill: 1.3, flicker: 0.3 }, builtIn: true },
  { name: "Blueprint", values: { bloom: false, fill: 0.4, rim: 0.5, edges: 1.6, scanlines: 0, flicker: 0, dust: 0, lightColumn: 0, tableBrightness: 1.6 }, builtIn: true },
  { name: "Quest performance", values: { bloom: false, dust: 0.3, renderScale: 1, foveation: 0.8, lightColumn: 0.5 }, builtIn: true },
];

export const BOARD_KNOBS = BOARD_SECTIONS.flatMap((s) => s.knobs.map((k) => ({ ...k, section: s.title, default: DEFAULT_BOARD_TUNE[k.key] })));

/** A knob by its key or its label, as said ("bloom strength"). */
export function findBoardKnob(name: string) {
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const p = plain(name);
  return BOARD_KNOBS.find((k) => plain(k.key) === p) ?? BOARD_KNOBS.find((k) => plain(k.label) === p) ?? BOARD_KNOBS.find((k) => plain(k.label).includes(p) || plain(k.key).includes(p));
}

/** A value a knob can take from what was asked: kept to its range and step; an error (as `{ error }`) when it can't be one. */
export function boardKnobValue(k: (typeof BOARD_KNOBS)[number], v: unknown): TuneValue | { error: string } {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "default" || s === "reset") return k.default;
  if ("choices" in k) {
    const plain = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = k.choices.find((x) => plain(x) === plain(s)) ?? k.choices.find((x) => plain(x).includes(plain(s)) && plain(s).length > 1);
    return hit ?? { error: `${k.label} is one of: ${k.choices.join(", ")}.` };
  }
  if ("toggle" in k) {
    if (v === true || ["on", "true", "yes", "1", "show"].includes(s)) return true;
    if (v === false || ["off", "false", "no", "0", "hide"].includes(s)) return false;
    return { error: `${k.label} is on or off.` };
  }
  const x = typeof v === "number" ? v : Number(s);
  if (!Number.isFinite(x)) return { error: `${k.label} takes a number from ${k.min} to ${k.max}.` };
  const c = Math.min(k.max, Math.max(k.min, x));
  return Number((Math.round(c / k.step) * k.step).toFixed(4));
}

/** Only knobs that exist, with values they can take. */
export function cleanTune(values: Record<string, unknown>): Record<string, TuneValue> {
  const out: Record<string, TuneValue> = {};
  for (const [key, v] of Object.entries(values ?? {})) {
    const k = BOARD_KNOBS.find((x) => x.key === key);
    if (!k || (typeof v !== "number" && typeof v !== "boolean" && typeof v !== "string")) continue;
    if (typeof v === "string" && !("choices" in k)) continue;
    const val = boardKnobValue(k, v);
    if (!isKnobError(val)) out[key] = val;
  }
  return out;
}

export const isKnobError = (v: TuneValue | { error: string }): v is { error: string } => typeof v === "object" && v !== null;

/** What differs from the defaults: how a preset keeps its values. */
export function changedTune(values: Record<string, TuneValue>) {
  const out: Record<string, TuneValue> = {};
  for (const k of BOARD_KNOBS) if (k.key in values && values[k.key] !== k.default) out[k.key] = values[k.key];
  return out;
}

/** The knobs in brief, for a model choosing one: every section on a line, values now (marked when changed). */
export function tuneList(values: Record<string, TuneValue>, presets: BoardPreset[]): string {
  return [
    ...BOARD_SECTIONS.map(
      (s) =>
        `${s.title}: ${s.knobs
          .map((k) => {
            const v = values[k.key] ?? DEFAULT_BOARD_TUNE[k.key];
            const range = "toggle" in k ? "on/off" : "choices" in k ? (k.choices === ACTION_IDS ? "an action id" : k.choices.join("/")) : `${k.min}–${k.max}`;
            return `${k.key} (${k.label}, ${range}) = ${typeof v === "boolean" ? (v ? "on" : "off") : v}${v !== DEFAULT_BOARD_TUNE[k.key] ? "*" : ""}`;
          })
          .join("; ")}`,
    ),
    `Action ids (for buttons, wheel slices, gestures): ${ACTION_IDS.join(", ")}.`,
    `Presets: ${presets.map((p) => p.name).join(", ")}.`,
  ].join("\n");
}
