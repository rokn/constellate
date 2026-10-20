import { readFile } from "node:fs/promises";
import path from "node:path";
import { findPath, type GraphIndex } from "./scan";

/**
 * File access for the browser and for the navigator's show tools. Every path
 * is resolved against the scanned map first, which is both the containment
 * check (nothing outside the repo is on the map) and the forgiveness for a
 * path a model or a voice got nearly right.
 */

const MAX_CHARS = 400_000;
export const MAX_SLICE_LINES = 220;

export type Loaded = { path: string; text: string; lines: string[] };

export async function loadFile(idx: GraphIndex, guess: string): Promise<Loaded | null> {
  const p = findPath(idx, guess);
  if (!p) return null;
  const abs = path.join(idx.graph.root, p);
  // findPath only ever returns scanned paths, but a symlink could still point
  // out of the tree — the resolved location has to stay inside the root.
  if (!path.resolve(abs).startsWith(idx.graph.root + path.sep)) return null;
  try {
    const text = (await readFile(abs, "utf8")).slice(0, MAX_CHARS);
    return { path: p, text, lines: text.split("\n") };
  } catch {
    return null;
  }
}

/**
 * Verbatim lines, clamped to the file and to a size that still reads as an
 * excerpt. The model picks the range; it never supplies the text.
 */
export function slice(file: Loaded, start: number, end: number) {
  const s = Math.max(1, Math.min(start, file.lines.length));
  let e = Math.max(s, Math.min(end, file.lines.length));
  if (e - s + 1 > MAX_SLICE_LINES) e = s + MAX_SLICE_LINES - 1;
  return { start: s, end: e, code: file.lines.slice(s - 1, e).join("\n") };
}
