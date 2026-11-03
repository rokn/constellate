import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyOps, newId, type Board, type BoardCommand, type BoardSummary, type Op } from "../../shared/board";
import { CACHE_DIR } from "../session";

/**
 * The workshop's boards. Each is a JSON file under .cache/boards, held in
 * memory while anyone has it open. Every change goes through `change`, which
 * applies ops, keeps a step to undo, saves a moment later, and pushes the new
 * board to everyone watching it.
 */

const DIR = path.join(CACHE_DIR, "boards");
const UNDO_LIMIT = 120;
/** Changes with the same merge key this close together are one step to undo (a drag, a stroke). */
const MERGE_MS = 1500;
const SAVE_MS = 600;

type Live = {
  board: Board;
  undo: string[];
  redo: string[];
  lastMerge: { key: string; at: number } | null;
  saveTimer?: ReturnType<typeof setTimeout>;
  /** The agent's conversation on this board, so it remembers what you asked before. */
  agentSession?: string;
};

const live = new Map<string, Live>();
type Listener = (b: Board) => void;
const listeners = new Map<string, Set<Listener>>();
type CommandListener = (c: BoardCommand) => void;
const commandListeners = new Map<string, Set<CommandListener>>();

const fileOf = (id: string) => path.join(DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);

const summary = (b: Board): BoardSummary => ({
  id: b.id,
  name: b.name,
  updatedAt: b.updatedAt,
  createdAt: b.createdAt,
  items: b.items.length,
  projectId: b.projectId,
  parent: b.parent?.boardId,
  itemId: b.parent?.itemId,
  repo: b.repo?.root,
  linked: b.items.filter((i) => i.code?.module || i.code?.paths?.length).length,
});

/** Every board (or one project's), most recently changed first. */
export async function listBoards(projectId?: string): Promise<BoardSummary[]> {
  await mkdir(DIR, { recursive: true });
  const out: BoardSummary[] = [];
  for (const f of await readdir(DIR)) {
    if (!f.endsWith(".json") || f.endsWith(".versions.json")) continue;
    const id = f.slice(0, -5);
    const held = live.get(id)?.board;
    if (held) {
      out.push(summary(held));
      continue;
    }
    try {
      const b = JSON.parse(await readFile(path.join(DIR, f), "utf8")) as Board;
      if (b?.id && Array.isArray(b.items)) out.push(summary(b));
    } catch {
      // A half-written or foreign file: not a board.
    }
  }
  return out.filter((b) => !projectId || b.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getBoard(id: string): Promise<Live | null> {
  const held = live.get(id);
  if (held) return held;
  try {
    const raw = JSON.parse(await readFile(fileOf(id), "utf8")) as Board & { agentSession?: string };
    const { agentSession, ...board } = raw;
    board.activity = undefined;
    const l: Live = { board, undo: [], redo: [], lastMerge: null, agentSession };
    live.set(id, l);
    return l;
  } catch {
    return null;
  }
}

/**
 * A new board: in a project, and under another board when `parent` is given
 * (filed under it, like a folder in a folder; it takes its project and repo).
 */
export async function createBoard(name: string, o: { projectId?: string; parent?: string; repo?: Board["repo"] } = {}): Promise<Board> {
  const now = Date.now();
  const board: Board = { id: newId("b"), name: name.trim().slice(0, 80) || "Untitled board", items: [], links: [], createdAt: now, updatedAt: now, rev: 1 };
  const up = o.parent ? (await getBoard(o.parent))?.board : undefined;
  if (up) board.parent = { boardId: up.id, name: up.name };
  const projectId = o.projectId ?? up?.projectId;
  if (projectId) board.projectId = projectId;
  const repo = o.repo ?? up?.repo;
  if (repo) board.repo = { ...repo };
  live.set(board.id, { board, undo: [], redo: [], lastMerge: null });
  await save(board.id);
  return board;
}

/** Delete a board, and every board nested under it. Returns how many went. */
export async function deleteBoard(id: string): Promise<number> {
  const all = await listBoards();
  const doomed = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const b of all) if (b.parent && doomed.has(b.parent) && !doomed.has(b.id)) (doomed.add(b.id), (grew = true));
  }
  for (const d of doomed) {
    const l = live.get(d);
    clearTimeout(l?.saveTimer);
    live.delete(d);
    await rm(fileOf(d), { force: true });
    await rm(versionFile(d), { force: true });
  }
  // An item whose inside was deleted no longer has one.
  const up = all.find((b) => b.id === id);
  if (up?.parent && up.itemId) await change(up.parent, [{ op: "update", id: up.itemId, patch: { sub: undefined } }], undefined, { noUndo: true }).catch(() => null);
  return doomed.size;
}

/** File a board under another (null: at the top of its project). Never under itself or its own nested boards. */
export async function moveBoard(id: string, parent: string | null): Promise<boolean> {
  const l = await getBoard(id);
  if (!l) return false;
  if (parent) {
    const all = await listBoards();
    for (let at: string | undefined = parent; at; at = all.find((b) => b.id === at)?.parent) if (at === id) return false;
    const up = (await getBoard(parent))?.board;
    if (!up) return false;
    l.board.parent = { boardId: up.id, name: up.name };
    if (up.projectId) l.board.projectId = up.projectId;
  } else {
    // An item's inside taken out to the top stays linked from the item: it's just filed elsewhere.
    l.board.parent = undefined;
  }
  touch(l);
  return true;
}

/** Set fields that aren't edits to undo: which project a board is in. */
export async function assignProject(id: string, projectId: string) {
  const l = await getBoard(id);
  if (!l || l.board.projectId === projectId) return;
  l.board.projectId = projectId;
  saveSoon(id);
  publish(l);
}

async function save(id: string) {
  const l = live.get(id);
  if (!l) return;
  await mkdir(DIR, { recursive: true });
  const { activity: _a, ...board } = l.board;
  const tmp = `${fileOf(id)}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...board, agentSession: l.agentSession }));
  await rename(tmp, fileOf(id));
}

function saveSoon(id: string) {
  const l = live.get(id);
  if (!l) return;
  clearTimeout(l.saveTimer);
  l.saveTimer = setTimeout(() => void save(id).catch((e) => console.error("[board] save failed:", e)), SAVE_MS);
}

function snapshot(b: Board) {
  return JSON.stringify({ name: b.name, items: b.items, links: b.links, xlinks: b.xlinks ?? [] });
}

function publish(l: Live) {
  for (const f of listeners.get(l.board.id) ?? []) f(l.board);
}

/** Apply ops to a board: one step to undo, saved, and pushed to everyone on it. */
export async function change(id: string, ops: Op[], merge?: string, o: { noUndo?: boolean } = {}): Promise<Board | null> {
  const l = await getBoard(id);
  if (!l) return null;
  const before = snapshot(l.board);
  if (!applyOps(l.board, ops)) return l.board;
  const now = Date.now();
  // A "run:" key is one request to the assistant: all it does is one step to undo, however long it takes.
  const merging = o.noUndo || (merge && l.lastMerge?.key === merge && (merge.startsWith("run:") || now - l.lastMerge.at < MERGE_MS));
  if (!merging) {
    l.undo.push(before);
    if (l.undo.length > UNDO_LIMIT) l.undo.shift();
  }
  l.lastMerge = merge ? { key: merge, at: now } : null;
  l.redo = [];
  touch(l);
  if (!o.noUndo) noteChange(id);
  return l.board;
}

function touch(l: Live) {
  l.board.rev++;
  l.board.updatedAt = Date.now();
  saveSoon(l.board.id);
  publish(l);
}

function restore(l: Live, snap: string) {
  const s = JSON.parse(snap) as Pick<Board, "name" | "items" | "links" | "xlinks">;
  l.board.name = s.name;
  l.board.items = s.items;
  l.board.links = s.links;
  l.board.xlinks = s.xlinks ?? [];
}

export async function undo(id: string): Promise<boolean> {
  const l = await getBoard(id);
  const snap = l?.undo.pop();
  if (!l || !snap) return false;
  l.redo.push(snapshot(l.board));
  restore(l, snap);
  l.lastMerge = null;
  touch(l);
  return true;
}

export async function redo(id: string): Promise<boolean> {
  const l = await getBoard(id);
  const snap = l?.redo.pop();
  if (!l || !snap) return false;
  l.undo.push(snapshot(l.board));
  restore(l, snap);
  l.lastMerge = null;
  touch(l);
  return true;
}

/**
 * The undo history as boards, for scrubbing through: what it was N steps
 * back (undo, positive) or forward (redo, negative), nearest first.
 */
export async function historyStates(id: string, max = 40): Promise<{ back: Pick<Board, "name" | "items" | "links">[]; forward: Pick<Board, "name" | "items" | "links">[] } | null> {
  const l = await getBoard(id);
  if (!l) return null;
  const parse = (s: string) => JSON.parse(s) as Pick<Board, "name" | "items" | "links">;
  return { back: l.undo.slice(-max).reverse().map(parse), forward: l.redo.slice(-max).reverse().map(parse) };
}

/** Go back (steps > 0) or forward (steps < 0) through the undo history in one go. */
export async function rewind(id: string, steps: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < Math.abs(steps); i++) {
    if (!(await (steps > 0 ? undo(id) : redo(id)))) break;
    n++;
  }
  return n;
}

/** The assistant's status on a board: shown on every screen, never saved. */
export function setActivity(id: string, a: Board["activity"]) {
  const l = live.get(id);
  if (!l) return;
  l.board.activity = a;
  publish(l);
}

export function agentSessionOf(id: string) {
  return live.get(id)?.agentSession;
}

export function setAgentSession(id: string, s: string | undefined) {
  const l = live.get(id);
  if (!l || l.agentSession === s) return;
  l.agentSession = s;
  saveSoon(id);
}

export function watch(id: string, f: Listener): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(f);
  // A board stays in memory once opened, while the server runs: dropping it would lose its undo history.
  return () => set!.delete(f);
}

/** Screen commands (select, focus) for everyone on a board: they don't change it. */
export function command(id: string, c: BoardCommand) {
  for (const f of commandListeners.get(id) ?? []) f(c);
}

export function onCommand(id: string, f: CommandListener): () => void {
  let set = commandListeners.get(id);
  if (!set) commandListeners.set(id, (set = new Set()));
  set.add(f);
  return () => set!.delete(f);
}

/* ------------------------------- versions ------------------------------- */

/**
 * Versions: the board as it was, kept apart from it (boards/<id>.versions.json).
 * One is kept before each request to the assistant, before a template or a
 * restore lands, when you save one, and every so often as you work.
 */
export type Version = { id: string; at: number; label: string; items: Board["items"]; links: Board["links"]; name: string };
export type VersionSummary = { id: string; at: number; label: string; items: number; links: number };

const VERSIONS_KEEP = 60;
const AUTO_EVERY = 40;
const AUTO_MS = 5 * 60_000;
const versionFile = (id: string) => path.join(DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "")}.versions.json`);
const sinceVersion = new Map<string, { changes: number; at: number }>();

async function readVersions(id: string): Promise<Version[]> {
  try {
    return JSON.parse(await readFile(versionFile(id), "utf8")) as Version[];
  } catch {
    return [];
  }
}

export async function listVersions(id: string): Promise<VersionSummary[]> {
  return (await readVersions(id)).map((v) => ({ id: v.id, at: v.at, label: v.label, items: v.items.length, links: v.links.length })).reverse();
}

export async function getVersion(id: string, vid: string): Promise<Version | null> {
  return (await readVersions(id)).find((v) => v.id === vid) ?? null;
}

/** Keep the board as it is now, under a label. Nothing is kept if it hasn't changed since the last one. */
export async function saveVersion(id: string, label: string): Promise<VersionSummary | null> {
  const l = await getBoard(id);
  if (!l) return null;
  const list = await readVersions(id);
  const last = list[list.length - 1];
  if (last && JSON.stringify([last.items, last.links]) === JSON.stringify([l.board.items, l.board.links])) return null;
  if (!l.board.items.length && !last) return null;
  const v: Version = { id: newId("v"), at: Date.now(), label: label.slice(0, 120) || "Saved", items: structuredClone(l.board.items), links: structuredClone(l.board.links), name: l.board.name };
  const next = [...list, v].slice(-VERSIONS_KEEP);
  await mkdir(DIR, { recursive: true });
  await writeFile(versionFile(id), JSON.stringify(next));
  sinceVersion.set(id, { changes: 0, at: Date.now() });
  return { id: v.id, at: v.at, label: v.label, items: v.items.length, links: v.links.length };
}

/** Put a version back: one step to undo, with the board as it was kept first. */
export async function restoreVersion(id: string, vid: string): Promise<boolean> {
  const l = await getBoard(id);
  const v = await getVersion(id, vid);
  if (!l || !v) return false;
  await saveVersion(id, "Before going back");
  l.undo.push(snapshot(l.board));
  l.redo = [];
  l.lastMerge = null;
  l.board.items = structuredClone(v.items);
  l.board.links = structuredClone(v.links);
  touch(l);
  return true;
}

/** Count a change; now and then, a version on its own. */
export function noteChange(id: string) {
  const s = sinceVersion.get(id) ?? { changes: 0, at: Date.now() };
  s.changes++;
  sinceVersion.set(id, s);
  if (s.changes >= AUTO_EVERY && Date.now() - s.at > AUTO_MS) void saveVersion(id, "Autosave");
}

/* ------------------------------ inside boards ---------------------------- */

/** The board inside an item, made the first time it's opened. */
export async function boardInside(id: string, itemId: string): Promise<Board | null> {
  const l = await getBoard(id);
  const item = l?.board.items.find((i) => i.id === itemId);
  if (!l || !item) return null;
  if (item.sub) {
    const inner = await getBoard(item.sub);
    if (inner) return inner.board;
  }
  const label = item.label || item.kind;
  const inner = await createBoard(`${l.board.name} › ${label}`);
  inner.parent = { boardId: id, itemId, name: l.board.name };
  if (l.board.projectId) inner.projectId = l.board.projectId;
  // Inside a block drawn from code, the same code: its inside can be read and linked too.
  if (l.board.repo) inner.repo = { ...l.board.repo };
  saveSoon(inner.id);
  await change(id, [{ op: "update", id: itemId, patch: { sub: inner.id } }], undefined, { noUndo: true });
  return inner;
}

/* -------------------------------- presence ------------------------------- */

type PresenceListener = (p: unknown) => void;
const presenceListeners = new Map<string, Set<PresenceListener>>();

/** Someone's head, hands or camera: passed to everyone else on the board, never kept. */
export function presence(id: string, p: unknown) {
  for (const f of presenceListeners.get(id) ?? []) f(p);
}

export function onPresence(id: string, f: PresenceListener): () => void {
  let set = presenceListeners.get(id);
  if (!set) presenceListeners.set(id, (set = new Set()));
  set.add(f);
  return () => set!.delete(f);
}
