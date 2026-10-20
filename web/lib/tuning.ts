/**
 * Every knob on the map, in one place: the values, their ranges, how they're
 * grouped in the panel, and a few presets. Kept per browser — it's how *you*
 * like to fly, not a property of the repo.
 */

export type Tuning = {
  // Glow
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  // Bodies
  nodeSize: number;
  sizeByLines: number;
  bodyOpacity: number;
  dimOpacity: number;
  beaconSize: number;
  beaconOpacity: number;
  folderPointOpacity: number;
  // Links
  linkOpacity: number;
  folderLinkBrightness: number;
  importBrightness: number;
  importWidth: number;
  runtimeWidth: number;
  curvature: number;
  particles: number;
  particleSpeed: number;
  particleSize: number;
  groupSpokes: number;
  groupBeaconSize: number;
  // Layout
  repulsion: number;
  folderPull: number;
  folderDistance: number;
  importPull: number;
  importDistance: number;
  clusterTightness: number;
  clusterDistance: number;
  clusterSeparation: number;
  runtimePull: number;
  runtimeDistance: number;
  friction: number;
  settleSeconds: number;
  freeze: boolean;
  // Camera
  rotateSpeed: number;
  zoomSpeed: number;
  panSpeed: number;
  damping: number;
  zoomToCursor: boolean;
  flySeconds: number;
  focusDistance: number;
  autoRotate: boolean;
  autoRotateSpeed: number;
  autoRefit: boolean;
  // Labels
  labelSize: number;
  folderLabelDepth: number;
  fileLabelLimit: number;
  showBeaconLabels: boolean;
  // Background
  starOpacity: number;
  starSize: number;
  showCourse: boolean;
  courseOpacity: number;
  haloSize: number;
};

export const DEFAULT_TUNING: Tuning = {
  bloomStrength: 0.62,
  bloomRadius: 0.22,
  bloomThreshold: 0.2,
  nodeSize: 1,
  sizeByLines: 1,
  bodyOpacity: 0.88,
  dimOpacity: 0.08,
  beaconSize: 1,
  beaconOpacity: 0.32,
  folderPointOpacity: 0.7,
  linkOpacity: 0.55,
  folderLinkBrightness: 0.5,
  importBrightness: 0.5,
  importWidth: 0.5,
  runtimeWidth: 1.2,
  curvature: 0.28,
  particles: 3,
  particleSpeed: 1,
  particleSize: 1,
  groupSpokes: 0.22,
  groupBeaconSize: 1,
  repulsion: 26,
  folderPull: 0.9,
  folderDistance: 14,
  importPull: 0.08,
  importDistance: 36,
  clusterTightness: 0.55,
  clusterDistance: 16,
  clusterSeparation: 520,
  runtimePull: 0.01,
  runtimeDistance: 140,
  friction: 0.4,
  settleSeconds: 14,
  freeze: false,
  rotateSpeed: 1,
  zoomSpeed: 1.6,
  panSpeed: 1.1,
  damping: 0.12,
  zoomToCursor: true,
  flySeconds: 1.6,
  focusDistance: 1,
  autoRotate: true,
  autoRotateSpeed: 0.35,
  autoRefit: true,
  labelSize: 1,
  folderLabelDepth: 1,
  fileLabelLimit: 36,
  showBeaconLabels: true,
  starOpacity: 0.55,
  starSize: 2.2,
  showCourse: true,
  courseOpacity: 0.9,
  haloSize: 1,
};

/** Knobs whose change means rebuilding the 3D objects rather than nudging them. */
export const SHAPE_KNOBS: (keyof Tuning)[] = ["nodeSize", "sizeByLines", "beaconSize", "labelSize", "folderLabelDepth"];
/** Knobs that change the forces, so the layout is reheated to show the effect. */
export const FORCE_KNOBS: (keyof Tuning)[] = [
  "repulsion", "folderPull", "folderDistance", "importPull", "importDistance",
  "clusterTightness", "clusterDistance", "clusterSeparation", "runtimePull", "runtimeDistance",
];

type Range = { key: keyof Tuning; label: string; min: number; max: number; step: number; hint?: string };
type Toggle = { key: keyof Tuning; label: string; toggle: true; hint?: string };
export type Knob = Range | Toggle;
export type Section = { id: string; title: string; knobs: Knob[] };

const r = (key: keyof Tuning, label: string, min: number, max: number, step: number, hint?: string): Range => ({ key, label, min, max, step, hint });
const t = (key: keyof Tuning, label: string, hint?: string): Toggle => ({ key, label, toggle: true, hint });

export const SECTIONS: Section[] = [
  {
    id: "glow",
    title: "Glow",
    knobs: [
      r("bloomStrength", "Bloom strength", 0, 2.5, 0.01, "How much bright things glow"),
      r("bloomRadius", "Bloom spread", 0, 1, 0.01, "How far the glow bleeds; high values haze the sky"),
      r("bloomThreshold", "Bloom threshold", 0, 1, 0.01, "Only things brighter than this glow"),
    ],
  },
  {
    id: "bodies",
    title: "Bodies",
    knobs: [
      r("nodeSize", "File size", 0.3, 3, 0.05),
      r("sizeByLines", "Size by length", 0, 2, 0.05, "0 makes every file the same size"),
      r("bodyOpacity", "File brightness", 0.2, 1, 0.01),
      r("dimOpacity", "Dimmed files", 0, 0.6, 0.01, "Files outside the focus"),
      r("beaconSize", "Beacon size", 0.3, 3, 0.05, "Module and group beacons"),
      r("beaconOpacity", "Beacon brightness", 0.05, 1, 0.01),
      r("folderPointOpacity", "Folder points", 0, 1, 0.01),
    ],
  },
  {
    id: "links",
    title: "Links",
    knobs: [
      r("linkOpacity", "Line opacity", 0, 1, 0.01),
      r("folderLinkBrightness", "Folder lines", 0, 1, 0.01, "The scaffolding between folders and files"),
      r("importBrightness", "Import lines", 0, 1, 0.01, "Resting brightness of the import layer"),
      r("importWidth", "Focused import width", 0, 3, 0.05),
      r("runtimeWidth", "Runtime link width", 0, 4, 0.05),
      r("curvature", "Runtime arc", 0, 1, 0.01),
      r("particles", "Particles per link", 0, 8, 1),
      r("particleSpeed", "Particle speed", 0.1, 4, 0.05),
      r("particleSize", "Particle size", 0.2, 4, 0.05),
      r("groupSpokes", "Group spokes", 0, 1, 0.01, "Lines from a marked group's beacon to its files"),
      r("groupBeaconSize", "Group beacon size", 0.3, 3, 0.05),
    ],
  },
  {
    id: "layout",
    title: "Layout forces",
    knobs: [
      r("repulsion", "Repulsion", 0, 200, 1, "How hard every body pushes the others away"),
      r("folderPull", "Folder pull", 0, 1, 0.01, "How tightly files hold to their folder"),
      r("folderDistance", "Folder spacing", 2, 80, 1),
      r("importPull", "Import pull", 0, 1, 0.01, "How much imports drag files together"),
      r("importDistance", "Import length", 5, 200, 1),
      r("clusterTightness", "Group tightness", 0, 1, 0.01, "When organized by groups"),
      r("clusterDistance", "Group radius", 2, 120, 1),
      r("clusterSeparation", "Group separation", 0, 4000, 10, "How far groups push apart"),
      r("runtimePull", "Runtime pull", 0, 0.3, 0.005, "Whether runtime links drag modules together"),
      r("runtimeDistance", "Runtime length", 20, 600, 5),
      r("friction", "Friction", 0.05, 0.9, 0.01, "Low keeps things drifting; high settles fast"),
      r("settleSeconds", "Settle time (s)", 2, 60, 1),
      t("freeze", "Freeze layout", "Stop the simulation where it is"),
    ],
  },
  {
    id: "camera",
    title: "Camera and motion",
    knobs: [
      r("rotateSpeed", "Orbit speed", 0.1, 3, 0.05),
      r("zoomSpeed", "Zoom speed", 0.2, 5, 0.05),
      r("panSpeed", "Pan speed", 0.2, 4, 0.05),
      r("damping", "Glide", 0.02, 0.5, 0.01, "Lower glides longer after you let go"),
      t("zoomToCursor", "Zoom toward pointer"),
      r("flySeconds", "Flight time (s)", 0.2, 5, 0.1),
      r("focusDistance", "Focus distance", 0.3, 3, 0.05, "How close flights stop"),
      t("autoRotate", "Drift in overview"),
      r("autoRotateSpeed", "Drift speed", 0.05, 3, 0.05),
      t("autoRefit", "Refit after regrouping"),
    ],
  },
  {
    id: "labels",
    title: "Labels",
    knobs: [
      r("labelSize", "Label size", 0.4, 3, 0.05),
      r("folderLabelDepth", "Folder label depth", -1, 4, 1, "-1 hides them; 0 is top-level only"),
      r("fileLabelLimit", "File labels in focus", 0, 200, 1, "Name files only when the focus is this small"),
      t("showBeaconLabels", "Beacon names"),
    ],
  },
  {
    id: "background",
    title: "Background and course",
    knobs: [
      r("starOpacity", "Stars", 0, 1, 0.01),
      r("starSize", "Star size", 0.5, 6, 0.1),
      t("showCourse", "Show course line", "The dashed magenta trail of where you've flown"),
      r("courseOpacity", "Course brightness", 0, 1, 0.01),
      r("haloSize", "Open-file halo", 0, 3, 0.05),
    ],
  },
];

export const PRESETS: { id: string; title: string; patch: Partial<Tuning> }[] = [
  { id: "default", title: "Default", patch: {} },
  {
    id: "neon",
    title: "Neon",
    patch: { bloomStrength: 1.5, bloomRadius: 0.45, bloomThreshold: 0.08, particles: 5, particleSize: 1.6, runtimeWidth: 1.8, importBrightness: 0.8 },
  },
  {
    id: "calm",
    title: "Calm",
    patch: { bloomStrength: 0.25, particles: 0, autoRotate: false, starOpacity: 0.25, nodeSize: 0.85, linkOpacity: 0.35, flySeconds: 2.4 },
  },
  {
    id: "spread",
    title: "Spread out",
    patch: { repulsion: 90, folderDistance: 30, importDistance: 80, clusterSeparation: 1800, clusterDistance: 34, runtimeDistance: 260 },
  },
  {
    id: "dense",
    title: "Dense",
    patch: { repulsion: 9, folderDistance: 7, importDistance: 18, clusterSeparation: 220, clusterDistance: 9, nodeSize: 0.75 },
  },
  {
    id: "flat",
    title: "No glow",
    patch: { bloomStrength: 0, bodyOpacity: 1, starOpacity: 0.3, particles: 0 },
  },
];

const KEY = "codeflight.tuning";

export function loadTuning(): Tuning {
  try {
    // Merged over the defaults, so a knob added later doesn't come back undefined.
    return { ...DEFAULT_TUNING, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Tuning>) };
  } catch {
    return DEFAULT_TUNING;
  }
}

export function saveTuning(t: Tuning) {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* private mode: the knobs just don't persist */
  }
}
