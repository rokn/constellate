import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Activity,
  AgentRun,
  Frame,
  GroupOverlay,
  Lens,
  Note,
  NoteTarget,
  Overview,
  SessionState,
  Story,
  StorySettings,
  ViewSettings,
  TunePreset,
  UiCommand,
  View,
} from "../shared/types";
import { promisify } from "node:util";
import { GO_APPS, goApps } from "../shared/goApps";
import { movedDirs, renameInFilter, renamer, type Renames } from "../shared/renames";
import { indexGraph, repoName, scanRepo, type GraphIndex } from "./scan";

const run = promisify(execFile);

/**
 * One open repository, one session. The server is a local tool — one person,
 * one repo at a time — so this is a module-level singleton rather than a
 * store keyed by id. Everything that changes goes through a mutation here,
 * and every mutation emits, so the browser's view is never a poll away.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable so a second server (a test run, another worktree) can work on
// the same repo without writing over the main session's saved state.
export const CACHE_DIR = process.env.CODEFLIGHT_CACHE_DIR ?? path.join(HERE, "..", ".cache");

export const DEFAULT_STORY_SETTINGS: StorySettings = { voiceId: "Elliot", ttsModel: "inworld-tts-2", rate: 1, style: "" };

const MAX_ACTIVITY = 60;
const MAX_COMMANDS = 30;

type Listener = (s: SessionState) => void;

export type Session = {
  state: SessionState;
  idx?: GraphIndex;
  /** The Agent SDK session to resume, so follow-ups remember what was read. */
  agentSessionId?: string;
  /** The commit the overview was charted at — not necessarily the current one. */
  chartedHead?: string;
  commandSeq: number;
};

export const session: Session = {
  state: {
    status: "idle",
    graphVersion: 0,
    lenses: [],
    overlays: [],
    notes: [],
    frames: [],
    stories: [],
    storySettings: DEFAULT_STORY_SETTINGS,
    tunePresets: [],
    activity: [],
    commands: [],
    busy: false,
    fromCache: false,
    agents: [],
  },
  commandSeq: 0,
};

const listeners = new Set<Listener>();

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function emit() {
  for (const fn of listeners) {
    try {
      fn(session.state);
    } catch {
      /* a dead connection must not stop the navigator */
    }
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persist(), 800);
}

/* ------------------------------ mutations ------------------------------ */

export function pushActivity(a: Omit<Activity, "at">) {
  session.state.activity.push({ ...a, at: Date.now() });
  if (session.state.activity.length > MAX_ACTIVITY) {
    session.state.activity.splice(0, session.state.activity.length - MAX_ACTIVITY);
  }
  emit();
}

/** Queue a UI action. Only the browser can move the camera, so it rides the stream. */
export function pushCommand(cmd: UiCommand) {
  session.state.commands.push({ id: ++session.commandSeq, cmd });
  if (session.state.commands.length > MAX_COMMANDS) {
    session.state.commands.splice(0, session.state.commands.length - MAX_COMMANDS);
  }
  emit();
}

export function setOverview(o: Overview) {
  session.state.overview = o;
  emit();
}

/** Removes a grouping; returns it, so it can be restored. */
export function removeLens(id: string): Lens | undefined {
  const lens = session.state.lenses.find((l) => l.id === id);
  if (!lens || lens.derived) return undefined;
  session.state.lenses = session.state.lenses.filter((l) => l.id !== id);
  emit();
  return lens;
}

/** Puts a grouping back, or replaces it in place by id (an edit keeps its id). */
export function putLens(lens: Lens) {
  const i = session.state.lenses.findIndex((l) => l.id === lens.id);
  session.state.lenses = i < 0 ? [...session.state.lenses, lens] : session.state.lenses.map((l, j) => (j === i ? lens : l));
  emit();
}

/** Edits the overview's modules in place (the "Modules" organization). */
export function setModules(modules: Overview["modules"], edges: Overview["edges"]) {
  if (!session.state.overview) return;
  session.state.overview = { ...session.state.overview, modules, edges };
  emit();
}

/** The Go apps grouping, built afresh from the graph: first among the groupings, or gone when no executable is left. */
function refreshGoApps(graph: GraphIndex["graph"]) {
  const apps = goApps(graph);
  session.state.lenses = [...(apps ? [apps] : []), ...session.state.lenses.filter((l) => l.id !== GO_APPS)];
}

/** Adds a lens, replacing one with the same title so a redo doesn't pile up. */
export function addLens(lens: Lens) {
  session.state.lenses = [...session.state.lenses.filter((l) => l.title !== lens.title), lens];
  emit();
}

/**
 * Overlay colours: distinct from each other and from the map's reserved
 * grammar (magenta course, amber runtime, cyan static).
 */
const OVERLAY_COLORS = ["#a78bfa", "#4ade80", "#f87171", "#60a5fa", "#2dd4bf", "#fde68a", "#fb923c", "#c4b5fd", "#86efac", "#fca5a5"];

export function addOverlay(o: Omit<GroupOverlay, "id" | "color" | "visible" | "createdAt"> & { color?: string }): GroupOverlay {
  const used = new Set(session.state.overlays.map((x) => x.color));
  const overlay: GroupOverlay = {
    ...o,
    id: `g${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    color: o.color ?? OVERLAY_COLORS.find((c) => !used.has(c)) ?? OVERLAY_COLORS[session.state.overlays.length % OVERLAY_COLORS.length],
    visible: true,
    createdAt: Date.now(),
  };
  // Same name replaces, so "mark the auth code" twice doesn't stack two beacons.
  session.state.overlays = [...session.state.overlays.filter((x) => x.label.toLowerCase() !== o.label.toLowerCase()), overlay];
  emit();
  return overlay;
}

export function updateOverlay(id: string, patch: Partial<Pick<GroupOverlay, "visible" | "label" | "summary" | "paths">>) {
  // Only what's given changes: a hide sends no label, and mustn't blank it.
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  session.state.overlays = session.state.overlays.map((o) => (o.id === id ? { ...o, ...given } : o));
  emit();
}

export function addNote(text: string, target: NoteTarget): Note {
  const now = Date.now();
  const note: Note = { id: `n${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, text, target, createdAt: now, updatedAt: now };
  session.state.notes = [...session.state.notes, note];
  emit();
  return note;
}

export function updateNote(id: string, text: string) {
  session.state.notes = session.state.notes.map((n) => (n.id === id ? { ...n, text, updatedAt: Date.now() } : n));
  emit();
}

/** Removes a note; returns it, so it can be put back. */
export function removeNote(id: string): Note | undefined {
  const note = session.state.notes.find((n) => n.id === id);
  session.state.notes = session.state.notes.filter((n) => n.id !== id);
  emit();
  return note;
}

export function restoreNote(note: Note) {
  session.state.notes = [...session.state.notes.filter((n) => n.id !== note.id), note];
  emit();
}

export function removeOverlay(id: string) {
  session.state.overlays = session.state.overlays.filter((o) => o.id !== id);
  emit();
}

/** Puts deleted markers back, as they were. */
export function restoreOverlays(markers: GroupOverlay[]) {
  const ids = new Set(markers.map((m) => m.id));
  session.state.overlays = [...session.state.overlays.filter((o) => !ids.has(o.id)), ...markers];
  emit();
}

/** Hides, shows or deletes several markers at once; returns the ones it touched. */
export function changeOverlays(ids: string[], action: "hide" | "show" | "delete"): GroupOverlay[] {
  const set = new Set(ids);
  const hit = session.state.overlays.filter((o) => set.has(o.id));
  session.state.overlays =
    action === "delete"
      ? session.state.overlays.filter((o) => !set.has(o.id))
      : session.state.overlays.map((o) => (set.has(o.id) ? { ...o, visible: action === "show" } : o));
  emit();
  return hit;
}

let frameSeq = 0;

export function newFrame(title: string, request: string, topicId?: string): Frame {
  const frame: Frame = {
    id: `f${Date.now().toString(36)}${(frameSeq++).toString(36)}`,
    title,
    request,
    topicId,
    state: "working",
    answer: "",
    views: [],
    focus: [],
    createdAt: Date.now(),
  };
  session.state.frames.push(frame);
  emit();
  return frame;
}

export function patchFrame(id: string, patch: Partial<Frame>) {
  const i = session.state.frames.findIndex((f) => f.id === id);
  if (i < 0) return;
  session.state.frames[i] = { ...session.state.frames[i], ...patch };
  emit();
}

export function getFrame(id: string) {
  return session.state.frames.find((f) => f.id === id);
}

/* ------------------------------- stories ------------------------------- */

let storySeq = 0;

export function newStory(request: string, intro?: number): Story {
  const story: Story = {
    id: `s${Date.now().toString(36)}${(storySeq++).toString(36)}`,
    title: request.slice(0, 80),
    summary: "",
    request,
    state: "writing",
    intro,
    context: [],
    visuals: [],
    beats: [],
    createdAt: Date.now(),
  };
  session.state.stories = [...session.state.stories, story];
  emit();
  return story;
}

export function patchStory(id: string, patch: Partial<Story>) {
  session.state.stories = session.state.stories.map((s) => (s.id === id ? { ...s, ...patch } : s));
  emit();
}

export function getStory(id: string) {
  return session.state.stories.find((s) => s.id === id);
}

export function removeStory(id: string): Story | undefined {
  const story = getStory(id);
  session.state.stories = session.state.stories.filter((s) => s.id !== id);
  emit();
  return story;
}

/** Story settings are yours, not the repo's: one file beside the per-repo caches. */
const SETTINGS_FILE = path.join(CACHE_DIR, "story-settings.json");

export async function loadStorySettings() {
  try {
    const saved = JSON.parse(await readFile(SETTINGS_FILE, "utf8")) as Partial<StorySettings>;
    session.state.storySettings = { ...DEFAULT_STORY_SETTINGS, ...saved };
    emit();
  } catch {
    /* none saved yet */
  }
}

export async function setStorySettings(patch: Partial<StorySettings>) {
  session.state.storySettings = { ...session.state.storySettings, ...patch };
  emit();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(session.state.storySettings, null, 2));
}

/** Tune presets are yours too: one file beside the story settings. */
const PRESETS_FILE = path.join(CACHE_DIR, "tune-presets.json");

export async function loadTunePresets() {
  try {
    const saved = JSON.parse(await readFile(PRESETS_FILE, "utf8")) as TunePreset[];
    if (Array.isArray(saved)) session.state.tunePresets = saved;
    emit();
  } catch {
    /* none saved yet */
  }
}

export async function setTunePresets(list: TunePreset[]) {
  session.state.tunePresets = list;
  emit();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(PRESETS_FILE, JSON.stringify(list, null, 2));
}

let viewSeq = 0;
/** Ids are assigned here — asking a model for unique ids invites collisions. */
const VIEW_PREFIX: Record<View["kind"], string> = { text: "t", code: "c", diagram: "d", diff: "f", custom: "x" };
export function viewId(kind: View["kind"]) {
  return `${VIEW_PREFIX[kind]}${(viewSeq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function addView(frameId: string, view: View) {
  const frame = getFrame(frameId);
  if (!frame) return;
  patchFrame(frameId, { views: [...frame.views, view] });
}

export function findView(viewId: string): { frame: Frame; view: View } | null {
  for (const frame of session.state.frames) {
    const view = frame.views.find((v) => v.id === viewId);
    if (view) return { frame, view };
  }
  return null;
}

/* ------------------------------- opening ------------------------------- */

export function setView(view: ViewSettings) {
  session.state.view = view;
  emit();
}

/** Re-chart the overview only. Groupings, groups, answers and your view stay. */
export function dropOverview() {
  session.state.overview = undefined;
  session.state.stale = false;
  session.state.fromCache = false;
  session.state.status = "analyzing";
  emit();
}

/** A clean slate for the repo at `abs`, shown as being opened. */
export function resetSession(abs: string, name: string) {
  session.state = {
    status: "scanning",
    repo: { name, root: abs },
    graphVersion: session.state.graphVersion + 1,
    lenses: [],
    overlays: [],
    notes: [],
    frames: [],
    stories: [],
    storySettings: session.state.storySettings,
    tunePresets: session.state.tunePresets,
    activity: [],
    commands: [],
    busy: false,
    fromCache: false,
    locked: session.state.locked,
    library: session.state.library,
    agents: [],
    agentsOn: session.state.agentsOn,
  };
  session.idx = undefined;
  session.agentSessionId = undefined;
  session.chartedHead = undefined;
  emit();
}

export async function openRepo(root: string, opts: { rechart?: boolean } = {}) {
  const abs = path.resolve(root.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  resetSession(abs, await repoName(abs).catch(() => path.basename(abs)));

  const graph = await scanRepo(abs, (done, total) =>
    pushActivity({ kind: "tool", detail: `Scanned ${done} of ${total} files` }),
  );
  session.idx = indexGraph(graph);
  session.state.repo = { name: graph.name, root: graph.root, branch: graph.branch };
  session.state.graphVersion++;
  pushActivity({
    kind: "tool",
    detail: `Mapped ${graph.totals.files} files and ${graph.imports.length} imports`,
  });
  void checkRemote(FETCH_EVERY > 0);

  // Everything you made comes back regardless of commit — groupings, groups,
  // answers, your view. Only the overview's freshness depends on the commit:
  // if the code moved on, the old map is kept and marked stale rather than
  // thrown away, and re-charting is your call.
  const cached = await loadCache(graph.root);
  if (cached) {
    session.state.lenses = cached.lenses ?? [];
    refreshGoApps(graph);
    session.state.overlays = cached.overlays ?? [];
    session.state.notes = cached.notes ?? [];
    session.state.view = cached.view;
    session.state.frames = (cached.frames ?? []).map((f) =>
      f.state === "working" ? { ...f, state: "error", error: "Interrupted by a restart." } : f,
    );
    // A story caught mid-write by a restart has nothing to resume from.
    session.state.stories = (cached.stories ?? []).map((s) =>
      s.state === "writing" || s.state === "voicing" ? { ...s, state: s.beats.length ? "ready" : "error", error: s.beats.length ? undefined : "Interrupted by a restart." } : s,
    );
    // An agent saved mid-run has nothing running behind it after a restart;
    // its worktree and branch are still there to pick up from.
    session.state.agents = (cached.agents ?? []).map((a) =>
      a.status === "working" || a.status === "starting" ? { ...a, status: "stopped", activity: undefined, error: "Interrupted by a restart." } : a,
    );
    session.agentSessionId = cached.agentSessionId;
    if (cached.overview && !opts.rechart) {
      session.state.overview = cached.overview;
      session.chartedHead = cached.head;
      session.state.stale = !!(graph.head && cached.head && graph.head !== cached.head);
      session.state.fromCache = true;
      session.state.status = "ready";
      emit();
      return;
    }
  }

  refreshGoApps(graph);
  session.state.status = "analyzing";
  emit();
}

/* ------------------------------- rescans ------------------------------- */

/**
 * Re-reads the files in place: a new static graph, with everything you made
 * kept. Used when the repo changes under the map (a pull, a checkout,
 * deleted files) and before re-charting, so the chart is drawn from the
 * code as it is now.
 */
let rescanning: Promise<void> | null = null;
/** Run after every rescan with the files it found that weren't there before (moves aside). */
export const afterRescan: ((added: string[]) => unknown)[] = [];

/** The files git saw move between two commits (and the folders they took with them). */
async function renamesBetween(root: string, from: string, to: string): Promise<Renames> {
  const { stdout } = await run("git", ["diff", "--find-renames", "--name-status", "-z", from, to], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const parts = stdout.split("\0");
  const files: [string, string][] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    if (status[0] === "R" || status[0] === "C") {
      const [a, b] = [parts[i++], parts[i++]];
      if (status[0] === "R") files.push([a, b]);
    } else i++;
  }
  const onMap = session.idx?.graph.files.map((f) => f.path) ?? [];
  const dirs = movedDirs(files, (d) => onMap.some((p) => p.startsWith(`${d}/`)));
  return { files, dirs };
}

/**
 * Rewrites everything kept by path — modules, groupings, markers, notes,
 * answers, the saved filter — to where the files went. The open page gets
 * the same renames, for the filter it holds.
 */
export function applyRenames(r: Renames) {
  const to = renamer(r);
  const all = (ps: string[]) => [...new Set(ps.map(to))];
  const s = session.state;
  if (s.overview) {
    s.overview = {
      ...s.overview,
      modules: s.overview.modules.map((m) => ({ ...m, paths: all(m.paths) })),
      topics: s.overview.topics.map((t) => ({ ...t, paths: all(t.paths) })),
      entryPoints: all(s.overview.entryPoints),
    };
  }
  s.lenses = s.lenses.map((l) => ({ ...l, groups: l.groups.map((g) => ({ ...g, paths: all(g.paths) })) }));
  s.overlays = s.overlays.map((o) => ({
    ...o,
    paths: all(o.paths),
    reasons: o.reasons && Object.fromEntries(Object.entries(o.reasons).map(([p, why]) => [to(p), why])),
  }));
  s.notes = s.notes.map((n) => ({
    ...n,
    target: n.target.kind === "file" ? { ...n.target, path: to(n.target.path) } : { ...n.target, from: to(n.target.from), to: to(n.target.to) },
  }));
  s.frames = s.frames.map((f) => ({ ...f, focus: all(f.focus) }));
  if (s.view) {
    s.view = {
      ...s.view,
      filter: s.view.filter && renameInFilter(s.view.filter, to),
      savedFilters: s.view.savedFilters?.map((v) => ({ ...v, filter: renameInFilter(v.filter, to) })),
    };
  }
  pushActivity({ kind: "tool", detail: `Followed ${r.files.length} renamed file${r.files.length === 1 ? "" : "s"}` });
  pushCommand({ cmd: "renamed", renames: r });
}

export function rescan(): Promise<void> {
  if (rescanning) return rescanning;
  rescanning = (async () => {
    const root = session.idx?.graph.root;
    if (!root) return;
    const graph = await scanRepo(root);
    if (session.idx?.graph.root !== root) return; // another repo opened meanwhile
    const before = session.idx.graph;
    session.idx = indexGraph(graph);
    // A pull, commit or checkout can move files; what's kept by path follows them.
    let moved: Renames | null = null;
    if (before.head && graph.head && before.head !== graph.head) {
      moved = await renamesBetween(root, before.head, graph.head).catch(() => null);
      if (moved?.files.length) applyRenames(moved);
    }
    const had = new Set([...before.files.map((f) => f.path), ...(moved?.files.map(([, to]) => to) ?? [])]);
    const added = graph.files.map((f) => f.path).filter((p) => !had.has(p));
    session.state.repo = { name: graph.name, root: graph.root, branch: graph.branch };
    refreshGoApps(graph);
    session.state.graphVersion++;
    // The chart is out of date once the code moved on from where it was drawn.
    if (session.state.overview && session.state.status === "ready") {
      session.state.stale = !!session.state.stale || graph.head !== session.chartedHead || graph.files.length !== before.files.length || graph.imports.length !== before.imports.length;
    }
    pushActivity({ kind: "tool", detail: `Rescanned: ${graph.totals.files} files and ${graph.imports.length} imports` });
    emit();
    void checkRemote(false);
    for (const hook of afterRescan) void Promise.resolve(hook(added)).catch((err) => console.error("[rescan]", err));
  })().finally(() => {
    rescanning = null;
  });
  return rescanning;
}

/**
 * Watches the repo for changes a rescan should pick up: a new HEAD, or a
 * different working-tree status (files added, deleted, modified). Cheap —
 * two git calls every few seconds — and the rescan itself is under a second.
 */
let watched: { root: string; key: string } | null = null;
setInterval(() => {
  const root = session.idx?.graph.root;
  if (!root || session.state.status === "scanning" || rescanning) return;
  Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: root }).then((r) => r.stdout.trim()),
    run("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout),
  ])
    .then(([head, status]) => {
      const key = `${head}\n${status}`;
      if (watched?.root !== root) watched = { root, key };
      else if (watched.key !== key) {
        watched.key = key;
        void rescan();
      }
    })
    .catch(() => {
      /* not a git repo: nothing to watch */
    });
}, 4000).unref();

/**
 * Watches the remote: fetches the branch's upstream every
 * CODEFLIGHT_FETCH_SECONDS (five minutes by default, 0 turns it off) and,
 * when it has commits HEAD doesn't, offers them. Pulling is yours to ask for
 * — the map never moves under you on its own.
 */
const FETCH_EVERY = Number(process.env.CODEFLIGHT_FETCH_SECONDS ?? 300) * 1000;
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
const git = (root: string, args: string[]) => run("git", args, { cwd: root, env: gitEnv, timeout: 120_000 }).then((r) => r.stdout.trim());
const gitError = (e: unknown) => ((e as { stderr?: string }).stderr?.trim() || (e as Error).message).split("\n").at(-1)!.slice(0, 300);

let checking: Promise<void> | null = null;
/** `fetch: false` only recounts against what was last fetched — after a rescan, say. */
export function checkRemote(fetch = true): Promise<void> {
  if (checking) return checking;
  checking = (async () => {
    const root = session.idx?.graph.root;
    if (!root) return;
    let upstream: string;
    try {
      upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    } catch {
      session.state.remote = undefined; // no upstream to compare against
      return;
    }
    const prev = session.state.remote;
    try {
      if (fetch) await git(root, ["fetch", "--quiet", "--no-tags", upstream.split("/")[0]]);
      const [ahead, behind] = (await git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).split(/\s+/).map(Number);
      const log = behind ? await git(root, ["log", "-n", "30", "--format=%h%x09%an%x09%ct%x09%s", "HEAD..@{u}"]) : "";
      const commits = log
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [short, author, at, ...subject] = l.split("\t");
          return { short, author, at: Number(at) * 1000, subject: subject.join("\t") };
        });
      if (session.idx?.graph.root !== root) return;
      session.state.remote = { upstream, ahead, behind, commits, checkedAt: fetch ? Date.now() : (prev?.checkedAt ?? Date.now()) };
    } catch (e) {
      if (session.idx?.graph.root !== root) return;
      session.state.remote = { ...(prev ?? { upstream, ahead: 0, behind: 0, commits: [] }), checkedAt: Date.now(), error: `Couldn't fetch ${upstream}: ${gitError(e)}` };
    }
    emit();
  })().finally(() => {
    checking = null;
  });
  return checking;
}
if (FETCH_EVERY > 0) setInterval(() => void checkRemote(), FETCH_EVERY).unref();

/**
 * Brings the upstream's commits in (fast-forward only: your own work is
 * never merged or rewritten), then rescans so the map shows them. The
 * overview is then marked stale, and re-charting is offered as usual.
 */
export async function pullRemote() {
  const root = session.idx?.graph.root;
  const remote = session.state.remote;
  if (!root || !remote) throw new Error("There's no upstream to pull from.");
  session.state.remote = { ...remote, pulling: true, error: undefined };
  emit();
  try {
    await git(root, ["fetch", "--quiet", "--no-tags", remote.upstream.split("/")[0]]);
    await git(root, ["merge", "--ff-only", "--quiet", "@{u}"]);
  } catch (e) {
    session.state.remote = { ...remote, pulling: false, error: `Couldn't pull ${remote.upstream}: ${gitError(e)}` };
    emit();
    return;
  }
  pushActivity({ kind: "tool", detail: `Pulled ${remote.behind} commit${remote.behind === 1 ? "" : "s"} from ${remote.upstream}` });
  // A rescan or count already under way read the tree before the pull: let
  // it finish, then run fresh ones.
  await rescanning?.catch(() => undefined);
  await rescan();
  await checking?.catch(() => undefined);
  await checkRemote(false);
}

/* ----------------------------- persistence ----------------------------- */

type Cached = {
  /** The commit the overview was charted at. */
  head?: string;
  overview?: Overview;
  view?: ViewSettings;
  lenses?: Lens[];
  overlays?: GroupOverlay[];
  notes?: Note[];
  frames: Frame[];
  stories?: Story[];
  agents?: AgentRun[];
  agentSessionId?: string;
};

function cacheFile(root: string) {
  return path.join(CACHE_DIR, `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);
}

async function loadCache(root: string): Promise<Cached | null> {
  try {
    const c = JSON.parse(await readFile(cacheFile(root), "utf8")) as Cached;
    return c && typeof c === "object" ? c : null;
  } catch {
    return null;
  }
}

/** A saved repo's headline, if the navigator has charted it. */
export async function savedHeadline(root: string) {
  return (await loadCache(root))?.overview?.headline;
}

/** Drop everything saved for a repo. */
export async function forgetSaved(root: string) {
  await rm(cacheFile(root), { force: true });
}

async function persist() {
  const s = session.state;
  // Nothing to keep until something has been made; and never write while a
  // repo is still being opened, or an empty state would overwrite a saved one.
  if (!s.repo || !session.idx || s.status === "scanning") return;
  if (!s.overview && !s.lenses.length && !s.overlays.length && !s.notes.length && !s.frames.length && !s.stories.length && !s.agents.length && !s.view) return;
  const body: Cached = {
    head: session.chartedHead,
    overview: s.overview,
    view: s.view,
    lenses: s.lenses,
    overlays: s.overlays,
    notes: s.notes,
    frames: s.frames,
    stories: s.stories,
    agents: s.agents,
    agentSessionId: session.agentSessionId,
  };
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile(s.repo.root), JSON.stringify(body));
  } catch (err) {
    console.error("[session] could not save cache:", err);
  }
}

/** Called when a fresh overview lands: it now describes the current commit. */
export function markCharted() {
  session.chartedHead = session.idx?.graph.head;
  session.state.stale = false;
}
