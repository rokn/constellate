import type { Renames } from "./renames";
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

/** Where a note is pinned: a file, or an import line between two files. */
export type NoteTarget = { kind: "file"; path: string } | { kind: "link"; from: string; to: string };

/** Your note, pinned to the map as a sticky card. */
export type Note = {
  id: string;
  text: string;
  target: NoteTarget;
  createdAt: number;
  updatedAt: number;
};

/**
 * A marker on top of the map — "everything touching billing", "the hot
 * path" — that points at files without reorganizing them. Drawn as a beacon
 * over its files; the layout, and whatever separation it has, stays exactly
 * as it is.
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
  createdBy: "you" | "navigator" | "agent";
  /** The answer that marked it, so an answer's markers can go together. */
  frameId?: string;
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
  /** Show only these modules and folders (any number of them). */
  isolate?: Isolated[];
};

/* ------------------------------ history ------------------------------ */

export type CommitFile = {
  path: string;
  /** Added, modified, or deleted in this commit. */
  status: "A" | "M" | "D";
  add: number;
  del: number;
};

export type Commit = {
  /** "worktree" for the uncommitted slice at the top of history. */
  sha: string;
  short: string;
  author: string;
  /** Epoch milliseconds. */
  at: number;
  parents: string[];
  subject: string;
  files: CommitFile[];
  worktree?: boolean;
};

/** Newest first. */
export type History = {
  head?: string;
  commits: Commit[];
  /** More history exists than was loaded. */
  truncated: boolean;
  /** False when the repo isn't a git repository. */
  available: boolean;
};

/** A span of history, both ends inclusive: `from` is the older commit. */
export type TimeRange = { from: string; to: string; label?: string };

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
      kind: "diff";
      id: string;
      title?: string;
      path: string;
      lang: string;
      /** The range, so the reader can widen it or open it on the map. */
      from: string;
      to: string;
      /** Unified diff, exactly as git printed it. */
      diff: string;
      note?: string;
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
  /**
   * Something typed that waits for a yes: merging an agent's PR deploys, so
   * the answer carries a Merge button and nothing merges until it's pressed.
   */
  confirm?: { action: "merge"; agentId: string };
  createdAt: number;
};

/* ------------------------------ stories ------------------------------ */

/**
 * Something that happens on screen during a story beat. `at` is the offset
 * (in characters) into the beat's narration where it fires — the start of the
 * phrase the navigator anchored it to — or 0 for the start of the beat.
 */
export type StoryCue = { at: number } & (
  /** Put one of the story's visuals on the stage. */
  | { kind: "show"; visual: string }
  /** Spotlight file lines in the code visual on stage. */
  | { kind: "lines"; lines: number[] }
  /** Draw diagram nodes in (live diagrams build up as they're narrated). */
  | { kind: "reveal"; nodes: string[] }
  /** Emphasize diagram nodes; everything else dims. Empty clears. */
  | { kind: "emphasize"; nodes: string[] }
  /** Advance a custom visualization to a step of its animation. */
  | { kind: "step"; step: number }
  /** Fly the map's camera to these files. */
  | { kind: "focus"; paths: string[]; label?: string }
  /** Open a file in the code panel at a range. */
  | { kind: "open"; path: string; line?: number; endLine?: number }
);

/** Word timings for a voiced beat: char offset into `say`, length, start and end in ms. */
export type BeatWord = { i: number; n: number; s: number; e: number };

export type StoryBeat = {
  id: string;
  /** What the voice says — one to three short spoken sentences. */
  say: string;
  /** Silence after the beat, so a visual can be looked at. */
  pauseMs: number;
  cues: StoryCue[];
  /** Set once the beat is voiced. */
  audio?: { key: string; ms: number; words: BeatWord[] };
};

/** A part of the codebase the story is about. */
export type StoryContext = { path: string; line?: number; endLine?: number; why: string };

/**
 * A narrated walkthrough: a short script the voice reads, choreographed with
 * prepared visuals and camera moves. Written by the navigator, voiced by Inworld.
 */
export type Story = {
  id: string;
  title: string;
  /** One line on what it explains. */
  summary: string;
  /** What was asked for. */
  request: string;
  state: "writing" | "voicing" | "ready" | "error";
  /** While writing: what the navigator is doing. */
  progress?: string;
  error?: string;
  /** 1–3 for the repo's intro stories, in order. */
  intro?: number;
  /** A branch story: what the branch changes relative to its base. */
  branch?: { name: string; base: string; mergeBase: string; head: string };
  /**
   * Voice and style pinned to this story (one made through the API uses the
   * defaults, whatever the settings say). Unset: the current settings.
   */
  voice?: StorySettings;
  context: StoryContext[];
  /** Prepared up front, so playback never waits on a model. */
  visuals: View[];
  beats: StoryBeat[];
  /** The voice the beats were synthesized with; a different setting re-voices. */
  voiceKey?: string;
  /** No TTS available: the player runs on estimated timings with captions. */
  silent?: boolean;
  createdAt: number;
};

/** How stories are written and voiced. Global, not per repo. */
export type StorySettings = {
  voiceId: string;
  ttsModel: string;
  /** TTS speaking rate, 0.5–1.5 (the player's speed control is separate). */
  rate: number;
  /** A few words on the narration style, handed to the writer. */
  style: string;
};

/* ------------------------------ runtime ------------------------------ */

/**
 * What the code does when it runs, from OpenTelemetry traces: spans arrive
 * over OTLP (or are pulled from Tempo or Jaeger), are pinned to the files
 * they ran in, and add up to runtime edges between files, services and what
 * they talk to outside the repo. See server/traces.ts.
 */

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

/** Where in the repo a span ran, and how it was worked out. */
export type SpanLocation = {
  path: string;
  line?: number;
  symbol?: string;
  /**
   * code: its code.file.path (or code.filepath) attribute. function: its
   * qualified function name. scope: its tracer is named for a package here.
   * name: its name is a symbol here. Most sure first.
   */
  via: "code" | "function" | "scope" | "name";
};

export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentId?: string;
  /** Its resource's service.name. */
  service: string;
  name: string;
  kind: SpanKind;
  /** Epoch milliseconds, and how long it took. */
  start: number;
  ms: number;
  error: boolean;
  /** The instrumentation scope (the tracer's name). */
  scope?: string;
  attrs: Record<string, string | number | boolean>;
  /** Unset when it couldn't be pinned to a file. */
  loc?: SpanLocation;
};

/**
 * A runtime graph node is one of: a repo path ("server/api.go"), a service
 * whose code isn't on the map ("svc:<service.name>"), or something outside
 * the repo it calls ("ext:<kind>:<name>", e.g. "ext:db:postgresql/app").
 */
export type RuntimeNodeId = string;

export type RuntimeEdgeKind = "call" | "http" | "rpc" | "messaging" | "db" | "external";

/** One caller-to-callee link seen in traces, added up over every time it was seen. */
export type RuntimeEdge = {
  from: RuntimeNodeId;
  to: RuntimeNodeId;
  fromService: string;
  /** Set when the call crossed into another service. */
  toService?: string;
  /** call: in-process. http, rpc, messaging: to another service, or out. db, external: out of the repo. */
  kind: RuntimeEdgeKind;
  /** What travelled it: routes, RPC methods, topics, queries' operations, span names. Most seen first. */
  labels: { label: string; count: number }[];
  /** The functions on each end, when known. Most seen first. */
  calls: { from?: string; to?: string; count: number }[];
  count: number;
  errors: number;
  /** Time spent on the callee's side, summed and at most. */
  totalMs: number;
  maxMs: number;
  firstSeen: number;
  lastSeen: number;
  /**
   * File-to-file edges only, against the static map. confirmed: an import
   * says so too. package: the same Go package, which needs no import.
   * runtime-only: no import explains it (an interface, a callback, a
   * registry, HTTP to itself), the edges the static map can't draw.
   */
  verdict?: "confirmed" | "package" | "runtime-only";
  /** A few traces it was seen in, for /api/traces/<id>. */
  traces: string[];
};

/** A service that sent traces, and what of the repo it ran. */
export type RuntimeService = {
  name: string;
  /** process.executable.name, and its path: what a service is built from. */
  executable?: string;
  executablePath?: string;
  /** telemetry.sdk.language. */
  language?: string;
  namespace?: string;
  spans: number;
  errors: number;
  firstSeen: number;
  lastSeen: number;
  /** Files its spans ran in, most first. */
  files: { path: string; spans: number }[];
  /** Where requests enter it: the first file its server, consumer and root spans reach. */
  entries: { path: string; count: number }[];
};

/** Something outside the repo that services call. */
export type RuntimeExternal = {
  id: RuntimeNodeId;
  kind: "db" | "http" | "rpc" | "messaging" | "service";
  label: string;
  /** db.system, rpc.system, messaging.system. */
  system?: string;
};

/** Everything the traces say, added up: GET /api/runtime. */
export type RuntimeMap = {
  /** Spans taken in, and how many of them were pinned to a file. */
  spans: number;
  mapped: number;
  traces: number;
  firstSeen?: number;
  lastSeen?: number;
  services: RuntimeService[];
  externals: RuntimeExternal[];
  edges: RuntimeEdge[];
  /** Imports between files that both ran, never seen used at runtime. */
  dormant: { from: string; to: string }[];
  /** The span shapes that couldn't be pinned to a file, most seen first: what to instrument better. */
  unmapped: { service: string; name: string; scope?: string; count: number }[];
};

/** A trace still held in memory: GET /api/traces. */
export type TraceSummary = {
  traceId: string;
  /** The root span's name (or the earliest span's, while the root hasn't arrived). */
  root: string;
  services: string[];
  start: number;
  ms: number;
  spans: number;
  errors: number;
  mapped: number;
};

export type TraceSourceStatus = {
  /** otlp: pushed to /v1/traces. tempo, jaeger: pulled from their query APIs. */
  kind: "otlp" | "tempo" | "jaeger";
  url?: string;
  ok: boolean;
  spans: number;
  lastAt?: number;
  error?: string;
};

/** The runtime layer in the session stream: bumped as spans arrive, so the page refetches /api/runtime. */
export type RuntimeStatus = {
  version: number;
  spans: number;
  traces: number;
  services: string[];
  lastAt?: number;
  sources: TraceSourceStatus[];
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
  | { cmd: "set_lens"; lensId: string }
  /** Light up what changed in a span of history. */
  | { cmd: "set_range"; range: TimeRange }
  | { cmd: "clear_range" }
  /** Fly through the commits in the current range, one by one. */
  | { cmd: "replay" }
  /** Put a branch on the map, lit against where it forked from `base` (an agent's: where it started). */
  | { cmd: "show_branch"; branch: string; base?: string; agent?: string }
  /** Back to the map as it's checked out. */
  | { cmd: "close_branch" }
  /** While a branch or a span of history is on the map: show only the files it changed, or the whole map again. */
  | { cmd: "changed_only"; on: boolean }
  /** Files moved; what the page keeps by path (its filter) follows them. */
  | { cmd: "renamed"; renames: Renames }
  /** Headset: take the map off the table it's set down on. */
  | { cmd: "leave_table" }
  /** Headset: which of a focus's connections light: what imports it (in), what it imports (out), or both. */
  | { cmd: "focus_direction"; dir: "in" | "out" | "both" }
  /** Turn Tune knobs: the map's and the headset's (by key). */
  | { cmd: "tune"; map?: Record<string, number | boolean>; headset?: Record<string, number | boolean> }
  /** Switch to a preset: its knobs over the defaults (the headset's only when it keeps them). */
  | { cmd: "apply_preset"; preset: TunePreset };

export type Layer = "imports" | "logical" | "labels" | "folders" | "beacons" | "notes";

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

/**
 * Tune settings saved under a name: the map's knobs, and (saved in the
 * headset) the headset's own, each as what differs from the defaults.
 */
export type TunePreset = { name: string; map: Record<string, number | boolean>; headset?: Record<string, number | boolean> };

/**
 * One thing the map is isolated to. A folder is matched by prefix, so files
 * added under it later are included; a module or group carries its files.
 */
export type Isolated = {
  kind: "module" | "dir";
  id: string;
  label: string;
  paths?: string[];
  /** Taken out of view instead: the map shows everything else (or the rest of what's isolated). */
  exclude?: boolean;
};

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
  notes: Note[];
  frames: Frame[];
  /** Narrated walkthroughs, the intro's three among them. */
  stories: Story[];
  storySettings: StorySettings;
  /** Tune presets you saved: yours, not the repo's, kept on the server so every device has them. */
  tunePresets: TunePreset[];
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
  /** The branch's upstream, as of the last fetch: what a pull would bring. */
  remote?: RemoteStatus;
  /** The server is pinned to this repo; opening another is turned off. */
  locked?: boolean;
  /** The server clones GitHub repos on request and switches between them (see /api/repos). */
  library?: boolean;
  /** Coding agents working on this repo, each on its own branch in its own worktree. */
  agents: AgentRun[];
  /** Whether this server lets you start agents at all. */
  agentsOn?: boolean;
  /** Traces taken in for this repo, and where they come from. */
  runtime?: RuntimeStatus;
};

export type AgentStatus = "starting" | "working" | "done" | "failed" | "stopped";

/**
 * A coding agent: one Agent SDK session working in a git worktree of the
 * repo, on a branch of its own. What it changes is committed to that branch
 * when a turn ends; landing it is yours.
 */
export type AgentRun = {
  id: string;
  title: string;
  /** What it was asked to do first. */
  task: string;
  status: AgentStatus;
  /** Its branch, e.g. agent/add-logging-x1y2. */
  branch: string;
  /** The branch (or HEAD) it started from, and the commit its work sits on (moved by a rebase). */
  base: string;
  baseSha: string;
  worktree: string;
  /** Files it has changed since it started, repo-relative. */
  files: string[];
  /** Commits on its branch since it started. */
  commits: number;
  /** What it's doing right now, in a line. */
  activity?: string;
  /** Its last word on what it did. */
  summary?: string;
  error?: string;
  costUsd?: number;
  /** The Agent SDK session, resumed for follow-ups. */
  sessionId?: string;
  turns: { role: "you" | "agent"; text: string; at: number }[];
  /** Its pull request on GitHub, once you've opened one; later turns push to it. */
  pr?: { number: number; url: string; state: "open" | "closed" | "merged"; base: string; pushedSha: string };
  createdAt: number;
  updatedAt: number;
};

/** A GitHub repo cloned on a server that keeps several (CODEFLIGHT_REPOS_DIR). */
export type LibraryRepo = {
  /** "owner/name". */
  id: string;
  url: string;
  /** The map's headline, once the navigator has charted it. */
  headline?: string;
  openedAt?: number;
  current: boolean;
};

export type RemoteStatus = {
  /** The upstream, e.g. "origin/main". */
  upstream: string;
  /** Commits on the upstream that HEAD doesn't have, and the other way. */
  behind: number;
  ahead: number;
  /** The newest of those incoming commits. */
  commits: { short: string; subject: string; author: string; at: number }[];
  checkedAt: number;
  /** Why the last fetch or pull failed. */
  error?: string;
  pulling?: boolean;
};

/** What the browser reports about itself, so the voice knows what is on screen. */
export type ScreenContext = {
  openFile?: { path: string; line?: number };
  /** The branch shown on the map (Branch view), compared with its base — or, an agent's, with where it started. */
  branch?: { name: string; base?: string; agent?: string; changedOnly?: boolean };
  frameId?: string;
  focusLabel?: string;
  selection?: string;
  touring?: boolean;
  /** How the map is organized right now, and what the filter leaves. */
  lens?: string;
  /** The grouping's id, for revising it in place ("modules" for the overview's modules). */
  lensId?: string;
  filter?: string;
  visibleFiles?: number;
  /** The span of history lit on the map, described. */
  range?: string;
  /**
   * The story they're watching (beat is 0-based), paused to ask about, or —
   * closed — the last one they watched.
   */
  story?: { id: string; beat: number; playing: boolean; parked?: boolean; closed?: boolean };
  /** The Tune knobs that differ from their defaults, and whether they're in the headset (vr or ar) right now. */
  tune?: { map: Record<string, number | boolean>; headset: Record<string, number | boolean>; mode?: "vr" | "ar" };
};
