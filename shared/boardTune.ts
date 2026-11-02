/**
 * Every knob in the workshop, in one place: how it looks (glow, holograms,
 * labels, links, the table), how it moves (camera, editing), and the
 * headset's own settings (placement, panels, hands, sound, voice). Kept per
 * browser, like the map's Tune: it's how *you* like to work. Presets — the
 * built-in looks and the ones you save — are kept on the server.
 *
 * The voice and Jarvis turn the same knobs by key (see server/board/tune.ts).
 */

export type BoardKnob = { key: string; label: string; hint?: string } & ({ toggle: true } | { min: number; max: number; step: number });
export type BoardSection = { id: string; title: string; knobs: BoardKnob[]; where?: "headset" | "flat" | "both" };

const n = (key: string, label: string, min: number, max: number, step: number, hint?: string): BoardKnob => ({ key, label, min, max, step, hint });
const t = (key: string, label: string, hint?: string): BoardKnob => ({ key, label, toggle: true, hint });

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
    knobs: [t("labels", "Labels"), n("labelSize", "Label size", 0.4, 2.5, 0.05), n("labelBrightness", "Label brightness", 0.2, 2, 0.05), t("tags", "Tags under labels"), t("linkLabels", "Link labels")],
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
    knobs: [t("snap", "Snap to grid"), n("gridSize", "Grid size", 0.01, 0.3, 0.01), t("frameCarries", "Frames carry their contents", "Moving a frame moves what's in it")],
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
    ],
  },
  {
    id: "sound",
    title: "Sound",
    knobs: [t("sfx", "Effects"), n("sfxVolume", "Effects volume", 0, 1, 0.05), t("ambience", "Ambience"), n("ambienceVolume", "Ambience volume", 0, 1, 0.05)],
  },
  {
    id: "voice",
    title: "Voice",
    knobs: [
      n("voiceVolume", "Volume", 0, 3, 0.05),
      n("voiceSpeed", "Speaking speed", 0.6, 1.5, 0.05),
      n("eagerness", "Eagerness", 1, 3, 1, "1 waits for you to finish, 3 jumps in"),
      t("interrupt", "You can talk over it"),
      n("idleMinutes", "Off after silence (min)", 1, 60, 1),
    ],
  },
];

export const DEFAULT_BOARD_TUNE: Record<string, number | boolean> = {
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
  rays: true,
  rayBrightness: 0.55,
  handModels: true,
  controllerModels: true,
  grabReach: 0.06,
  flingSpeed: 2.4,
  haptics: true,
  pinchMovesTable: true,
  stickSpeed: 1.2,
  sfx: true,
  sfxVolume: 0.6,
  ambience: true,
  ambienceVolume: 0.4,
  voiceVolume: 1,
  voiceSpeed: 1,
  eagerness: 2,
  interrupt: true,
  idleMinutes: 10,
};

export type BoardTune = typeof DEFAULT_BOARD_TUNE;

export type BoardPreset = { name: string; values: Record<string, number | boolean>; builtIn?: boolean };

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

/** A value a knob can take from what was asked: kept to its range and step; a string when it can't be one. */
export function boardKnobValue(k: (typeof BOARD_KNOBS)[number], v: unknown): number | boolean | string {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "default" || s === "reset") return k.default;
  if ("toggle" in k) {
    if (v === true || ["on", "true", "yes", "1", "show"].includes(s)) return true;
    if (v === false || ["off", "false", "no", "0", "hide"].includes(s)) return false;
    return `${k.label} is on or off.`;
  }
  const x = typeof v === "number" ? v : Number(s);
  if (!Number.isFinite(x)) return `${k.label} takes a number from ${k.min} to ${k.max}.`;
  const c = Math.min(k.max, Math.max(k.min, x));
  return Number((Math.round(c / k.step) * k.step).toFixed(4));
}

/** Only knobs that exist, with values they can take. */
export function cleanTune(values: Record<string, unknown>): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [key, v] of Object.entries(values ?? {})) {
    const k = BOARD_KNOBS.find((x) => x.key === key);
    if (!k || (typeof v !== "number" && typeof v !== "boolean")) continue;
    const val = boardKnobValue(k, v);
    if (typeof val !== "string") out[key] = val;
  }
  return out;
}

/** What differs from the defaults: how a preset keeps its values. */
export function changedTune(values: Record<string, number | boolean>) {
  const out: Record<string, number | boolean> = {};
  for (const k of BOARD_KNOBS) if (k.key in values && values[k.key] !== k.default) out[k.key] = values[k.key];
  return out;
}

/** The knobs in brief, for a model choosing one: every section on a line, values now (marked when changed). */
export function tuneList(values: Record<string, number | boolean>, presets: BoardPreset[]): string {
  return [
    ...BOARD_SECTIONS.map(
      (s) =>
        `${s.title}: ${s.knobs
          .map((k) => {
            const v = values[k.key] ?? DEFAULT_BOARD_TUNE[k.key];
            const range = "toggle" in k ? "on/off" : `${k.min}–${k.max}`;
            return `${k.key} (${k.label}, ${range}) = ${typeof v === "boolean" ? (v ? "on" : "off") : v}${v !== DEFAULT_BOARD_TUNE[k.key] ? "*" : ""}`;
          })
          .join("; ")}`,
    ),
    `Presets: ${presets.map((p) => p.name).join(", ")}.`,
  ].join("\n");
}
