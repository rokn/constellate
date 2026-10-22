import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRun } from "../shared/types";
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

const git = (cwd: string, args: string[]) =>
  run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).then((r) => r.stdout.trim());

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
  // Its pull request follows its branch: a follow-up's commits go up too.
  const after = getAgent(id);
  if (after?.pr && !stopped) await openPullRequest(id).catch((err) => patch(id, { error: `Could not update the PR: ${err instanceof Error ? err.message : String(err)}` }));
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
    a.files.length ? `\n**Files:** ${a.files.map((f) => `\`${f}\``).join(", ")}` : "",
    "",
    "---",
    "_Opened from Constellate by a coding agent._",
  ]
    .filter((l, i, all) => l || all[i - 1])
    .join("\n");
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
  if (!a.commits) throw new Error("It hasn't committed anything to open a PR for.");
  const root = session.state.repo?.root;
  if (!root) throw new Error("No repository is open.");
  if (!TOKEN()) throw new Error("No GitHub token on the server (GIT_TOKEN), so it can't open pull requests.");
  const repo = parseGitHub(await git(root, ["remote", "get-url", "origin"]).catch(() => ""));
  if (!repo) throw new Error("Its origin isn't a GitHub repository.");

  const head = await git(root, ["rev-parse", `refs/heads/${a.branch}`]);
  if (a.pr?.pushedSha !== head) {
    patch(id, { activity: "Pushing its branch" });
    // The token through a credential helper read from the environment, as the
    // container's entrypoint does: never on the command line or on disk.
    const auth = TOKEN() ? ["-c", "credential.helper=", "-c", "credential.helper=!f() { echo username=x-access-token; echo \"password=${GIT_TOKEN:-${GITHUB_TOKEN:-$GH_TOKEN}}\"; }; f"] : [];
    try {
      await git(root, [...auth, "push", "--force-with-lease", "origin", `refs/heads/${a.branch}:refs/heads/${a.branch}`]);
    } catch (err) {
      // git's own words, not "Command failed: <the whole command line>".
      const said = String((err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : err));
      if (/\b403\b|denied/i.test(said)) {
        throw new Error(`GitHub refused the push: the server's GIT_TOKEN can't write to ${repo}. Give it Contents and Pull requests read and write on that repo.`);
      }
      throw new Error(`The push failed: ${said.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "unknown error"}`);
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
