import type { AgentRun, ScreenContext, UiCommand } from "../shared/types";
import { discardAgent, findAgent, mergePullRequest, messageAgent, openPullRequest, rebaseAgent, startAgent, stopAgent } from "./agents";
import { session } from "./session";

/**
 * What can be done to coding agents, by voice or typed into Ask: one set of
 * tools, described and carried out in one place, so both routes decide the
 * same way and act through the same agent APIs. The voice offers them to
 * Inworld; the navigator offers them to Claude when a request was typed.
 *
 * The two differ in one thing: merging. Merging to main deploys, so it needs
 * a clear yes. The voice gets it out loud before it calls merge_pr, and
 * merges. A typed request has no turn to say yes in, so merge_pr puts a
 * Merge button on the answer instead, and nothing merges until it's pressed.
 */

export type Surface = "voice" | "typed";

export type ActionContext = {
  surface: Surface;
  screen: ScreenContext;
  command: (cmd: UiCommand) => void;
  /** News that arrives after the call returned: a PR opened, an agent that couldn't start. */
  report: (news: string, ok: boolean) => void;
  /** The agents changed in a way the caller's picture of them should catch up with. */
  changed?: () => void;
  /** Typed only: put a Merge button in front of them, for this agent. */
  confirmMerge?: (a: AgentRun) => void;
};

type Param = { type: "string"; description?: string };

export type Action = {
  name: string;
  description: string;
  /** Added for one route: what happens after the call differs between them. */
  voice?: string;
  typed?: string;
  properties: Record<string, Param>;
  required: string[];
  run: (args: Record<string, unknown>, ctx: ActionContext) => Record<string, unknown>;
};

const str = (args: Record<string, unknown>, k: string) => String(args[k] ?? "").trim();
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const noAgent = (args: Record<string, unknown>) => ({ ok: false, error: `No agent "${str(args, "agent")}".` });
const agentParam = { agent: { type: "string", description: "Its id or a word of its title" } } as const;

export const AGENT_ACTIONS: Action[] = [
  {
    name: "start_agent",
    description: [
      "Start a coding agent that changes the code: it works on its own branch in its own copy of the repo, and its files light up on the map as it goes.",
      "Use it only when they ask for code to be written, fixed or changed — never to answer a question about the code.",
      "Pass the task in their words plus what they're looking at (the open file, the selection) so it knows where to start. If the ask is too vague to act on, ask one short question first.",
    ].join(" "),
    voice: "Returns at once; you'll be told when it finishes.",
    typed: "Returns at once; they follow it on the map and in the Agents panel.",
    properties: {
      task: { type: "string", description: "What the agent should do, specific and self-contained" },
      title: { type: "string", description: "Three to six words naming it, e.g. 'Retry failed uploads'" },
    },
    required: ["task", "title"],
    run: (args, ctx) => {
      const task = str(args, "task");
      if (!task) return { ok: false, say: "Call again with the task in `task`." };
      // Where they are is part of the task: "fix this" means the open file.
      const { screen } = ctx;
      const where = [
        screen.openFile ? `They have ${screen.openFile.path}${screen.openFile.line ? ` open at line ${screen.openFile.line}` : " open"}.` : "",
        screen.selection ? `They selected:\n"""\n${screen.selection.slice(0, 1500)}\n"""` : "",
      ].filter(Boolean).join("\n");
      startAgent(where ? `${task}\n\n${where}` : task, { title: str(args, "title") }).then(
        () => ctx.changed?.(),
        (err) => ctx.report(`The agent couldn't start: ${errText(err)}.`, false),
      );
      return { ok: true, status: "starting", say: "One short line that it's on it. Don't describe the change yet." };
    },
  },
  {
    name: "message_agent",
    description: "Tell a running or finished agent something more: a correction, a follow-up change. Sent while it works, it goes after its current step.",
    properties: { ...agentParam, text: { type: "string" } },
    required: ["agent", "text"],
    run: (args) => {
      const a = findAgent(str(args, "agent"));
      if (!a) return noAgent(args);
      return { ok: true, status: messageAgent(a.id, str(args, "text")) };
    },
  },
  {
    name: "stop_agent",
    description: "Stop an agent. What it changed so far stays on its branch.",
    properties: { ...agentParam },
    required: ["agent"],
    run: (args) => {
      const a = findAgent(str(args, "agent"));
      if (!a) return noAgent(args);
      return { ok: stopAgent(a.id), note: a.status === "working" ? undefined : "It wasn't running." };
    },
  },
  {
    name: "show_agent",
    description: "Show what an agent changed: its branch on the map, lit against where it started, and the camera on its files. Instant.",
    properties: { ...agentParam },
    required: ["agent"],
    run: (args, ctx) => {
      const a = findAgent(str(args, "agent"));
      if (!a) return noAgent(args);
      if (!a.commits && !a.files.length) return { ok: false, error: "It hasn't changed anything yet." };
      ctx.command({ cmd: "show_branch", branch: a.branch, base: a.base === "HEAD" ? a.baseSha : a.base, agent: a.id });
      return { ok: true, files: a.files };
    },
  },
  {
    name: "rebase_agent",
    description: "Bring an agent's branch up to date: replay its commits on top of its base branch as it is now (and push to its PR, if it has one open). Use it when they ask to rebase or update it, or when merging failed on a conflict. If its changes conflict, nothing changes and you'll be told where.",
    voice: "Takes a few seconds; you'll be told the result.",
    typed: "Takes a few seconds; the result shows in the activity and the Agents panel.",
    properties: { ...agentParam },
    required: ["agent"],
    run: (args, ctx) => {
      const a = findAgent(str(args, "agent"));
      if (!a) return noAgent(args);
      rebaseAgent(a.id).then(
        (r) => (
          ctx.changed?.(),
          ctx.report(
            r.upToDate
              ? `"${a.title}" was already up to date with ${r.onto}.`
              : `"${a.title}" is rebased onto ${r.onto}${r.pr ? `, and PR #${r.pr.number} is updated` : ""}.`,
            true,
          )
        ),
        (err) => ctx.report(`Rebasing "${a.title}" failed: ${errText(err)}.`, false),
      );
      return { ok: true, status: "working", say: "A few words that you're rebasing it." };
    },
  },
  {
    name: "open_pr",
    description: "Land an agent's work: push its branch and open a pull request on GitHub (or update the one it has). Only when they ask to open a PR, land, ship or submit it.",
    voice: "Takes a few seconds; you'll be told the result.",
    typed: "Takes a few seconds; the result shows in the activity and the Agents panel.",
    properties: { ...agentParam },
    required: ["agent"],
    run: (args, ctx) => {
      const a = findAgent(str(args, "agent"));
      if (!a) return noAgent(args);
      openPullRequest(a.id).then(
        (pr) => (ctx.changed?.(), ctx.report(`The pull request for "${a.title}" is open: #${pr.number}, into ${pr.base}.`, true)),
        (err) => ctx.report(`Opening the pull request for "${a.title}" failed: ${errText(err)}.`, false),
      );
      return { ok: true, status: "working", say: "A few words that you're opening it." };
    },
  },
  {
    name: "merge_pr",
    description: "Merge an agent's pull request (rebase) into its base branch. On this server merging to main deploys, so it needs their clear yes.",
    voice: "Before calling it, say what will be merged and get a clear yes in this turn. Takes a few seconds; you'll be told the result.",
    typed: "It never merges from here: it puts a Merge button on your answer, and nothing merges until they press it. Call it when they ask to merge; then say what would be merged, into which branch, and that merging deploys.",
    properties: { ...agentParam },
    required: ["agent"],
    run: (args, ctx) => {
      const a = findAgent(str(args, "agent"));
      if (!a) return noAgent(args);
      if (a.pr?.state === "merged") return { ok: false, error: `"${a.title}" is already merged (PR #${a.pr.number}).` };
      if (ctx.confirmMerge) {
        ctx.confirmMerge(a);
        return {
          ok: true,
          status: "awaiting_confirmation",
          merged: false,
          would_merge: a.pr?.state === "open" ? `PR #${a.pr.number} into ${a.pr.base}` : `${a.branch} (a PR is opened first)`,
          say: "Not merged yet. A Merge button is on the answer (and in the Agents panel) for them to confirm.",
        };
      }
      if (ctx.surface === "typed") return { ok: false, error: "Merging needs their confirmation, and there's no way to ask for it here." };
      mergePullRequest(a.id).then(
        (pr) => (ctx.changed?.(), ctx.report(`"${a.title}" is merged: PR #${pr.number} into ${pr.base}.`, true)),
        (err) => ctx.report(`Merging "${a.title}" failed: ${errText(err)}.`, false),
      );
      return { ok: true, status: "working", say: "A few words that you're merging it." };
    },
  },
  {
    name: "discard_agent",
    description: "Throw an agent's work away: its branch and its copy of the repo are deleted. Only when they explicitly ask to discard or delete it.",
    properties: { ...agentParam },
    required: ["agent"],
    run: (args) => {
      const a = findAgent(str(args, "agent"));
      if (!a) return noAgent(args);
      void discardAgent(a.id);
      return { ok: true };
    },
  },
];

/** An action's description for one route. */
export function describe(a: Action, surface: Surface): string {
  const extra = surface === "voice" ? a.voice : a.typed;
  return extra ? `${a.description} ${extra}` : a.description;
}

/** Carries out an agent action; null when `name` isn't one. */
export function runAction(name: string, args: Record<string, unknown>, ctx: ActionContext): Record<string, unknown> | null {
  const a = AGENT_ACTIONS.find((x) => x.name === name);
  return a ? a.run(args, ctx) : null;
}

/** The agents on this repo, a line each, for whichever model is choosing one. */
export function agentLines(): string[] {
  return session.state.agents.map(
    (a) =>
      `  [${a.id}] ${a.title} — ${a.status}${a.activity ? `, ${a.activity}` : ""}; ${a.files.length} files changed on ${a.branch}${a.summary && a.status !== "working" ? `. It said: ${a.summary.slice(0, 400)}` : ""}${a.pr ? `; PR #${a.pr.number} ${a.pr.state}` : ""}${a.error ? ` (${a.error})` : ""}`,
  );
}
