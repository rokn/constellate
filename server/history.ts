import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Commit, CommitFile, History } from "../shared/types";

/**
 * The repo's history, as data the map can light up: recent commits with the
 * files each one touched and how much. One `git log` with both raw status
 * (added / modified / deleted) and numstat (lines in and out) per file. Renames
 * are read as a delete and an add — the map only knows today's paths, and that
 * is what a rename looks like from there.
 */

const run = promisify(execFile);

/** Enough history to scrub months of a busy repo without a slow first load. */
const MAX_COMMITS = 800;
/** Git's well-known empty tree: the base to diff a root commit against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const WORKTREE = "worktree";

const SHA = /^[0-9a-f]{4,40}$/;

let cached: { root: string; head: string; history: History } | null = null;

async function git(root: string, args: string[]) {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const chunk of out.split("\x1e").slice(1)) {
    const [header, ...lines] = chunk.split("\n");
    const [sha, short, author, at, parents, subject] = header.split("\x1f");
    const status = new Map<string, CommitFile["status"]>();
    const stats = new Map<string, { add: number; del: number }>();
    for (const line of lines) {
      if (line.startsWith(":")) {
        // :100644 100644 abc def M\tpath
        const [meta, path] = line.split("\t");
        const s = meta.split(" ").pop()?.[0];
        if (path) status.set(path, s === "A" ? "A" : s === "D" ? "D" : "M");
      } else if (line.trim()) {
        const [add, del, path] = line.split("\t");
        // Binary files report "-": they changed, by an unknown amount.
        if (path) stats.set(path, { add: Number(add) || 0, del: Number(del) || 0 });
      }
    }
    const files = [...new Set([...status.keys(), ...stats.keys()])].map((path) => ({
      path,
      status: status.get(path) ?? "M",
      add: stats.get(path)?.add ?? 0,
      del: stats.get(path)?.del ?? 0,
    }));
    commits.push({
      sha,
      short,
      author,
      at: Number(at) * 1000,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      subject,
      files,
    });
  }
  return commits;
}

/** Uncommitted work, as a commit-shaped slice at the top of history. */
async function worktreeCommit(root: string): Promise<Commit | null> {
  const [raw, num] = await Promise.all([
    git(root, ["diff", "HEAD", "--no-renames", "--raw"]),
    git(root, ["diff", "HEAD", "--no-renames", "--numstat"]),
  ]);
  if (!raw.trim()) return null;
  const fake = `\x1e${WORKTREE}\x1f${WORKTREE}\x1fyou\x1f${Math.floor(Date.now() / 1000)}\x1fHEAD\x1fUncommitted changes\n${raw}${num}`;
  const [c] = parseLog(fake);
  return { ...c, parents: [], worktree: true };
}

export async function loadHistory(root: string): Promise<History> {
  let head = "";
  try {
    head = (await git(root, ["rev-parse", "HEAD"])).trim();
  } catch {
    return { commits: [], truncated: false, available: false };
  }
  // Commits are immutable, so the log is reused while HEAD stands still; the
  // uncommitted slice is always read fresh.
  if (!cached || cached.root !== root || cached.head !== head) {
    const out = await git(root, [
      "log",
      `-n${MAX_COMMITS}`,
      "--no-renames",
      "--raw",
      "--numstat",
      "--format=%x1e%H%x1f%h%x1f%an%x1f%at%x1f%P%x1f%s",
    ]);
    const commits = parseLog(out);
    cached = { root, head, history: { head, commits, truncated: commits.length >= MAX_COMMITS, available: true } };
  }
  const wt = await worktreeCommit(root).catch(() => null);
  return { ...cached.history, commits: wt ? [wt, ...cached.history.commits] : cached.history.commits };
}

/**
 * A unified diff of one file across a range: from just before `from` (the
 * oldest commit in the range) to `to` (the newest, or the working tree).
 */
export async function diffFile(root: string, path: string, from: string, to: string): Promise<string> {
  if (!path || path.includes("\0") || path.split("/").includes("..")) throw new Error("Bad path.");
  for (const s of [from, to]) if (s !== WORKTREE && !SHA.test(s)) throw new Error(`Bad revision ${s}.`);

  let base: string;
  if (from === WORKTREE) base = "HEAD";
  else {
    // A root commit has no parent; diff it against the empty tree.
    const parent = await git(root, ["rev-parse", "--verify", "--quiet", `${from}^`]).catch(() => "");
    base = parent.trim() || EMPTY_TREE;
  }
  const args = ["diff", "--no-color", "--no-renames", "-U3", base];
  if (to !== WORKTREE) args.push(to);
  args.push("--", path);
  return git(root, args);
}

/** Full message and stats for one commit, for captions and the navigator. */
export async function commitMessage(root: string, sha: string): Promise<string> {
  if (!SHA.test(sha)) throw new Error("Bad revision.");
  return (await git(root, ["show", "-s", "--format=%B", sha])).trim();
}
