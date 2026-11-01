import type { ImportEdge } from "./types";

/**
 * Connections you've reviewed: import lines marked checked (safe). Kept per
 * repo with your notes, drawn apart from the ones still to look at, and
 * offered as a filter, so a review can be walked down to what's left.
 */

/** One import line marked checked: `from` imports `to`. */
export type CheckedLink = { from: string; to: string; at: number };

export type LinkEnds = { from: string; to: string };

/** Which of a file's connections: what it imports (out), what imports it (in), or both. */
export type LinkDir = "in" | "out" | "both";

export const linkKey = (from: string, to: string) => `${from}\u0000${to}`;

export const checkedKeys = (list: readonly CheckedLink[] | undefined) => new Set((list ?? []).map((c) => linkKey(c.from, c.to)));

/** A file's import lines, one way or both. */
export function linksOf(imports: readonly ImportEdge[], path: string, dir: LinkDir = "both"): LinkEnds[] {
  const out: LinkEnds[] = [];
  const seen = new Set<string>();
  for (const e of imports) {
    if (e.from === e.to) continue;
    const hit = (dir !== "in" && e.from === path) || (dir !== "out" && e.to === path);
    const k = linkKey(e.from, e.to);
    if (hit && !seen.has(k)) {
      seen.add(k);
      out.push({ from: e.from, to: e.to });
    }
  }
  return out;
}

/** How many of these lines are checked. */
export const countChecked = (links: readonly LinkEnds[], checked: ReadonlySet<string>) => links.filter((l) => checked.has(linkKey(l.from, l.to))).length;

/** Files with at least one import line, every one of them checked: what the "hide checked" filter takes off. */
export function fullyChecked(imports: readonly ImportEdge[], checked: ReadonlySet<string>): Set<string> {
  if (!checked.size) return new Set();
  const open = new Set<string>();
  const any = new Set<string>();
  for (const e of imports) {
    if (e.from === e.to) continue;
    any.add(e.from);
    any.add(e.to);
    if (!checked.has(linkKey(e.from, e.to))) {
      open.add(e.from);
      open.add(e.to);
    }
  }
  return new Set([...any].filter((p) => !open.has(p)));
}
