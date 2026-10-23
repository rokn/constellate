import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRun } from "../shared/types";
import { branchDiff, type BranchDiff } from "./branch";
import { CACHE_DIR, addOverlay, emit, removeOverlay, session } from "./session";
import { parseGitHub } from "./library";

/**
 * Coding agents: Claude Code, via the Agent SDK, each in its own git worktree
 * on its own branch, so several can work on the code at once without touching
 * the checkout the map reads (or each other).
 *
 * Unlike the navigator, an agent writes. It is boxed into its worktree: a
 * hook refuses any file tool pointed outside it, and Bash is off unless
 * CONSTELLATE_AGENT_BASH=1. It never pushes; when a turn ends the runner
 * commits what it changed to its branch, and landing that branch is yours.
 */

const run = promisify(execFile);

export const AGENTS_ON = !/^(0|false|no|off)$/i.test(process.env.CONSTELLATE_AGENTS ?? "");
const BASH = /^(1|true|yes|on)$/i.test(process.env.CONSTELLATE_AGENT_BASH ?? "");
const LIMIT = Math.max(1, Number(process.env.CONSTELLATE_AGENT_LIMIT) || 3);
const MODEL = process.env.CONSTELLATE_AGENT_MODEL ?? process.env.CODEFLIGHT_MODEL ?? "claude-opus-5-5";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORT = (process.env.CONSTELLATE_AGENT_EFFORT ?? "high") as Effort;
const MAX_TURNS = Number(process.env.CONSTELLATE_AGENT_MAX_TURNS) || 120;

const TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "TodoWrite", ...(BASH ? ["Bash"] : [])];
/** Secrets an agent's shell has no business with. */
const SECRET_ENV = /^(GIT_TOKEN|INWORLD_API_KEY|HOMELAB_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/;
/** Its commits are attributed to it, whatever the box's git identity is (often none). */
const IDENTITY = ["-c", "user.name=Constellate agent", "-c", "user.email=agent@constellate.local"];

const SYSTEM = [
  "You are a coding agent started from Constellate, a 3D map of this codebase. Someone asked for the task below, by voice or by typing, and is watching the files you touch light up on the map.",
  "You work in a git worktree of their repository, on a branch of your own. Make the change completely, in the style of the code around it. Stay inside the working directory: anything outside it is refused.",
  BASH
    ? "You may run commands (tests, builds, linters) with Bash, inside the working directory."
    : "You cannot run commands; there is no shell. Read the code carefully instead, and say what you could not verify.",
  "Do not commit, push, or switch branches: when you stop, everything you changed is committed to your branch for them to review.",
  "Finish with two or three plain sentences on what you changed and anything they should check. It may be read aloud, so no lists, no code, no file paths longer than a name.",
].join("\n");

/* ------------------------------ bookkeeping ------------------------------ */

type Live = { controller: AbortController; queue: string[] };
const live = new Map<string, Live>();
/** Agents whose branch is being rebased: no turn or push until it's done. */
const rebasing = new Set<string>();

/** Fired when an agent stops working, however it ended. The voice tells you. */
type Listener = (a: AgentRun) => void;
const finished = new Set<Listener>();
export function onAgentFinished(fn: Listener) {
  finished.add(fn);
  return () => finished.delete(fn);
}

const agents = () => session.state.agents;
export const getAgent = (id: string) => agents().find((a) => a.id === id);

/** An agent by id, or a word of its title ("the logging one"). */
export function findAgent(ref: string): AgentRun | undefined {
  const r = ref.trim().toLowerCase();
  if (!r) return undefined;
  return getAgent(ref.trim()) ?? [...agents()].reverse().find((a) => a.title.toLowerCase().includes(r) || a.branch.toLowerCase().includes(r));
}

function patch(id: string, p: Partial<AgentRun>) {
  session.state.agents = agents().map((a) => (a.id === id ? { ...a, ...p, updatedAt: Date.now() } : a));
  emit();
}

const markerId = (a: AgentRun) => `agent-${a.id}`;

/** The agent's files, as a marker on the map: a beacon over what it's touching. */
function mark(a: AgentRun) {
  const known = new Set(session.idx?.graph.files.map((f) => f.path) ?? []);
  const paths = a.files.filter((f) => known.has(f));
  const existing = session.state.overlays.find((o) => o.id === markerId(a));
  if (!paths.length) {
    if (existing) removeOverlay(existing.id);
    return;
  }
  if (existing && existing.paths.join("\n") === paths.join("\n")) return;
  const overlay = addOverlay({
    label: `Agent: ${a.title}`,
    summary: a.task,
    paths,
    reasons: Object.fromEntries(paths.map((p) => [p, `${a.title} changed this`])),
    createdBy: "agent",
    color: existing?.color,
  });
  // addOverlay mints its own id; this one is keyed to the agent so it can follow it.
  session.state.overlays = session.state.overlays.map((o) => (o.id === overlay.id ? { ...o, id: markerId(a), visible: existing?.visible ?? true } : o));
  emit();
}

const git = (cwd: string, args: string[], opts: { timeout?: number } = {}) =>
  run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: opts.timeout }).then((r) => r.stdout.trim());

/** git's own last words, not "Command failed: <the whole command line>". */
const gitError = (err: unknown) =>
  String((err as { stderr?: string }).stderr || (err instanceof Error ? err.message : err))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? "unknown error";

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "task"
  );
}

/** A short title from the task: its first few words. */
function titleOf(task: string) {
  const words = task.replace(/\s+/g, " ").trim().split(" ");
  return words.slice(0, 7).join(" ").replace(/[.,;:]$/, "") + (words.length > 7 ? "…" : "");
}

function worktreesDir(root: string) {
  return path.join(CACHE_DIR, "worktrees", createHash("sha1").update(root).digest("hex").slice(0, 16));
}

/** What the branch has changed since it started, committed or not. */
async function changedFiles(a: AgentRun): Promise<string[]> {
  const committed = await git(a.worktree, ["diff", "--name-only", "--no-renames", a.baseSha, "HEAD"]).catch(() => "");
  const status = await git(a.worktree, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "");
  const loose = status
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").at(-1)!);
  return [...new Set([...committed.split("\n").filter(Boolean), ...loose])].sort();
}

/** Commit what the agent left in its worktree, so its branch holds the work. */
async function commit(a: AgentRun, message: string) {
  const dirty = await git(a.worktree, ["status", "--porcelain"]);
  if (!dirty) return;
  await git(a.worktree, ["add", "-A"]);
  await git(a.worktree, [...IDENTITY, "commit", "--no-verify", "-q", "-m", message]);
}

/**
 * The agent's work as it stands, as a commit: its branch's tip, or, while it
 * has edits it hasn't committed, a commit of its worktree on top of that —
 * made through a scratch index, so neither its branch nor its own index moves.
 * Worktrees share the repo's objects, so the map can be read at it like any commit.
 */
async function snapshot(a: AgentRun): Promise<{ sha: string; live: boolean }> {
  const head = await git(a.worktree, ["rev-parse", "HEAD"]);
  const dirty = await git(a.worktree, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "");
  if (!dirty) return { sha: head, live: false };
  const scratch = path.join(tmpdir(), `constellate-snap-${a.id}-${Date.now().toString(36)}`);
  // Dated as its parent, so the same work makes the same commit, and the map
  // already built for it is used again.
  const date = `@${await git(a.worktree, ["log", "-1", "--format=%ct", "HEAD"])} +0000`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_INDEX_FILE: scratch, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const g = (args: string[]) => run("git", args, { cwd: a.worktree, maxBuffer: 64 * 1024 * 1024, env }).then((r) => r.stdout.trim());
  try {
    // Starting from a copy of its index spares hashing every file again.
    const index = await git(a.worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).catch(() => "");
    const copied = index ? await copyFile(index, scratch).then(() => true, () => false) : false;
    if (!copied) await g(["read-tree", "HEAD"]);
    await g(["add", "-A"]);
    const tree = await g(["write-tree"]);
    const sha = await g([...IDENTITY, "commit-tree", tree, "-p", head, "-m", `${a.title} (work in progress)`]);
    return { sha, live: true };
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}

/**
 * What an agent changed, as a branch diff: from the commit it started on (not
 * wherever its base branch has got to since) to its work as it stands now.
 */
export async function agentDiff(id: string): Promise<BranchDiff> {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent.");
  const root = session.state.repo?.root;
  if (!root) throw new Error("No repository is open.");
  const tip = await snapshot(a).catch(() => ({ sha: undefined, live: false }));
  const d = await branchDiff(root, a.branch, a.base === "HEAD" ? a.baseSha : a.base, { start: a.baseSha, tip: tip.sha });
  // The snapshot isn't one of its commits: it's what it hasn't committed yet.
  return { ...d, commits: d.commits.filter((c) => c.sha !== tip.sha || !tip.live), agent: { id: a.id, title: a.title, live: tip.live } };
}

async function refresh(id: string) {
  const a = getAgent(id);
  if (!a) return;
  const files = await changedFiles(a);
  const commits = Number(await git(a.worktree, ["rev-list", "--count", `${a.baseSha}..HEAD`]).catch(() => "0")) || 0;
  patch(id, { files, commits });
  const next = getAgent(id);
  if (next) mark(next);
}

/* ------------------------------ the guard ------------------------------ */

/** Paths a tool call names, by tool. */
function pathsIn(tool: string, input: Record<string, unknown>): string[] {
  const keys = ["file_path", "path", "notebook_path"];
  if (tool === "Bash") return [];
  return keys.map((k) => input[k]).filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Refuses any file tool pointed outside the worktree, however it's spelled. */
function guard(worktree: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = input.tool_name;
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
    });
    if (!TOOLS.includes(tool)) return deny(`${tool} isn't available to agents here.`);
    for (const p of pathsIn(tool, args)) {
      const abs = path.resolve(worktree, p);
      if (abs !== worktree && !abs.startsWith(worktree + path.sep)) return deny(`${p} is outside your working directory (${worktree}).`);
      if (abs.split(path.sep).includes(".git")) return deny("The .git folder is off limits.");
    }
    return {};
  };
}

/* ------------------------------ one turn ------------------------------ */

function narrate(id: string, msg: SDKMessage, worktree: string) {
  if (msg.type !== "assistant") return;
  for (const block of msg.message.content) {
    if (block.type !== "tool_use") continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const p = typeof input.file_path === "string" ? path.relative(worktree, path.resolve(worktree, input.file_path)) : "";
    const what: Record<string, string> = {
      Read: `Reading ${p}`,
      Edit: `Editing ${p}`,
      Write: `Writing ${p}`,
      Grep: `Searching for ${String(input.pattern ?? "")}`,
      Glob: `Looking for ${String(input.pattern ?? "")}`,
      Bash: `Running ${String(input.description ?? input.command ?? "").slice(0, 80)}`,
      TodoWrite: "Planning",
    };
    patch(id, { activity: what[block.name] ?? block.name });
    // Edits show on the map as they happen, not only when the turn ends.
    // (A path outside the worktree is refused by the guard; it isn't the agent's.)
    if ((block.name === "Edit" || block.name === "Write") && p && !p.startsWith("..")) {
      const a = getAgent(id);
      if (a && !a.files.includes(p)) {
        patch(id, { files: [...a.files, p].sort() });
        mark(getAgent(id)!);
      }
    }
  }
}

async function turn(id: string, prompt: string) {
  const a = getAgent(id);
  if (!a) return;
  const controller = new AbortController();
  const entry: Live = live.get(id) ?? { controller, queue: [] };
  entry.controller = controller;
  live.set(id, entry);
  patch(id, { status: "working", activity: "Starting", error: undefined, turns: [...a.turns, { role: "you", text: prompt, at: Date.now() }] });

  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !SECRET_ENV.test(k))) as Record<string, string>;
  let answer = "";
  let error: string | undefined;
  let cost = a.costUsd ?? 0;
  try {
    const q = query({
      prompt,
      options: {
        cwd: a.worktree,
        model: MODEL,
        effort: EFFORT,
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM },
        tools: TOOLS,
        allowedTools: TOOLS,
        // There's no one at a terminal to ask: what isn't allowed is refused.
        permissionMode: "dontAsk",
        // The repo's own .claude settings could carry hooks; agents don't run them.
        settingSources: [],
        hooks: { PreToolUse: [{ hooks: [guard(a.worktree)] }] },
        resume: a.sessionId,
        env,
        maxTurns: MAX_TURNS,
        abortController: controller,
        stderr: process.env.CODEFLIGHT_DEBUG ? (d) => console.error(`[agent ${id}]`, d) : undefined,
      },
    });
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") patch(id, { sessionId: msg.session_id });
      else if (msg.type === "assistant") narrate(id, msg, a.worktree);
      else if (msg.type === "result") {
        cost += msg.total_cost_usd ?? 0;
        if (msg.subtype === "success") answer = msg.result;
        else error = msg.subtype.replace(/_/g, " ");
      }
    }
  } catch (err) {
    error = controller.signal.aborted ? undefined : err instanceof Error ? err.message : String(err);
  }

  const stopped = controller.signal.aborted;
  try {
    await commit(getAgent(id) ?? a, `${a.title}\n\n${prompt}`.slice(0, 2000));
  } catch (err) {
    error ??= `Could not commit: ${err instanceof Error ? err.message : String(err)}`;
  }
  await refresh(id);
  const now = getAgent(id);
  if (!now) return; // discarded while it ran
  patch(id, {
    status: stopped ? "stopped" : error ? "failed" : "done",
    activity: undefined,
    summary: answer || now.summary,
    error,
    costUsd: cost,
    turns: answer ? [...now.turns, { role: "agent", text: answer, at: Date.now() }] : now.turns,
  });

  // Follow-ups sent while it worked go next, in order.
  const next = stopped ? undefined : entry.queue.shift();
  if (next) return turn(id, next);
  live.delete(id);
  // Finished work goes up as a pull request on its own (when the server has a
  // GitHub token), and a follow-up's commits go to the same one.
  const after = getAgent(id);
  if (after && after.status === "done" && after.commits > 0 && TOKEN()) {
    await openPullRequest(id).catch((err) => patch(id, { error: `Could not open the PR: ${err instanceof Error ? err.message : String(err)}` }));
  }
  const done = getAgent(id);
  if (done) for (const fn of finished) fn(done);
}

/* ------------------------------ public api ------------------------------ */

export function runningCount() {
  return agents().filter((a) => a.status === "working" || a.status === "starting").length;
}

/** Start an agent on a task, in a fresh worktree off the commit the map shows. */
export async function startAgent(task: string, opts: { title?: string } = {}): Promise<AgentRun> {
  if (!AGENTS_ON) throw new Error("Agents are turned off on this server (CONSTELLATE_AGENTS).");
  const root = session.state.repo?.root;
  if (!root || !session.idx) throw new Error("No repository is open.");
  if (!task.trim()) throw new Error("Say what the agent should do.");
  if (runningCount() >= LIMIT) throw new Error(`${LIMIT} agents are already working; wait for one or stop one.`);

  const id = `a${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const title = opts.title?.trim().slice(0, 80) || titleOf(task);
  const branch = `agent/${slug(title)}-${id.slice(-4)}`;
  const worktree = path.join(worktreesDir(root), id);
  const base = (await git(root, ["branch", "--show-current"]).catch(() => "")) || "HEAD";
  const baseSha = await git(root, ["rev-parse", "HEAD"]);

  await mkdir(path.dirname(worktree), { recursive: true });
  await git(root, ["worktree", "add", "-q", "-b", branch, worktree, baseSha]);

  const now = Date.now();
  const agent: AgentRun = { id, title, task: task.trim(), status: "starting", branch, base, baseSha, worktree, files: [], commits: 0, turns: [], createdAt: now, updatedAt: now };
  session.state.agents = [...agents(), agent];
  emit();
  void turn(id, task.trim()).catch((err) => {
    console.error(`[agent ${id}]`, err);
    patch(id, { status: "failed", error: String(err), activity: undefined });
  });
  return agent;
}

/** Tell an agent something more. Sent while it works, it goes after its current turn. */
export function messageAgent(id: string, text: string): "sent" | "queued" {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent.");
  if (!text.trim()) throw new Error("Say something.");
  if (rebasing.has(id)) throw new Error("Its branch is being rebased; try again in a moment.");
  const l = live.get(id);
  if (l) {
    l.queue.push(text.trim());
    return "queued";
  }
  void turn(id, text.trim());
  return "sent";
}

export function stopAgent(id: string): boolean {
  const l = live.get(id);
  if (!l) return false;
  l.queue = [];
  l.controller.abort();
  return true;
}

/** Stops every agent: the repo they belong to is closing. Their branches stay. */
export function stopAllAgents() {
  for (const id of live.keys()) stopAgent(id);
}

/** Stop it, and remove its worktree, its branch and its marker. Its work is gone. */
export async function discardAgent(id: string) {
  const a = getAgent(id);
  if (!a) return;
  stopAgent(id);
  live.delete(id);
  session.state.agents = agents().filter((x) => x.id !== id);
  removeOverlay(markerId(a));
  const root = session.state.repo?.root;
  if (root) {
    await git(root, ["worktree", "remove", "--force", a.worktree]).catch(() => rm(a.worktree, { recursive: true, force: true }));
    await git(root, ["worktree", "prune"]).catch(() => {});
    await git(root, ["branch", "-D", a.branch]).catch(() => {});
  }
  emit();
}

/* ---------------------------- pull requests ---------------------------- */

const TOKEN = () => process.env.GIT_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

/**
 * The token through a credential helper read from the environment, as the
 * container's entrypoint does: never on the command line or on disk.
 */
const auth = () => (TOKEN() ? ["-c", "credential.helper=", "-c", "credential.helper=!f() { echo username=x-access-token; echo \"password=${GIT_TOKEN:-${GITHUB_TOKEN:-$GH_TOKEN}}\"; }; f"] : []);

async function github<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const token = TOKEN();
  if (!token) throw new Error("No GitHub token on the server (GIT_TOKEN), so it can't open pull requests.");
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "constellate",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

function prBody(a: AgentRun) {
  return [
    a.task,
    "",
    a.summary ? `**What the agent said:** ${a.summary}` : "",
    a.files.length ? `**Files:** ${a.files.map((f) => `\`${f}\``).join(", ")}` : "",
    "",
    "---",
    "_Opened from Constellate by a coding agent._",
  ]
    .filter((l, i, all) => l || all[i - 1])
    .join("\n");
}

async function githubRepo(root: string) {
  const repo = parseGitHub(await git(root, ["remote", "get-url", "origin"]).catch(() => ""));
  if (!repo) throw new Error("Its origin isn't a GitHub repository.");
  return repo;
}

/**
 * Push an agent's branch to origin and open a pull request for it on GitHub,
 * or, when it has one, push the new commits to it. The only way an agent's
 * work leaves the box, and only when you ask.
 */
export async function openPullRequest(id: string): Promise<NonNullable<AgentRun["pr"]>> {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent.");
  if (live.has(id)) throw new Error("It's still working; wait for it to finish.");
  if (rebasing.has(id)) throw new Error("Its branch is being rebased; try again in a moment.");
  if (!a.commits) throw new Error("It hasn't committed anything to open a PR for.");
  const root = session.state.repo?.root;
  if (!root) throw new Error("No repository is open.");
  if (!TOKEN()) throw new Error("No GitHub token on the server (GIT_TOKEN), so it can't open pull requests.");
  const repo = await githubRepo(root);

  const head = await git(root, ["rev-parse", `refs/heads/${a.branch}`]);
  if (a.pr?.pushedSha !== head) {
    patch(id, { activity: "Pushing its branch" });
    try {
      // A rebase rewrote it since the last push: --force-with-lease lets that
      // through, but not someone else's commits pushed to it in between.
      await git(root, [...auth(), "push", "--force-with-lease", "origin", `refs/heads/${a.branch}:refs/heads/${a.branch}`]);
    } catch (err) {
      const all = String((err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : err));
      if (/\b403\b|denied/i.test(all)) {
        throw new Error(`GitHub refused the push: the server's GIT_TOKEN can't write to ${repo}. Give it Contents and Pull requests read and write on that repo.`);
      }
      throw new Error(`The push failed: ${gitError(err)}`);
    } finally {
      patch(id, { activity: undefined });
    }
  }

  let pr = a.pr;
  if (!pr || pr.state !== "open") {
    const info = await github<{ default_branch?: string; message?: string }>("GET", `/repos/${repo}`);
    if (info.status !== 200) throw new Error(`GitHub: ${info.data.message ?? info.status}`);
    // Into the branch it started from, if GitHub has it; else the default.
    const onRemote = a.base !== "HEAD" && (await git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${a.base}`]).then(() => true, () => false));
    const base = onRemote ? a.base : info.data.default_branch ?? "main";
    type Pull = { number: number; html_url: string; state: string; message?: string; errors?: { message?: string }[] };
    const made = await github<Pull>("POST", `/repos/${repo}/pulls`, { title: a.title, head: a.branch, base, body: prBody(a) });
    let found: Pull | undefined = made.status === 201 ? made.data : undefined;
    if (!found && made.status === 422) {
      // One already exists for the branch: adopt it.
      const [owner] = repo.split("/");
      const list = await github<Pull[]>("GET", `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${a.branch}`)}&state=open`);
      found = Array.isArray(list.data) ? list.data[0] : undefined;
    }
    if (!found) throw new Error(`GitHub: ${made.data.errors?.[0]?.message ?? made.data.message ?? made.status}`);
    pr = { number: found.number, url: found.html_url, state: "open", base, pushedSha: head };
  }
  pr = { ...pr, pushedSha: head };
  patch(id, { pr, error: undefined });
  return pr;
}

/**
 * Rebase-merge an agent's pull request on GitHub, pushing anything it hasn't
 * yet. Its branch is deleted on GitHub afterwards; the local one stays until
 * you discard the agent.
 */
export async function mergePullRequest(id: string): Promise<NonNullable<AgentRun["pr"]>> {
  if (live.has(id)) throw new Error("It's still working; wait for it to finish.");
  // Brings the PR up to date with the branch (or opens it, if it has none yet).
  const pr = await openPullRequest(id);
  const a = getAgent(id)!;
  const root = session.state.repo!.root;
  const repo = await githubRepo(root);
  patch(id, { activity: "Merging its PR" });
  try {
    type Merge = { merged?: boolean; message?: string };
    const res = await github<Merge>("PUT", `/repos/${repo}/pulls/${pr.number}/merge`, {
      // Its commits land as they are, one per turn, on top of the base.
      merge_method: "rebase",
      // Only what was reviewed: if the branch moved since, GitHub refuses.
      sha: pr.pushedSha,
    });
    if (res.status !== 200 || !res.data.merged) {
      const now = await github<{ merged?: boolean; state?: string }>("GET", `/repos/${repo}/pulls/${pr.number}`);
      if (!now.data.merged) {
        const why = res.data.message ?? String(res.status);
        throw new Error(`GitHub wouldn't merge it: ${why}${/conflict|not mergeable/i.test(why) ? `. Rebase it onto ${pr.base} first.` : ""}`);
      }
    }
    const merged = { ...pr, state: "merged" as const };
    patch(id, { pr: merged, error: undefined });
    await github("DELETE", `/repos/${repo}/git/refs/heads/${a.branch.split("/").map(encodeURIComponent).join("/")}`).catch(() => {});
    return merged;
  } finally {
    patch(id, { activity: undefined });
  }
}

/* ------------------------------ rebasing ------------------------------ */

const isAncestor = (cwd: string, a: string, b: string) => git(cwd, ["merge-base", "--is-ancestor", a, b]).then(() => true, () => false);
const commitOf = (cwd: string, ref: string) => git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");

/**
 * Where an agent's branch belongs now: its PR's base, or the branch it
 * started from, as it is today. Origin's copy is fetched first, and wins when
 * it's ahead of yours (or when there's a PR, which merges into origin's).
 */
async function currentBase(root: string, a: AgentRun): Promise<{ name: string; sha: string }> {
  const branch = a.pr?.base ?? (a.base !== "HEAD" ? a.base : "");
  if (!branch) return { name: "the checkout", sha: await git(root, ["rev-parse", "HEAD"]) };
  // Offline, or no origin: what was last fetched will do.
  await git(root, [...auth(), "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeout: 60_000 }).catch(() => {});
  const [local, remote] = await Promise.all([commitOf(root, `refs/heads/${branch}`), commitOf(root, `refs/remotes/origin/${branch}`)]);
  if (!local && !remote) throw new Error(`There's no ${branch} branch to rebase onto.`);
  const useRemote = !!remote && (!local || a.pr !== undefined || (local !== remote && (await isAncestor(root, local, remote))));
  return useRemote ? { name: `origin/${branch}`, sha: remote } : { name: branch, sha: local };
}

/**
 * Replay an agent's commits on top of its base branch as it is now, so its
 * branch is current before you open a PR or merge it. When its changes
 * conflict with what landed since, the rebase is undone and the branch is
 * left as it was. An open PR gets the rebased branch pushed to it.
 */
export async function rebaseAgent(id: string): Promise<{ onto: string; upToDate: boolean; commits: number; pr?: AgentRun["pr"] }> {
  const a = getAgent(id);
  if (!a) throw new Error("No such agent.");
  if (live.has(id)) throw new Error("It's still working; wait for it to finish.");
  if (rebasing.has(id)) throw new Error("It's already being rebased.");
  if (a.pr?.state === "merged") throw new Error(`PR #${a.pr.number} is already merged.`);
  const root = session.state.repo?.root;
  if (!root) throw new Error("No repository is open.");

  rebasing.add(id);
  patch(id, { activity: "Rebasing its branch" });
  let onto = { name: a.base, sha: a.baseSha };
  let upToDate = true;
  try {
    // A turn commits what it changed; anything a failed commit left goes along.
    await commit(a, `${a.title}\n\nWork left uncommitted`);
    onto = await currentBase(root, a);
    upToDate = await isAncestor(a.worktree, onto.sha, "HEAD");
    if (!upToDate) {
      try {
        // Exactly its own commits (those since it forked), however the base moved.
        await git(a.worktree, [...IDENTITY, "rebase", "--quiet", "--no-verify", "--onto", onto.sha, a.baseSha]);
      } catch (err) {
        const conflicts = (await git(a.worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
        await git(a.worktree, ["rebase", "--abort"]).catch(() => {});
        if (conflicts.length) {
          throw new Error(`Its changes conflict with ${onto.name} in ${conflicts.join(", ")}, so its branch is left as it was.`);
        }
        throw new Error(`The rebase failed: ${gitError(err)}`);
      }
      patch(id, { baseSha: onto.sha, error: undefined });
    }
    await refresh(id);
  } catch (err) {
    patch(id, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    rebasing.delete(id);
    patch(id, { activity: undefined });
  }

  // The PR shows what was pushed: bring it along.
  let pr = getAgent(id)?.pr;
  if (!upToDate && pr?.state === "open") {
    pr = await openPullRequest(id).catch((err) => {
      const why = `Rebased onto ${onto.name}, but its PR wasn't updated: ${err instanceof Error ? err.message : String(err)}`;
      patch(id, { error: why });
      throw new Error(why);
    });
  }
  return { onto: onto.name, upToDate, commits: getAgent(id)?.commits ?? 0, pr };
}
