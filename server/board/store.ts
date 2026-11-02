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

export async function listBoards(): Promise<BoardSummary[]> {
  await mkdir(DIR, { recursive: true });
  const out: BoardSummary[] = [];
  for (const f of await readdir(DIR)) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    const held = live.get(id)?.board;
    if (held) {
      out.push({ id, name: held.name, updatedAt: held.updatedAt, items: held.items.length });
      continue;
    }
    try {
      const b = JSON.parse(await readFile(path.join(DIR, f), "utf8")) as Board;
      out.push({ id, name: b.name, updatedAt: b.updatedAt, items: b.items.length });
    } catch {
      // A half-written or foreign file: not a board.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
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

export async function createBoard(name: string): Promise<Board> {
  const now = Date.now();
  const board: Board = { id: newId("b"), name: name.trim().slice(0, 80) || "Untitled board", items: [], links: [], createdAt: now, updatedAt: now, rev: 1 };
  live.set(board.id, { board, undo: [], redo: [], lastMerge: null });
  await save(board.id);
  return board;
}

export async function deleteBoard(id: string) {
  const l = live.get(id);
  clearTimeout(l?.saveTimer);
  live.delete(id);
  await rm(fileOf(id), { force: true });
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
  return JSON.stringify({ name: b.name, items: b.items, links: b.links });
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
  return l.board;
}

function touch(l: Live) {
  l.board.rev++;
  l.board.updatedAt = Date.now();
  saveSoon(l.board.id);
  publish(l);
}

function restore(l: Live, snap: string) {
  const s = JSON.parse(snap) as Pick<Board, "name" | "items" | "links">;
  l.board.name = s.name;
  l.board.items = s.items;
  l.board.links = s.links;
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
