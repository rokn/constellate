import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Activity,
  Frame,
  GroupOverlay,
  Lens,
  Note,
  NoteTarget,
  Overview,
  SessionState,
  ViewSettings,
  UiCommand,
  View,
} from "../shared/types";
import { indexGraph, scanRepo, type GraphIndex } from "./scan";

/**
 * One open repository, one session. The server is a local tool — one person,
 * one repo at a time — so this is a module-level singleton rather than a
 * store keyed by id. Everything that changes goes through a mutation here,
 * and every mutation emits, so the browser's view is never a poll away.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable so a second server (a test run, another worktree) can work on
// the same repo without writing over the main session's saved state.
const CACHE_DIR = process.env.CODEFLIGHT_CACHE_DIR ?? path.join(HERE, "..", ".cache");

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
    activity: [],
    commands: [],
    busy: false,
    fromCache: false,
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
  if (!lens) return undefined;
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
  session.state.overlays = session.state.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o));
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

export async function openRepo(root: string, opts: { rechart?: boolean } = {}) {
  const abs = path.resolve(root.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  session.state = {
    status: "scanning",
    repo: { name: path.basename(abs), root: abs },
    graphVersion: session.state.graphVersion + 1,
    lenses: [],
    overlays: [],
    notes: [],
    frames: [],
    activity: [],
    commands: [],
    busy: false,
    fromCache: false,
  };
  session.idx = undefined;
  session.agentSessionId = undefined;
  session.chartedHead = undefined;
  emit();

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

  // Everything you made comes back regardless of commit — groupings, groups,
  // answers, your view. Only the overview's freshness depends on the commit:
  // if the code moved on, the old map is kept and marked stale rather than
  // thrown away, and re-charting is your call.
  const cached = await loadCache(graph.root);
  if (cached) {
    session.state.lenses = cached.lenses ?? [];
    session.state.overlays = cached.overlays ?? [];
    session.state.notes = cached.notes ?? [];
    session.state.view = cached.view;
    session.state.frames = (cached.frames ?? []).map((f) =>
      f.state === "working" ? { ...f, state: "error", error: "Interrupted by a restart." } : f,
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

  session.state.status = "analyzing";
  emit();
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

async function persist() {
  const s = session.state;
  // Nothing to keep until something has been made; and never write while a
  // repo is still being opened, or an empty state would overwrite a saved one.
  if (!s.repo || !session.idx || s.status === "scanning") return;
  if (!s.overview && !s.lenses.length && !s.overlays.length && !s.notes.length && !s.frames.length && !s.view) return;
  const body: Cached = {
    head: session.chartedHead,
    overview: s.overview,
    view: s.view,
    lenses: s.lenses,
    overlays: s.overlays,
    notes: s.notes,
    frames: s.frames,
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
