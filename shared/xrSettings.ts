/**
 * The headset's own knobs: how the room looks and feels around the map, as
 * opposed to the map itself (that's tuning.ts, shared with the desktop), and
 * the controls: which gestures are on and how they read, in the headset and
 * on a touchscreen, and the voice. Kept per browser, not per repo, like the
 * tuning: it's how *you* like to stand in it and move.
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
  /** How far (cm) to pull a panel picked up off a wall back toward you before it comes off; till then it slides along the wall. 0: it comes straight off. */
  wallYank: number;
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
  // Gestures (tracked hands)
  /** A pinch held still on open sky draws a lasso round what to light up. */
  lasso: boolean;
  /** How long (ms) the pinch is held still before it lassos instead of moving the map. */
  lassoHold: number;
  /** How far (cm) a pinch or trigger moves before it drags instead of picking (and before a held pinch stops counting as still). */
  dragSlop: number;
  /** Thumb on the middle finger: back (left hand) and forward (right hand). */
  middlePinch: boolean;
  /** How close (cm) the thumb and middle fingertips come for it to count. */
  middlePinchGap: number;
  /** Left palm up opens the wrist menu. */
  wristMenu: boolean;
  /** How long (ms) the palm is held up before the menu shows. */
  wristMenuHold: number;
  /** Two Ls framing part of the map light up what's inside. */
  framing: boolean;
  /** How long (ms) the frame is held before it picks. */
  framingHold: number;
  /** The index fingertip presses panels like a touchscreen. */
  pokePanels: boolean;
  /** A pointing fingertip touching a body picks it. */
  pokeBodies: boolean;
  /** Two hands on the map turn it as well as scale it. */
  twoHandRotate: boolean;
  // Controllers
  haptics: boolean;
  hapticStrength: number;
  /** How far a stick goes before it does anything. */
  stickDeadzone: number;
  // Touch (tablets and phones, outside the headset)
  /** How long (ms) a finger is held still for the ring menu. */
  touchHold: number;
  /** Double-tap open sky for the whole map. */
  doubleTap: boolean;
  /** Spread two fingers on a module's beacon to open it, pinch them to close it. */
  spreadOpens: boolean;
  /** How far apart (× where they started) the fingers spread to open a module. */
  spreadOpenAt: number;
  /** How close (× where they started) they pinch to close it. */
  pinchCloseAt: number;
  /** Twist two fingers to turn the map. */
  twist: boolean;
  /** Three-finger swipes: sideways back and forward, down the whole map, up hides the controls. */
  threeFingerSwipes: boolean;
  /** How far (px) a three-finger swipe travels to count. */
  swipeDistance: number;
  /** How much the view turns as you tilt the tablet, with Tilt to look on. */
  tiltSpeed: number;
  /** Laying the tablet flat shows the map from above. */
  layFlat: boolean;
  // Voice
  voiceVolume: number;
  /** Minutes without hearing you before the voice turns itself off. */
  voiceIdleMinutes: number;
  // Sound
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
  wallYank: 20,
  scaleSpeed: 1,
  snapTurn: 30,
  smoothTurn: false,
  turnSpeed: 1,
  dockFollows: false,
  panelDistance: 1,
  handModels: true,
  controllerModels: true,
  lasso: true,
  lassoHold: 450,
  dragSlop: 3.5,
  middlePinch: true,
  middlePinchGap: 1.8,
  wristMenu: true,
  wristMenuHold: 220,
  framing: true,
  framingHold: 350,
  pokePanels: true,
  pokeBodies: true,
  twoHandRotate: true,
  haptics: true,
  hapticStrength: 1,
  stickDeadzone: 0.18,
  touchHold: 480,
  doubleTap: true,
  spreadOpens: true,
  spreadOpenAt: 1.7,
  pinchCloseAt: 0.6,
  twist: true,
  threeFingerSwipes: true,
  swipeDistance: 70,
  tiltSpeed: 1,
  layFlat: true,
  voiceVolume: 1,
  voiceIdleMinutes: 10,
  sfx: true,
  sfxVolume: 0.6,
  ambience: true,
  ambienceVolume: 0.5,
  hintsSeen: false,
};

type Range = { key: keyof XRSettings; label: string; min: number; max: number; step: number; hint?: string };
type Toggle = { key: keyof XRSettings; label: string; toggle: true; hint?: string };
export type XRKnob = Range | Toggle;
/**
 * Where a section is shown: in the headset's Tune panel (the default), in the
 * desktop's ("flat": a touchscreen's gestures), or both (the voice).
 */
export type XRSection = { id: string; title: string; knobs: XRKnob[]; where?: "headset" | "flat" | "both" };

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
      r("wallYank", "Wall pull-off (cm)", 0, 60, 1, "A panel grabbed on a wall slides along it until you yank it this far back toward you (or jerk it off fast). 0: it comes straight off"),
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
    id: "gestures",
    title: "Headset · Gestures",
    knobs: [
      t("lasso", "Pinch and hold to lasso", "Pinch open sky and hold still, then draw a loop: what's inside lights up. Off: a pinch there only moves the map"),
      r("lassoHold", "Lasso hold (ms)", 150, 1500, 25, "How long to hold the pinch still before it lassos"),
      r("dragSlop", "Drag threshold (cm)", 1, 8, 0.25, "How far a pinch or trigger moves before it drags instead of picking, and before a held pinch stops counting as still"),
      t("twoHandRotate", "Turn with both hands", "Off: pinching with both hands only scales and moves the map, never turns it"),
      t("middlePinch", "Thumb to middle finger", "Right hand: forward · left hand: back"),
      r("middlePinchGap", "Middle pinch closeness (cm)", 0.8, 4, 0.1, "How close the thumb and middle fingertips come to count. Higher is easier to trigger, and to trigger by accident"),
      t("wristMenu", "Wrist menu", "Turn your left palm up to show it"),
      r("wristMenuHold", "Wrist menu hold (ms)", 0, 1000, 20, "How long the palm is held up before the menu shows"),
      t("framing", "Frame with two Ls", "Both hands in an L, framing part of the map: what's inside lights up"),
      r("framingHold", "Frame hold (ms)", 100, 1500, 25, "How long the frame is held before it picks"),
      t("pokePanels", "Fingertip presses panels", "Touch a panel's buttons with your index finger"),
      t("pokeBodies", "Fingertip picks bodies", "Point and touch a body to pick it"),
    ],
  },
  {
    id: "controllers",
    title: "Headset · Controllers",
    knobs: [
      t("haptics", "Vibration", "A buzz in the controller for presses, picks and throws"),
      r("hapticStrength", "Vibration strength", 0.1, 2, 0.05),
      r("stickDeadzone", "Stick dead zone", 0.05, 0.5, 0.01, "How far a stick goes before it moves anything"),
    ],
  },
  {
    id: "touch",
    title: "Touch",
    where: "flat",
    knobs: [
      r("touchHold", "Hold for the ring menu (ms)", 200, 1500, 20, "How long a finger is held still on the map"),
      t("doubleTap", "Double-tap for the whole map", "Double-tap open sky"),
      t("spreadOpens", "Spread to open a module", "Spread two fingers on a module's beacon to open it; pinch them to close it"),
      r("spreadOpenAt", "Spread to open (×)", 1.2, 3, 0.05, "How far apart the fingers end up, against where they started"),
      r("pinchCloseAt", "Pinch to close (×)", 0.2, 0.9, 0.05, "How close together the fingers end up, against where they started"),
      t("twist", "Twist to turn", "Turn two fingers like a dial to turn the map"),
      t("threeFingerSwipes", "Three-finger swipes", "Sideways: back and forward · down: the whole map · up: hide the controls"),
      r("swipeDistance", "Swipe distance (px)", 30, 250, 5),
      r("tiltSpeed", "Tilt to look speed", 0.2, 4, 0.05, "How much the view turns as you tilt the tablet"),
      t("layFlat", "Lay flat to see from above", "Laying the tablet face up on a table shows the map from overhead"),
    ],
  },
  {
    id: "voice",
    title: "Voice",
    where: "both",
    knobs: [
      r("voiceVolume", "Voice volume", 0, 3, 0.05, "The voice and story narration"),
      r("voiceIdleMinutes", "Turn off after (min)", 1, 60, 1, "Minutes without hearing you before the voice turns itself off. It's billed for every second it listens"),
    ],
  },
  {
    id: "sound",
    title: "Headset · Sound",
    knobs: [
      t("sfx", "Sound effects", "Presses, picks, panels snapping down, bodies thrown away"),
      r("sfxVolume", "Effects volume", 0, 1.5, 0.05),
      t("ambience", "Ambience", "A quiet hum under the map, and now and then a chime from one of its bodies"),
      r("ambienceVolume", "Ambience volume", 0, 1.5, 0.05),
    ],
  },
];
