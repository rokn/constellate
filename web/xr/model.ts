import type { Activity, AgentRun, Frame, Layer, LibraryRepo, MapFilter, Overview, SavedFilter, Story } from "../../shared/types";
import type { FileData } from "../lib/api";
import type { Tuning } from "../lib/tuning";
import type { XRSettings } from "../lib/xrSettings";
import type { Stage } from "../lib/story";
import type { VoiceState } from "../lib/useVoice";
import type { Mode } from "./engine";
import type { MapHit } from "./map";

export type KeyboardMode = "ask" | "note" | "repo" | "include" | "exclude" | "agent" | "view";

/**
 * What the headset's panels show, in one object. The desktop app (App.tsx)
 * owns all of it — the same state its own panels show — and hands it over on
 * every change; the room only paints it and calls back through Actions. So
 * taking the headset off or putting it on never loses your place.
 */

export type LegendRow = { id: string; label: string; color?: string; count: number; isolated?: "in" | "out" };

export type Model = {
  status: string;
  error?: string;
  repoName?: string;
  headline?: string;
  library: boolean;
  locked: boolean;
  busy: boolean;
  activity: Activity[];
  overview?: Overview;
  frames: Frame[];
  frameId: string | null;
  pointer: { viewId?: string; nodeIds?: string[]; lines?: number[] } | null;
  file: { path: string; line?: number; endLine?: number } | null;
  fileData: FileData | null;
  /** The desktop's Intro card: shown until you've asked, opened or toured something. */
  intro: boolean;
  voice: { available: boolean; state: VoiceState; caption: string; heard: string; error: string | null };
  tour: { index: number; total: number; label: string; summary: string } | null;
  toast: { text: string; undo?: () => void } | null;
  layers: Record<Layer, boolean>;
  lensId: string;
  lenses: { id: string; title: string }[];
  legend: { kind: "dir" | "module"; rows: LegendRow[] };
  visibleCount: number;
  totalCount: number;
  filter: { active: boolean; label?: string; hideTests: boolean; hideDocs: boolean };
  /** The whole filter, as the desktop's Filter panel edits it. */
  mapFilter: MapFilter;
  savedFilters: SavedFilter[];
  /** The repo's languages and top-level folders, most files first: the filter's chips. */
  langs: string[];
  tops: { id: string; count: number }[];
  stories: Story[];
  /** Coding agents, and whether this server lets you start them. */
  agents: AgentRun[];
  agentsOn: boolean;
  story: { story: Story; beat: number; ms: number; playing: boolean; stage: Stage } | null;
  repos: LibraryRepo[];
  mode: Mode;
  canVR: boolean;
  canAR: boolean;
  placing: boolean;
  menuOpen: boolean;
  keyboard: { mode: KeyboardMode; target?: string; initial?: string } | null;
  /** The desktop's map knobs, the same object its Tune panel edits. */
  tuning: Tuning;
  settings: XRSettings;
  tuneOpen: boolean;
  hintsOpen: boolean;
  filterOpen: boolean;
  /** The saved views panel, away from a table (on one, it lies along the left edge). */
  viewsOpen: boolean;
  /** On a real table (passthrough, placed): its menu and shelf are out. */
  table: boolean;
  /** What you're holding: the controls page lists what these can do. */
  inputs: { hands: boolean; controllers: boolean };
  /** A focus made from the headset: a body, and how many rings of its connections are lit. */
  focus: { label: string; depth: number; count: number; more: boolean; only: boolean } | null;
};

export type Jump = { kind: "file" | "module" | "symbol"; label: string; detail?: string; path?: string; id?: string; line?: number };

export type Actions = {
  openFile: (path: string, line?: number, endLine?: number) => void;
  focusModule: (id: string) => void;
  isolate: (id: string, how: "solo" | "isolate" | "exclude") => void;
  overview: () => void;
  back: () => void;
  forward: () => void;
  frameSelection: () => void;
  showFrame: (id: string) => void;
  closeFrame: () => void;
  closeFile: () => void;
  ask: (text: string, topicId?: string) => void;
  interrupt: () => void;
  toggleVoice: () => void;
  setLayer: (l: Layer, on: boolean) => void;
  setLens: (id: string) => void;
  setFilter: (patch: { hideTests?: boolean; hideDocs?: boolean }) => void;
  clearFilter: () => void;
  hide: (path: string) => void;
  startTour: () => void;
  stopTour: () => void;
  playStory: (id: string) => void;
  storyToggle: () => void;
  storySeek: (beat: number) => void;
  closeStory: () => void;
  writeStory: (request: string) => void;
  openKeyboard: (mode: KeyboardMode, target?: string, initial?: string) => void;
  closeKeyboard: () => void;
  submitKeyboard: (text: string) => void;
  suggest: (q: string) => Jump[];
  jump: (j: Jump) => void;
  toggleMenu: () => void;
  enter: (m: "vr" | "ar") => void;
  exitXR: () => void;
  /** Reload the page, and go back into the headset after if the browser allows it. */
  reload: () => void;
  placeMap: () => void;
  recenterPanels: () => void;
  toggleTune: () => void;
  toggleHints: () => void;
  /** Merged into the desktop's tuning (a whole Tuning replaces it: presets, reset). */
  setTuning: (patch: Partial<Tuning>) => void;
  setXR: (patch: Partial<XRSettings>) => void;
  relayout: () => void;
  toggleFilter: () => void;
  /** Replace the whole filter. */
  setMapFilter: (f: MapFilter) => void;
  /** Replace the saved views (the desktop's Filter panel keeps the same list). */
  setSavedFilters: (list: SavedFilter[]) => void;
  toggleViews: () => void;
  /**
   * Light a body (a file, a module's files, a folder's) and `depth` rings of
   * its import neighbours; fly there. Says what it lit, and whether there's a
   * further ring.
   */
  focusAround: (hit: MapHit, depth: number) => { label: string; count: number; more: boolean; paths: string[]; core: string[] };
  focusWider: () => void;
  focusNarrower: () => void;
  /** Show only what the focus lights, or, when that's on, the map as it was. */
  focusOnly: () => void;
  /** Throw something off the map (a fling): it's hidden, with an undo. */
  hideHit: (hit: MapHit) => void;
  openRepo: (id: string) => void;
  reanalyze: () => void;
  startAgent: (task: string) => void;
  /** Light up these files and fly there (a lasso or a frame made by hand), under this name. */
  focusPaths: (paths: string[], label: string) => void;
  /** Light up an agent's files and fly there. */
  focusAgent: (id: string) => void;
  agentAction: (id: string, action: "stop" | "pr" | "merge" | "rebase") => void;
  isFile: (p: string) => boolean;
};

/** What the desktop app provides; the rest of the model is the headset's own (useXR fills it in). */
export type AppModel = Omit<Model, "fileData" | "story" | "repos" | "mode" | "canVR" | "canAR" | "placing" | "menuOpen" | "keyboard" | "tuneOpen" | "hintsOpen" | "filterOpen" | "viewsOpen" | "focus" | "table" | "inputs">;

/** The headset's own actions (menu, keyboard, sessions) are useXR's; the rest are the desktop's. */
export type AppActions = Omit<
  Actions,
  | "toggleMenu"
  | "openKeyboard"
  | "closeKeyboard"
  | "submitKeyboard"
  | "suggest"
  | "jump"
  | "enter"
  | "exitXR"
  | "reload"
  | "placeMap"
  | "recenterPanels"
  | "toggleTune"
  | "toggleHints"
  | "relayout"
  | "toggleFilter"
  | "toggleViews"
  | "focusWider"
  | "focusNarrower"
  | "focusOnly"
> & {
  addNote: (path: string, text: string) => void;
  /** A local path, or on a server that keeps GitHub repos, owner/name. */
  openPath: (text: string) => void;
};
