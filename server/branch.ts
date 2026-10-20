import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * What a branch changes relative to its base, read from git without checking
 * anything out: the branch may not be the one you're on, so everything here
 * names revisions explicitly. "The difference from main" means what the
 * branch did since it forked — a three-dot diff against the merge base — not
 * whatever main has done since.
 */

const run = promisify(execFile);

async function git(root: string, args: string[]) {
  const { stdout } = await run("git", args, { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  return stdout;
}

/** A branch or other revision name we'll pass to git: no options, no ranges. */
const REF = /^(?!-)[\w./@^~+-]{1,200}$/;
const safeRef = (r: string) => {
  if (!REF.test(r) || r.includes("..")) throw new Error(`Bad branch name "${r}".`);
  return r;
};
const safePath = (p: string) => {
  if (!p || p.includes("\0") || p.split("/").includes("..") || p.startsWith("-")) throw new Error("Bad path.");
  return p.replace(/^\.?\//, "");
};

export type BranchInfo = {
  name: string;
  current: boolean;
  /** A remote-tracking branch (origin/…), not one of yours. */
  remote: boolean;
  ahead: number;
  behind: number;
  subject: string;
  at: number;
};

/** The branch to compare against when none is named: main, else master, else the remote's default. */
export async function defaultBase(root: string): Promise<string> {
  for (const b of ["main", "master"]) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).then(() => true, () => false)) return b;
  }
  const remote = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  if (remote.trim()) return remote.trim();
  throw new Error("No main or master branch to compare with; name a base.");
}

/**
 * Local and remote-tracking branches, newest first, with how far each is from
 * the base. A remote branch that's the same commit as a local one of the same
 * name is left out: it's the same branch.
 */
export async function listBranches(root: string, base?: string): Promise<{ base: string; branches: BranchInfo[] }> {
  const b = base ? safeRef(base) : await defaultBase(root);
  const current = (await git(root, ["branch", "--show-current"]).catch(() => "")).trim();
  const out = await git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)%09%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(subject)",
    "refs/heads",
    "refs/remotes",
  ]);
  const rows = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, name, sha, at, ...subject] = line.split("\t");
      return { ref, name, sha, at: Number(at) * 1000, subject: subject.join("\t"), remote: ref.startsWith("refs/remotes/") };
    })
    // origin/HEAD is a pointer, not a branch.
    .filter((r) => !(r.remote && r.ref.endsWith("/HEAD")));
  const localSha = new Map(rows.filter((r) => !r.remote).map((r) => [r.name, r.sha]));
  const kept = rows.filter((r) => !r.remote || localSha.get(r.name.slice(r.name.indexOf("/") + 1)) !== r.sha);
  const branches = await Promise.all(
    kept.map(async (r) => {
      const counts = await git(root, ["rev-list", "--left-right", "--count", `${b}...${r.sha}`]).catch(() => "0\t0");
      const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      return { name: r.name, current: !r.remote && r.name === current, remote: r.remote, ahead: ahead || 0, behind: behind || 0, subject: r.subject, at: r.at };
    }),
  );
  return { base: b, branches };
}

/**
 * Bring the remote-tracking branches up to date, one remote at a time: with
 * `fetch --all`, one dead remote (a sibling folder that moved) fails the lot.
 * Never prompts — there's no one at a terminal to answer.
 */
export async function fetchRemotes(root: string): Promise<{ fetched: string[]; failed: { remote: string; error: string }[] }> {
  const remotes = (await git(root, ["remote"])).trim().split("\n").filter(Boolean);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
  const results = await Promise.all(
    remotes.map((remote) =>
      run("git", ["fetch", "--prune", "--quiet", remote], { cwd: root, timeout: 120_000, env }).then(
        () => ({ remote, error: "" }),
        (err: { stderr?: string; message?: string }) => {
          // git's own words, not "Command failed: …"
          const said = (err.stderr ?? err.message ?? "").split("\n").map((l) => l.trim()).find((l) => /^(fatal|error):/.test(l));
          return { remote, error: said?.replace(/^(fatal|error):\s*/, "") ?? "fetch failed" };
        },
      ),
    ),
  );
  return { fetched: results.filter((r) => !r.error).map((r) => r.remote), failed: results.filter((r) => r.error) };
}

export type BranchDiff = {
  branch: string;
  base: string;
  /** Where the branch forked from the base. */
  mergeBase: string;
  /** The branch's tip, as a sha. */
  head: string;
  /** Whether the branch is what's checked out — then the working tree is the branch. */
  checkedOut: boolean;
  commits: { sha: string; subject: string; author: string; at: number }[];
  /** `git diff --stat` of the whole branch. */
  stat: string;
  files: { path: string; status: string; add: number; del: number }[];
};

export async function branchDiff(root: string, branch: string, base?: string): Promise<BranchDiff> {
  const br = safeRef(branch);
  const b = base ? safeRef(base) : await defaultBase(root);
  const head = (await git(root, ["rev-parse", "--verify", `${br}^{commit}`]).catch(() => {
    throw new Error(`No branch "${branch}".`);
  })).trim();
  const mergeBase = (await git(root, ["merge-base", b, head]).catch(() => {
    throw new Error(`"${branch}" shares no history with ${b}.`);
  })).trim();
  const current = (await git(root, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  const log = await git(root, ["log", "--no-merges", "--format=%H%x09%at%x09%an%x09%s", `${mergeBase}..${head}`]);
  const commits = log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, at, author, ...s] = l.split("\t");
      return { sha, at: Number(at) * 1000, author, subject: s.join("\t") };
    });
  const [stat, numstat, names] = await Promise.all([
    git(root, ["diff", "--stat=140", "--no-color", mergeBase, head]),
    git(root, ["diff", "--numstat", "--no-renames", mergeBase, head]),
    git(root, ["diff", "--name-status", "--no-renames", mergeBase, head]),
  ]);
  const status = new Map(names.trim().split("\n").filter(Boolean).map((l) => [l.split("\t")[1], l.split("\t")[0]]));
  const files = numstat
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [add, del, path] = l.split("\t");
      return { path, status: status.get(path) ?? "M", add: Number(add) || 0, del: Number(del) || 0 };
    });
  return { branch: br, base: b, mergeBase, head, checkedOut: head === current, commits, stat: stat.trim(), files };
}

/** The unified diff of one file over the branch (merge base → tip). */
export async function branchFileDiff(root: string, d: Pick<BranchDiff, "mergeBase" | "head">, path: string): Promise<string> {
  return git(root, ["diff", "--no-color", "--no-renames", "-U3", d.mergeBase, d.head, "--", safePath(path)]);
}

/** A file's text at a revision (the branch tip, or the merge base for "before"). */
export async function fileAt(root: string, rev: string, path: string): Promise<string | null> {
  return git(root, ["show", `${rev}:${safePath(path)}`]).catch(() => null);
}
