/**
 * The vocabulary shared by the server, the navigator agent's tools, the voice
 * bridge and the browser. Everything that crosses a process or a model
 * boundary is one of these shapes.
 */

/* ------------------------------ the map ------------------------------ */

export type Symbol = {
  name: string;
  kind: string;
  line: number;
  /** The class, type or impl a member belongs to. */
  container?: string;
};

export type FileInfo = {
  path: string;
  /** Top-level directory, or "." for files at the root. Drives colour. */
  top: string;
  lang: string;
  loc: number;
  symbols: Symbol[];
  /** Bare package imports — react, express, numpy. Not part of the graph. */
  externals: string[];
};

/** A resolved, in-repo import: `from` imports `to`. */
export type ImportEdge = {
  from: string;
  to: string;
  /** What `from` takes from `to`: the imported names, or for Go the names it uses. */
  names?: string[];
  /** The line in `from` where the import is written. */
  line?: number;
};

/**
 * The static map of the repository: produced in seconds by server/scan.ts,
 * without any model involved. It is the ground the navigator stands on and the
 * space the reader flies through.
 */
export type RepoGraph = {
  name: string;
  root: string;
  branch?: string;
  head?: string;
  files: FileInfo[];
  dirs: string[];
  imports: ImportEdge[];
  languages: Record<string, number>;
  totals: { files: number; loc: number };
  /** Files skipped because the repo is larger than the scan budget. */
  skipped: number;
  /** Most-used external packages, for the intro card and the navigator. */
  externals: { name: string; count: number }[];
};

/* ---------------------------- the meaning ---------------------------- */

/**
 * A logical module — what a person would draw on a whiteboard, as opposed to
 * what the directory tree says. Written by the navigator during the intro.
 */
export type LogicalModule = {
  id: string;
  label: string;
  summary: string;
  paths: string[];
};

/**
 * A relationship the import graph can't see: an HTTP call, a queue, an event
 * bus, a shared table, a config switch. The navigator infers these by reading.
 */
export type LogicalEdge = {
  from: string;
  to: string;
  label: string;
  kind: "calls" | "data" | "event" | "http" | "config" | "renders" | "other";
};

export type Topic = {
  id: string;
  title: string;
  /** One line on why this is worth a visit. */
  hook: string;
  paths: string[];
};

export type Overview = {
  headline: string;
  /** A short markdown paragraph — what this is and how it hangs together. */
  summary: string;
  stack: string[];
  modules: LogicalModule[];
  edges: LogicalEdge[];
  topics: Topic[];
  /** Where execution starts — servers, CLIs, app roots. */
  entryPoints: string[];
  /** The navigator's spoken opening line, kept so a reopened repo can replay it. */
  welcome?: string;
};

/**
 * Another way to organize the map: named groups of files, and how the groups
 * relate. The overview's modules are one lens; the navigator writes more on
 * request — by layer, by feature, by runtime process, by data flow.
 */
export type Lens = {
  id: string;
  title: string;
  description: string;
  groups: LogicalModule[];
  edges: LogicalEdge[];
  createdAt: number;
};

/**
 * A group marked on top of the map — "everything touching billing", "the
 * hot path" — without reorganizing it. Drawn as a beacon over its files; the
 * layout, and whatever separation it has, stays exactly as it is.
 */
export type GroupOverlay = {
  id: string;
  label: string;
  summary: string;
  paths: string[];
  /** Why each file is in the group, shown when its spoke is hovered. */
  reasons?: Record<string, string>;
  color: string;
  visible: boolean;
  createdBy: "you" | "navigator";
  createdAt: number;
};

/** What's on the map. Empty lists mean "no constraint". */
export type MapFilter = {
  /** Globs or substrings; a file must match one of these. */
  include: string[];
  exclude: string[];
  hideTests: boolean;
  hideDocs: boolean;
  langs: string[];
  /** Top-level directories. */
  tops: string[];
  /** An explicit set of files chosen by the navigator. */
  paths?: string[];
  /** Files you hid one by one (or by folder): exact paths, always excluded. */
  hidden?: string[];
  /** A name for the filter, when the navigator made it. */
  label?: string;
};

/* ----------------------------- the views ----------------------------- */

export type DiagramNode = {
  id: string;
  label: string;
  /** Optional one-line detail under the label. */
  detail?: string;
  /** A file this box stands for — clicking it flies there. */
  path?: string;
};
export type DiagramEdge = { from: string; to: string; label?: string };

/**
 * What the navigator puts on screen. Every view has an id the voice can point
 * at; code is always sliced server-side from the real file, never typed by a
 * model.
 */
export type View =
  | { kind: "text"; id: string; title?: string; markdown: string }
  | {
      kind: "code";
      id: string;
      title?: string;
      path: string;
      lang: string;
      startLine: number;
      code: string;
      note?: string;
      highlight: number[];
      annotations: { line: number; text: string }[];
    }
  | {
      kind: "diagram";
      id: string;
      title: string;
      /** static = derived from imports; logical = inferred from behaviour. */
      layer: "static" | "logical";
      dir: "TD" | "LR";
      nodes: DiagramNode[];
      edges: DiagramEdge[];
    }
  | {
      kind: "custom";
      id: string;
      title: string;
      /** Self-contained HTML, rendered in a sandboxed iframe. */
      html: string;
      height?: number;
    };

/**
 * One stop on the flight: a question or a topic, the navigator's answer, and
 * the views it built. Frames are the history you can fly back through.
 */
export type Frame = {
  id: string;
  title: string;
  request: string;
  topicId?: string;
  state: "working" | "done" | "error";
  /** The navigator's spoken/caption answer, streamed while it writes. */
  answer: string;
  views: View[];
  /** Files this frame is about — the camera's constellation. */
  focus: string[];
  error?: string;
  createdAt: number;
};

/* --------------------------- live channel --------------------------- */

export type Activity = {
  at: number;
  kind: "read" | "search" | "tool" | "think" | "error";
  detail: string;
  path?: string;
};

/** What the navigator and the voice are allowed to do to the screen. */
export type UiCommand =
  | { cmd: "fly_to"; path: string }
  | { cmd: "open_file"; path: string; line?: number; endLine?: number }
  | { cmd: "focus"; paths: string[]; label?: string }
  | { cmd: "focus_module"; moduleId: string }
  | { cmd: "overview" }
  | { cmd: "back" }
  | { cmd: "show_frame"; frameId: string }
  | { cmd: "highlight"; viewId?: string; nodeIds?: string[]; lines?: number[] }
  | { cmd: "clear_highlight" }
  | { cmd: "set_layer"; layer: Layer; on: boolean }
  | { cmd: "start_tour" }
  | { cmd: "close_panel" }
  /** Narrow the map. Fields left out keep their current value. */
  | { cmd: "filter"; filter: Partial<MapFilter> }
  | { cmd: "clear_filter" }
  /** Organize the map by a lens: "folders", "modules", or a lens id. */
  | { cmd: "set_lens"; lensId: string };

export type Layer = "imports" | "logical" | "labels" | "folders" | "beacons";

/**
 * How you have the map set up for one repo — knobs, layers, organization,
 * filter. Saved with the repo, so each codebase opens the way you left it.
 * The knobs are opaque here; the browser owns their shape.
 */
export type ViewSettings = {
  tuning?: Record<string, number | boolean>;
  layers?: Partial<Record<Layer, boolean>>;
  lensId?: string;
  filter?: MapFilter;
  /** Filters you saved under a name, to switch between. */
  savedFilters?: SavedFilter[];
};

export type SavedFilter = { name: string; filter: MapFilter };

export type SessionStatus = "idle" | "scanning" | "analyzing" | "ready" | "error";

export type SessionState = {
  status: SessionStatus;
  error?: string;
  repo?: { name: string; root: string; branch?: string };
  /** Bumped whenever the static graph is replaced; the browser refetches. */
  graphVersion: number;
  overview?: Overview;
  /** Groupings the navigator has written for this repo. */
  lenses: Lens[];
  /** Groups marked on top of the map, by you or the navigator. */
  overlays: GroupOverlay[];
  frames: Frame[];
  activity: Activity[];
  commands: { id: number; cmd: UiCommand }[];
  /** True while the navigator is working on something. */
  busy: boolean;
  /** Whether a cached overview was reused rather than freshly written. */
  fromCache: boolean;
  /**
   * The code has moved on since the overview was charted. Everything you
   * made is kept; the map just offers to re-chart.
   */
  stale?: boolean;
  /** Your saved view of this repo. */
  view?: ViewSettings;
};

/** What the browser reports about itself, so the voice knows what is on screen. */
export type ScreenContext = {
  openFile?: { path: string; line?: number };
  frameId?: string;
  focusLabel?: string;
  selection?: string;
  touring?: boolean;
  /** How the map is organized right now, and what the filter leaves. */
  lens?: string;
  filter?: string;
  visibleFiles?: number;
};
