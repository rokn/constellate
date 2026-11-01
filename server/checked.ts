import { checkedKeys, countChecked, linkKey, linksOf, type LinkDir, type LinkEnds } from "../shared/checked";
import type { Action, ActionContext } from "./actions";
import { findPath } from "./scan";
import { clearChecked, session, setChecked } from "./session";

/**
 * Marking connections checked (reviewed, safe), by voice or typed into Ask:
 * one import line, all of a file's (or just the inbound or outbound ones),
 * or every one in the repo; and how far the review has got. The marks live
 * on the server with the notes, so every device sees them.
 */

const str = (args: Record<string, unknown>, k: string) => String(args[k] ?? "").trim();
const name = (p: string) => p.split("/").pop()!;

/** A file by a path or a close guess; "shared/checked" finds shared/checked.ts before server/checked.ts. */
function find(guess: string): string | null {
  const idx = session.idx;
  if (!idx) return null;
  const g = guess.trim().replace(/^\.?\//, "").toLowerCase();
  const bare = idx.graph.files.map((f) => f.path).filter((p) => p.toLowerCase().replace(/\.[^./]+$/, "").endsWith(g));
  if (g.includes("/") && bare.length) return bare.sort((a, b) => a.length - b.length)[0];
  return findPath(idx, guess);
}

/** The file asked about, else the one open on their screen. */
function fileFrom(args: Record<string, unknown>, ctx: ActionContext, key = "path"): string | null {
  const asked = str(args, key);
  if (asked) return find(asked);
  return ctx.screen.openFile?.path ?? null;
}

const dirOf = (v: string): LinkDir => (v === "in" || v === "out" ? v : "both");

export const CHECK_ACTIONS: Action[] = [
  {
    name: "mark_checked",
    description: [
      "Mark import connections checked (reviewed, safe), or take the mark off. Instant; checked lines turn green on the map and can be hidden.",
      "One connection: path and other (the two files, either way round). All of a file's: just path (left out, the file open on their screen), with direction in (what imports it), out (what it imports) or both.",
      "scope=all marks (or with checked=no clears) every connection in the repo: only when they clearly ask for all of them.",
    ].join(" "),
    properties: {
      path: { type: "string", description: "The file; a close guess like 'auth/session' is fine. Left out: the open file" },
      other: { type: "string", description: "Only the connection between path and this file" },
      direction: { type: "string", description: "in, out or both (the default): which of the file's connections" },
      checked: { type: "string", description: "yes (the default) to mark checked, no to take the mark off" },
      scope: { type: "string", description: "all: every connection in the repo" },
    },
    required: [],
    run: (args, ctx) => {
      const idx = session.idx;
      if (!idx) return { ok: false, error: "No repository is open." };
      const on = !/^(no|false|off|0|uncheck|unchecked|clear)$/i.test(str(args, "checked"));
      const imports = idx.graph.imports;
      let links: LinkEnds[];
      let what: string;
      if (str(args, "scope").toLowerCase() === "all") {
        if (!on) {
          const n = clearChecked().length;
          return { ok: true, cleared: n, say: n ? `Say in a few words that all ${n} marks are off.` : "Nothing was checked." };
        }
        links = uniqueImports(imports);
        what = "every connection";
      } else {
        const path = fileFrom(args, ctx);
        if (!path) return { ok: false, error: str(args, "path") ? `No file matches "${str(args, "path")}".` : "No file is open: say which file." };
        const all = linksOf(imports, path, dirOf(str(args, "direction")));
        if (str(args, "other")) {
          const other = find(str(args, "other"));
          if (!other) return { ok: false, error: `No file matches "${str(args, "other")}".` };
          links = all.filter((l) => l.from === other || l.to === other);
          if (!links.length) return { ok: false, error: `${name(path)} and ${name(other)} don't import each other.` };
          what = `${name(path)} ↔ ${name(other)}`;
        } else {
          links = all;
          if (!links.length) return { ok: false, error: `${name(path)} has no ${dirOf(str(args, "direction")) === "both" ? "" : `${str(args, "direction")}bound `}connections.` };
          const way = { in: "inbound ", out: "outbound ", both: "" }[dirOf(str(args, "direction"))];
          what = `${links.length} ${way}connection${links.length === 1 ? "" : "s"} of ${name(path)}`;
        }
      }
      const changed = setChecked(links, on);
      const every = uniqueImports(imports);
      return { ok: true, [on ? "checked" : "unchecked"]: what, changed, repo: { checked: countChecked(every, checkedKeys(session.state.checked)), total: every.length } };
    },
  },
  {
    name: "checked_status",
    description: "How far the review of connections has got: for a file (or the open one), which of its connections are checked and which are still to check; and the count for the whole repo.",
    properties: {
      path: { type: "string", description: "The file; left out, the open file (or just the repo's count)" },
    },
    required: [],
    run: (args, ctx) => {
      const idx = session.idx;
      if (!idx) return { ok: false, error: "No repository is open." };
      const keys = checkedKeys(session.state.checked);
      const all = uniqueImports(idx.graph.imports);
      const repo = { checked: countChecked(all, keys), total: all.length };
      const path = fileFrom(args, ctx);
      if (!path) return { ok: true, repo };
      const mine = linksOf(idx.graph.imports, path);
      const open = mine.filter((l) => !keys.has(linkKey(l.from, l.to)));
      const side = (l: LinkEnds) => (l.from === path ? `imports ${l.to}` : `imported by ${l.from}`);
      return { ok: true, file: path, checked: mine.length - open.length, total: mine.length, toCheck: open.slice(0, 30).map(side), repo };
    },
  },
];

/** Every distinct import line, once. */
function uniqueImports(imports: readonly LinkEnds[]): LinkEnds[] {
  const seen = new Set<string>();
  const out: LinkEnds[] = [];
  for (const e of imports) {
    const k = linkKey(e.from, e.to);
    if (e.from !== e.to && !seen.has(k)) seen.add(k), out.push({ from: e.from, to: e.to });
  }
  return out;
}

/** Carries out a checked-marks action; null when `name` isn't one. */
export function runChecked(name: string, args: Record<string, unknown>, ctx: ActionContext): Record<string, unknown> | null {
  const a = CHECK_ACTIONS.find((x) => x.name === name);
  return a ? a.run(args, ctx) : null;
}
