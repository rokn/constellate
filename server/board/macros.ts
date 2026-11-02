import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BOARD_ACTIONS, findAction } from "../../shared/boardActions";
import type { BoardScreen } from "../../shared/board";
import { CACHE_DIR } from "../session";
import { askBoard } from "./agent";
import { command, saveVersion } from "./store";

/**
 * Voice macros: a phrase you taught it ("ship it") and the steps it runs, in
 * order — actions on your screens (a snapshot, desk mode, save a version) or
 * requests for the builder ("review the design and flag the risks"). Kept on
 * the server, for every device.
 */

export type Macro = { phrase: string; steps: string[] };
const FILE = path.join(CACHE_DIR, "board-macros.json");
let macros: Macro[] | null = null;

export async function loadMacros(): Promise<Macro[]> {
  if (macros) return macros;
  try {
    macros = JSON.parse(await readFile(FILE, "utf8")) as Macro[];
  } catch {
    macros = [];
  }
  return macros;
}

export async function saveMacros(list: Macro[]) {
  macros = list
    .filter((m) => m.phrase?.trim() && Array.isArray(m.steps) && m.steps.length)
    .map((m) => ({ phrase: m.phrase.trim().toLowerCase().slice(0, 60), steps: m.steps.map((s) => String(s).trim().slice(0, 400)).filter(Boolean).slice(0, 12) }));
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(macros, null, 1));
  return macros;
}

export async function findMacro(phrase: string): Promise<Macro | undefined> {
  const p = phrase.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const list = await loadMacros();
  return list.find((m) => m.phrase.replace(/[^a-z0-9 ]/g, "") === p) ?? list.find((m) => p.includes(m.phrase) || m.phrase.includes(p));
}

/** What a step is: an action on the screens, or words for the builder. */
export function stepKind(step: string): { action: string } | { ask: string } {
  const m = step.match(/^action:\s*(.+)$/i);
  const a = findAction(m ? m[1] : step);
  if (a && (m || a.id === step.trim() || a.label.toLowerCase() === step.trim().toLowerCase())) return { action: a.id };
  return { ask: step };
}

/** Run a macro's steps in order: actions at once, requests one after another, each waited for. */
export async function runMacro(m: Macro, boardId: string, screen: BoardScreen, said: (line: string) => void): Promise<string[]> {
  const done: string[] = [];
  for (const step of m.steps) {
    const k = stepKind(step);
    if ("action" in k) {
      if (k.action === "save-version") await saveVersion(boardId, `Macro: ${m.phrase}`);
      else command(boardId, { cmd: "action", id: k.action });
      done.push(BOARD_ACTIONS.find((a) => a.id === k.action)?.label ?? k.action);
      await new Promise((r) => setTimeout(r, 350));
    } else {
      said(k.ask);
      const r = await askBoard(boardId, k.ask, screen);
      done.push(r.error ? `${k.ask} (failed: ${r.error})` : r.answer || k.ask);
    }
  }
  return done;
}
