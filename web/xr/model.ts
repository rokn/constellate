import type { Activity, Frame, Layer, LibraryRepo, Overview, Story } from "../../shared/types";
import type { FileData } from "../lib/api";
import type { Stage } from "../lib/story";
import type { VoiceState } from "../lib/useVoice";
import type { Mode } from "./engine";

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
  stories: Story[];
  story: { story: Story; beat: number; ms: number; playing: boolean; stage: Stage } | null;
  repos: LibraryRepo[];
  mode: Mode;
  canVR: boolean;
  canAR: boolean;
  placing: boolean;
  menuOpen: boolean;
  keyboard: { mode: "ask" | "note" | "repo"; target?: string } | null;
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
  openKeyboard: (mode: "ask" | "note" | "repo", target?: string) => void;
  closeKeyboard: () => void;
  submitKeyboard: (text: string) => void;
  suggest: (q: string) => Jump[];
  jump: (j: Jump) => void;
  toggleMenu: () => void;
  enter: (m: "vr" | "ar") => void;
  exitXR: () => void;
  placeMap: () => void;
  recenterPanels: () => void;
  openRepo: (id: string) => void;
  reanalyze: () => void;
  isFile: (p: string) => boolean;
};

/** What the desktop app provides; the rest of the model is the headset's own (useXR fills it in). */
export type AppModel = Omit<Model, "fileData" | "story" | "repos" | "mode" | "canVR" | "canAR" | "placing" | "menuOpen" | "keyboard">;

/** The headset's own actions (menu, keyboard, sessions) are useXR's; the rest are the desktop's. */
export type AppActions = Omit<
  Actions,
  "toggleMenu" | "openKeyboard" | "closeKeyboard" | "submitKeyboard" | "suggest" | "jump" | "enter" | "exitXR" | "placeMap" | "recenterPanels"
> & {
  addNote: (path: string, text: string) => void;
  /** A local path, or on a server that keeps GitHub repos, owner/name. */
  openPath: (text: string) => void;
};
