import type { Part } from "../../shared/board";
import { change, getBoard } from "./store";

/**
 * Scripted holograms. The agent can describe a hologram as a script that
 * returns its parts (for gears with sixty teeth, a lattice, a helix). The
 * server never runs it: the browser does, in a sandboxed iframe with a worker
 * and a time limit, and reports the parts back. The first screen to build it
 * wins; the parts are kept on the item, so other screens (and the next
 * session) don't build it again.
 */

type Waiter = { resolve: (r: BuildResult) => void; timer: ReturnType<typeof setTimeout> };
export type BuildResult = { ok: true; parts: number } | { ok: false; error: string } | { ok: null; reason: string };

const waiting = new Map<string, Waiter[]>();
const key = (boardId: string, itemId: string, script: string) => `${boardId}:${itemId}:${hash(script)}`;

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Wait (up to `ms`) for a screen to build a script; the agent gets its errors back to fix them. */
export function awaitBuild(boardId: string, itemId: string, script: string, ms = 6000): Promise<BuildResult> {
  return new Promise((resolve) => {
    const k = key(boardId, itemId, script);
    const w: Waiter = {
      resolve,
      timer: setTimeout(() => {
        waiting.set(k, (waiting.get(k) ?? []).filter((x) => x !== w));
        resolve({ ok: null, reason: "No screen built it in time (none open, or it's slow). It will build when one opens." });
      }, ms),
    };
    waiting.set(k, [...(waiting.get(k) ?? []), w]);
  });
}

/** A browser built a script: keep its parts (or its error) on the item. */
export async function reportBuild(boardId: string, itemId: string, script: string, res: { parts?: Part[]; error?: string }) {
  const l = await getBoard(boardId);
  const item = l?.board.items.find((i) => i.id === itemId);
  // Built from a script that's since been replaced: nothing to keep.
  if (!item || item.holo?.script !== script) return;
  if (item.holo.builtFrom !== script || item.holo.error !== res.error) {
    const holo = res.error ? { ...item.holo, error: res.error, builtFrom: script } : { ...item.holo, parts: res.parts ?? [], error: undefined, builtFrom: script };
    await change(boardId, [{ op: "update", id: itemId, patch: { holo } }], undefined, { noUndo: true });
  }
  const k = key(boardId, itemId, script);
  for (const w of waiting.get(k) ?? []) {
    clearTimeout(w.timer);
    w.resolve(res.error ? { ok: false, error: res.error } : { ok: true, parts: res.parts?.length ?? 0 });
  }
  waiting.delete(k);
}
