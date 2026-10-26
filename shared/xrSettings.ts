/**
 * The headset's own knobs: how the room looks and feels around the map, as
 * opposed to the map itself (that's tuning.ts, shared with the desktop). Kept
 * per browser, like the tuning: it's how *you* like to stand in it.
 */

export type XRSettings = {
  // Sight
  /** Multiplies the headset's recommended resolution. Takes effect the next time you go in. */
  renderScale: number;
  /** Fixed foveation: 0 is sharp to the edges, 1 saves the most GPU. */
  foveation: number;
  /** The desktop's bloom pass, drawn in the headset too. Off falls back to a cheap per-body glow. */
  bloom: boolean;
  /** The cheap glow around each body, with or without bloom. */
  bodyGlow: number;
  // Passthrough
  /** How much of your room shows through in passthrough: 0 is the night sky, 1 is the room. */
  passthrough: number;
  /** Stars in passthrough, faded with the room. */
  arStars: boolean;
  // Floor
  floor: boolean;
  floorOpacity: number;
  floorSize: number;
  floorInAR: boolean;
  /** A faint disc where the map is set down: the table you placed it on in passthrough, in front of you otherwise. */
  table: boolean;
  tableOpacity: number;
  // Comfort
  flySpeed: number;
  /** The left stick pushes the map around instead of flying you through it. */
  stickMovesMap: boolean;
  /** Fly toward where your head looks, not where the controller points. */
  flyWhereLooking: boolean;
  /** Turn about yourself instead of about the middle of what you're looking at. */
  turnAroundMe: boolean;
  /** In passthrough, once the map is set on a surface, flights keep it there instead of bringing it to you. */
  keepOnSurface: boolean;
  /** Fling a held body away to hide it. */
  flick: boolean;
  /** How fast (m/s, at the end of a metre-long ray) a fling must be. */
  flickSpeed: number;
  /** Fling a carried panel away to close it. */
  flickPanels: boolean;
  scaleSpeed: number;
  snapTurn: number;
  smoothTurn: boolean;
  turnSpeed: number;
  /** The dock turns with you once you look well away from it. */
  dockFollows: boolean;
  panelDistance: number;
  // Hands
  /** Draw the tracked hands (passthrough shows your real ones anyway). */
  handModels: boolean;
  /** Draw the controllers. */
  controllerModels: boolean;
  // Sound
  voiceVolume: number;
  /** Small sounds for what your hands do: presses, picks, snaps, throws. */
  sfx: boolean;
  sfxVolume: number;
  /** A quiet pad under the map, and now and then a chime from one of its bodies. */
  ambience: boolean;
  ambienceVolume: number;
  // Hints
  hintsSeen: boolean;
};

export const DEFAULT_XR: XRSettings = {
  renderScale: 1.25,
  foveation: 0.1,
  bloom: true,
  bodyGlow: 0.35,
  passthrough: 1,
  arStars: false,
  floor: true,
  floorOpacity: 0.5,
  floorSize: 8,
  floorInAR: false,
  table: true,
  tableOpacity: 0.6,
  flySpeed: 1,
  stickMovesMap: false,
  flyWhereLooking: false,
  turnAroundMe: false,
  keepOnSurface: true,
  flick: true,
  flickSpeed: 3,
  flickPanels: true,
  scaleSpeed: 1,
  snapTurn: 30,
  smoothTurn: false,
  turnSpeed: 1,
  dockFollows: false,
  panelDistance: 1,
  handModels: true,
  controllerModels: true,
  voiceVolume: 1,
  sfx: true,
  sfxVolume: 0.6,
  ambience: true,
  ambienceVolume: 0.5,
  hintsSeen: false,
};

type Range = { key: keyof XRSettings; label: string; min: number; max: number; step: number; hint?: string };
type Toggle = { key: keyof XRSettings; label: string; toggle: true; hint?: string };
export type XRKnob = Range | Toggle;
export type XRSection = { id: string; title: string; knobs: XRKnob[] };

const r = (key: keyof XRSettings, label: string, min: number, max: number, step: number, hint?: string): Range => ({ key, label, min, max, step, hint });
const t = (key: keyof XRSettings, label: string, hint?: string): Toggle => ({ key, label, toggle: true, hint });

export const XR_SECTIONS: XRSection[] = [
  {
    id: "sight",
    title: "Headset · Sight",
    knobs: [
      r("renderScale", "Render resolution", 0.6, 2, 0.05, "Of the headset's recommended size. Higher is sharper and costs frames; applies next time you go in"),
      r("foveation", "Foveation", 0, 1, 0.05, "Lowers resolution at the edges of your view to save GPU"),
      t("bloom", "Bloom", "The desktop's glow pass. Off is cheaper"),
      r("bodyGlow", "Body halo", 0, 1.5, 0.05, "A soft halo drawn around each lit body"),
    ],
  },
  {
    id: "passthrough",
    title: "Headset · Passthrough",
    knobs: [
      r("passthrough", "Passthrough amount", 0, 1, 0.01, "How much of your room shows: 0 is the night sky, 1 is the room as it is"),
      t("arStars", "Stars in passthrough", "Fade the starfield in as the room fades out"),
      t("floorInAR", "Floor grid in passthrough"),
    ],
  },
  {
    id: "floor",
    title: "Headset · Floor",
    knobs: [
      t("floor", "Floor in VR", "A grid where your real floor is, so the sky has somewhere to stand"),
      r("floorOpacity", "Floor brightness", 0.05, 1, 0.01),
      r("floorSize", "Floor size (m)", 2, 30, 0.5),
      t("table", "Table under the map", "Where the map is set down: the surface you placed it on in passthrough, in front of you otherwise"),
      r("tableOpacity", "Table brightness", 0.05, 1, 0.01),
    ],
  },
  {
    id: "comfort",
    title: "Headset · Moving",
    knobs: [
      r("flySpeed", "Fly speed", 0.2, 5, 0.05, "Left stick"),
      t("stickMovesMap", "Stick moves the map", "Push the map around with the left stick, instead of flying through it"),
      t("flyWhereLooking", "Fly where you look", "The left stick flies toward where your head faces, not where the controller points"),
      r("scaleSpeed", "Zoom speed", 0.2, 5, 0.05, "Right stick up and down"),
      t("smoothTurn", "Smooth turn", "Right stick turns continuously instead of in steps"),
      r("snapTurn", "Snap turn (°)", 10, 90, 5),
      r("turnSpeed", "Smooth turn speed", 0.2, 4, 0.05),
      t("turnAroundMe", "Turn around me", "Off: the right stick turns the map about the middle of what you're looking at"),
      t("keepOnSurface", "Stay on the surface", "In passthrough, after placing the map, focusing keeps it on the table instead of bringing it to you"),
      t("flick", "Fling to hide", "Throw a held body away to hide it from the map"),
      r("flickSpeed", "Fling speed", 1, 8, 0.1, "How hard a throw has to be"),
      t("flickPanels", "Fling panels to close", "Throw a carried panel away and let go: it closes"),
      t("dockFollows", "Dock follows you", "The bar under your gaze turns with you. Off, it stays where you put it"),
      r("panelDistance", "Panel distance", 0.6, 2, 0.05, "How far panels open from you"),
    ],
  },
  {
    id: "hands",
    title: "Headset · Hands",
    knobs: [
      t("handModels", "Hand models", "Draw your tracked hands. In passthrough you see your real ones anyway"),
      t("controllerModels", "Controller models", "Draw the controllers in your hands"),
    ],
  },
  {
    id: "sound",
    title: "Headset · Sound",
    knobs: [
      r("voiceVolume", "Voice volume", 0, 3, 0.05, "The voice and story narration"),
      t("sfx", "Sound effects", "Presses, picks, panels snapping down, bodies thrown away"),
      r("sfxVolume", "Effects volume", 0, 1.5, 0.05),
      t("ambience", "Ambience", "A quiet hum under the map, and now and then a chime from one of its bodies"),
      r("ambienceVolume", "Ambience volume", 0, 1.5, 0.05),
    ],
  },
];
