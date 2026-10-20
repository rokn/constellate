import { useEffect, useState } from "react";
import type { Commit, History, TimeRange } from "../../shared/types";

/**
 * History, as the map uses it. Everything here is computed in the browser from
 * one load of the log, so scrubbing a range is instant: no request per frame.
 */

export function useHistory(enabled: boolean, version: number | undefined) {
  const [history, setHistory] = useState<History | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch("/api/history")
      .then((r) => (r.ok ? (r.json() as Promise<History>) : null))
      .then((h) => live && setHistory(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, version]);
  return history;
}

/** Commits in a range, newest first, both ends included. */
export function commitsIn(h: History, r: TimeRange): Commit[] {
  const a = h.commits.findIndex((c) => c.sha === r.to || c.short === r.to);
  const b = h.commits.findIndex((c) => c.sha === r.from || c.short === r.from);
  if (a < 0 || b < 0) return [];
  return h.commits.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export type HeatEntry = { add: number; del: number; commits: number; status: "A" | "M" | "D"; authors: Set<string> };
export type Heat = Map<string, HeatEntry>;

/** Per file across the commits: lines in and out, how often, and its fate. */
export function heatOf(commits: Commit[]): Heat {
  const heat: Heat = new Map();
  // Oldest first, so the last status written is the file's fate in the range.
  for (const c of [...commits].reverse()) {
    for (const f of c.files) {
      const e = heat.get(f.path) ?? { add: 0, del: 0, commits: 0, status: f.status, authors: new Set<string>() };
      e.add += f.add;
      e.del += f.del;
      e.commits++;
      e.authors.add(c.author);
      // Born in the range stays "added" however much it changes afterwards.
      e.status = f.status === "D" ? "D" : e.status === "A" ? "A" : f.status;
      heat.set(f.path, e);
    }
  }
  return heat;
}

export type Coupling = { a: string; b: string; count: number; strength: number };

/**
 * Files that change together. Two files committed together again and again
 * are coupled whether or not either imports the other: the hidden dependency
 * history shows and the import graph can't. Sweeping commits (formatting,
 * renames, dependency bumps) touch everything and mean nothing, so they're
 * left out.
 */
export function couplingsOf(commits: Commit[], onMap: Set<string>, limit = 150): Coupling[] {
  const changes = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const c of commits) {
    const files = c.files.map((f) => f.path).filter((p) => onMap.has(p));
    if (files.length < 2 || files.length > 30) continue;
    for (const p of files) changes.set(p, (changes.get(p) ?? 0) + 1);
    files.sort();
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const k = `${files[i]}\u0000${files[j]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    }
  }
  const out: Coupling[] = [];
  for (const [k, count] of pairs) {
    if (count < 2) continue;
    const [a, b] = k.split("\u0000");
    // How often the rarer of the two changes with the other.
    const strength = count / Math.min(changes.get(a)!, changes.get(b)!);
    if (strength >= 0.5) out.push({ a, b, count, strength });
  }
  return out.sort((x, y) => y.count * y.strength - x.count * x.strength).slice(0, limit);
}

export type Span = "last_commit" | "day" | "week" | "month" | "all" | "uncommitted";

/** A named span ("this week") as a concrete range of loaded commits. */
export function resolveSpan(h: History, span: Span): TimeRange | null {
  const commits = h.commits;
  if (!commits.length) return null;
  const real = commits.filter((c) => !c.worktree);
  if (span === "uncommitted") return commits[0].worktree ? { from: commits[0].sha, to: commits[0].sha, label: "Uncommitted changes" } : null;
  if (span === "last_commit") return real[0] ? { from: real[0].sha, to: real[0].sha, label: real[0].subject } : null;
  if (span === "all") return { from: commits.at(-1)!.sha, to: commits[0].sha, label: "All loaded history" };
  const days = { day: 1, week: 7, month: 30 }[span];
  const since = Date.now() - days * 86_400_000;
  const inside = commits.filter((c) => c.at >= since);
  // A quiet repo: fall back to the latest commit rather than an empty range.
  if (!inside.length) return real[0] ? { from: real[0].sha, to: real[0].sha, label: real[0].subject } : null;
  return { from: inside.at(-1)!.sha, to: inside[0].sha, label: `Last ${span}` };
}

export function summarize(commits: Commit[]) {
  let add = 0;
  let del = 0;
  const files = new Set<string>();
  const authors = new Set<string>();
  for (const c of commits) {
    authors.add(c.author);
    for (const f of c.files) {
      add += f.add;
      del += f.del;
      files.add(f.path);
    }
  }
  return { add, del, files: files.size, authors: [...authors], commits: commits.length };
}

const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function describeRange(r: TimeRange, commits: Commit[]): string {
  if (!commits.length) return r.label ?? "an empty range";
  const s = summarize(commits);
  const when = commits.length === 1 ? day(commits[0].at) : `${day(commits.at(-1)!.at)} – ${day(commits[0].at)}`;
  const name = r.label ? `${r.label}: ` : "";
  return `${name}${s.commits} commit${s.commits === 1 ? "" : "s"}, ${s.files} files, +${s.add} −${s.del}, ${when}`;
}
