import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { EMPTY_FILTER, applyFilter } from "../shared/filter";
import { checkedKeys, fullyChecked } from "../shared/checked";
import type { Frame, ScreenContext, UiCommand, View } from "../shared/types";
import { ask, interrupt, storyNote } from "./navigator";
import { findPath } from "./scan";
import { addOverlay, changeOverlays, findView, session, subscribe } from "./session";
import { AGENTS_ON, onAgentFinished } from "./agents";
import { AGENT_ACTIONS, agentLines, describe, runAction } from "./actions";
import { listBranches } from "./branch";
import { TUNE_ACTIONS, runTune, tuneNote } from "./tune";
import { CHECK_ACTIONS, runChecked } from "./checked";
import { ASSISTANT } from "./board/agent";
import { BOARD_SILENT, BOARD_TOOLS, BOARD_TOOL_NAMES, BOARD_TUNE_TOOLS, boardInstructions, boardToolHandler } from "./board/voice";
import { getBoard, listBoards, watch as watchBoard } from "./board/store";
import { runBoardTune } from "./board/tune";
import { loadMacros } from "./board/macros";
import { projectBrief, projectDetail, projectOfRepo } from "./projects";
import { findBoardByName, type CodeLink } from "../shared/project";
import { nameOf, type Board, type BoardScreen, type Item } from "../shared/board";
import path from "node:path";

/**
 * The voice: an Inworld realtime session, bridged through this server. One
 * voice for the whole project: it knows which view is on screen — the Code
 * view (the map) or a board — does that view's things, and switches between
 * them ("show me the code of this" on a board opens the Code view on it).
 *
 * Inworld is only the conversation and the instant moves — flying, opening,
 * pointing, toggling. It never writes anything. Every request that needs the
 * code read or something new drawn goes through `ask_navigator` to the Claude
 * navigator, which owns the screen's content; the voice then says what came
 * back. Two authors on one screen would race.
 */

// Overridable for a test double of the realtime service.
const INWORLD_WS = process.env.INWORLD_REALTIME_URL ?? "wss://api.inworld.ai/api/v1/realtime/session";
// The voice drives the UI through tools, so the session model must support them.
const REALTIME_MODEL = process.env.INWORLD_REALTIME_MODEL ?? "openai/gpt-5.6-luna";

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required },
});

const TOOLS = [
  fn("fly_to", "Fly the camera to one file and open it in the code panel. Instant.", {
    path: { type: "string", description: "Repo-relative path; a close guess like 'auth/session' is fine" },
  }, ["path"]),
  fn("open_file", "Open a file in the code panel at a line, without moving the camera.", {
    path: { type: "string" },
    line: { type: "number" },
  }, ["path"]),
  fn("focus_module", "Fly to one logical module of the map (ids from the module list). Instant.", {
    moduleId: { type: "string" },
  }, ["moduleId"]),
  fn("focus_topic", "Start a deep dive into one of the suggested topics: flies there and has the navigator build the dossier. Takes a little while — say a short line first.", {
    topicId: { type: "string" },
  }, ["topicId"]),
  fn("overview", "Pull the camera back to the whole map and close panels."),
  fn("back", "Go back to the previous place they were."),
  fn("show_frame", "Bring an earlier answer (frame) back on screen.", { frameId: { type: "string" } }, ["frameId"]),
  fn("highlight", "Point at something in the current answer while you talk: a whole view, nodes of a diagram, or lines of a code excerpt. Silent and instant — use it constantly.", {
    viewId: { type: "string", description: "From a [view <id>] marker" },
    nodeIds: { type: "array", items: { type: "string" }, description: "Diagram node ids from [node <id>] markers" },
    lines: { type: "array", items: { type: "number" }, description: "File line numbers within a code excerpt" },
  }, ["viewId"]),
  fn("clear_highlight", "Remove any highlight."),
  fn("set_layer", "Show or hide a layer of the map: 'imports' (static import lines), 'logical' (modules and runtime links), 'labels', 'folders' (folder points and lines), 'beacons' (module and group beacons).", {
    layer: { type: "string", enum: ["imports", "logical", "labels", "folders", "beacons"] },
    on: { type: "boolean" },
  }, ["layer", "on"]),
  fn("start_tour", "Play the guided fly-through of the logical modules."),
  fn("filter_map", "Narrow the map instantly by path patterns — globs like 'internal/**' or '*.go', or plain words like 'auth' — and/or hide tests or docs. Everything else disappears. For a set that needs the code read to choose, ask the navigator instead.", {
    label: { type: "string", description: "Short name for what's shown" },
    include: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
    hideTests: { type: "boolean" },
    hideDocs: { type: "boolean" },
    hideChecked: { type: "boolean", description: "Take off files whose every connection is marked checked" },
  }, ["label"]),
  fn("clear_filter", "Show the whole map again."),
  fn("show_history", "Light up what changed in a span of history on the map: the last commit, the last day/week/month, everything loaded, or the uncommitted changes. Instant. For a specific commit or a question about what changed, ask the navigator.", {
    span: { type: "string", enum: ["last_commit", "day", "week", "month", "all", "uncommitted"] },
  }, ["span"]),
  fn("clear_history", "Back to the present: stop showing history on the map."),
  fn("show_branch", "Put a branch on the map (names from the branches list): the map becomes the code on that branch, with what it changed since it forked lit, and the camera flies there. Instant. For an agent's branch, use show_agent.", {
    branch: { type: "string", description: "The branch name; a close guess like 'login' is fine" },
  }, ["branch"]),
  fn("close_branch", "Back to the map as it's checked out: stop showing a branch."),
  fn("leave_table", "In the headset's passthrough: take the map off the real table it's set down on (table mode ends), back floating in front of them. The table is forgotten until they place it again."),
  fn("connection_direction", "In the headset, with a body focused with its rings of connections (the right stick): light only its inbound connections (the files that import it), only its outbound ones (the files it imports), or both. Kept for the next focus too. Instant.", {
    dir: { type: "string", enum: ["in", "out", "both"] },
  }, ["dir"]),
  fn("changed_only", "While a branch (or history) is on the map: on, show only the files it changed, everything else steps off; off, the whole map again. Instant. Use it when they ask for just the changes, or for the whole map back.", {
    on: { type: "boolean" },
  }, ["on"]),
  fn("replay_history", "Play through the commits toward the present, one at a time: the map turns to each commit in turn."),
  fn("add_marker", "Put a marker on files by path patterns (globs or plain words), without reorganizing anything: a coloured beacon appears over those files. For a marker that needs the code read to choose its files, ask the navigator.", {
    label: { type: "string" },
    include: { type: "array", items: { type: "string" } },
  }, ["label", "include"]),
  fn("edit_markers", "Hide, show or delete markers: by id (from the markers list), every marker one answer made (its answer id), or all of them. Delete only when they ask to remove or delete; otherwise hide.", {
    action: { type: "string", enum: ["hide", "show", "delete"] },
    ids: { type: "array", items: { type: "string" } },
    answerId: { type: "string" },
    all: { type: "boolean" },
  }, ["action"]),
  fn("set_lens", "Organize the map by an existing grouping: 'folders', 'modules', or one of the lens ids listed. To get a NEW grouping (by layer, by feature…), ask the navigator for it.", {
    lensId: { type: "string" },
  }, ["lensId"]),
  fn("ask_navigator", [
    "Hand a request to the navigator — the agent that reads the code and builds what goes on screen: explanations, diagrams of static or runtime dependencies, code excerpts, custom visualizations.",
    "Use it for anything that needs the code read or something new drawn. Never answer those from memory.",
    "Pass their request in their words plus what they're looking at. Returns immediately; the answer arrives a little later.",
  ].join(" "), { request: { type: "string" } }, ["request"]),
  fn("stop_navigator", "Cancel what the navigator is working on, when they change their mind."),
];

/** The Tune panel's knobs and presets. Shared with typed Ask (see tune.ts). On a board, the same names turn the board's knobs. */
const TUNE_TOOLS = TUNE_ACTIONS.map((a) => fn(a.name, `${describe(a, "voice")} On a board, it turns the board's own Tune instead (tune_knobs lists those keys).`, a.properties, a.required));
const BOARD_ONLY_TUNE = BOARD_TUNE_TOOLS.filter((t) => !TUNE_ACTIONS.some((a) => a.name === t.name));

/** Moving between the project's views: these work from either. */
const VIEW_TOOLS = [
  fn("switch_view", "Switch what's on screen: the Code view (the 3D map of a repo; give repo to show another of the project's repos) or a board (the last one they had open, unless board names one). Instant.", {
    view: { type: "string", enum: ["code", "board"] },
    repo: { type: "string", description: "Code view: which of the project's repos, by name" },
    board: { type: "string", description: "Board view: a board's name" },
  }, ["view"]),
  fn("open_board", "Open one of the project's boards by name (works from the Code view too; in the headset they stay in it). With item, that item selected and in view.", {
    name: { type: "string" },
    item: { type: "string", description: "An item on it, by name" },
  }, ["name"]),
  fn("show_code", [
    "From a board: open the Code view on the code behind an item — 'show me the code of this'. Uses the item's code link (its module and paths) and, by default, filters the map to only that code.",
    "An item with no code link: the navigator finds its code and shows it (takes a moment — say a short line).",
    "Or give paths/module directly.",
  ].join(" "), {
    item: { type: "string", description: "The item by name; the selected one when omitted" },
    paths: { type: "array", items: { type: "string" } },
    module: { type: "string" },
    only: { type: "boolean", description: "Filter the map to just this code (default true); false only flies there" },
  }),
  fn("show_on_board", "From the Code view: open the board item that stands for the code in focus (or the open file, or path), on its board. 'Where is this on the architecture board?'", {
    path: { type: "string" },
  }),
];
const VIEW_TOOL_NAMES = new Set(VIEW_TOOLS.map((t) => t.name));

/** Marking connections checked. Shared with typed Ask (see checked.ts). */
const CHECK_TOOLS = CHECK_ACTIONS.map((a) => fn(a.name, describe(a, "voice"), a.properties, a.required));

/** Coding agents: only offered when the server allows them. Shared with typed Ask (see actions.ts). */
const AGENT_TOOLS = AGENT_ACTIONS.map((a) => fn(a.name, describe(a, "voice"), a.properties, a.required));

/** The Code view's own tools: called on a board, they switch to the Code view first. */
const CODE_TOOL_NAMES = new Set([...TOOLS, ...CHECK_TOOLS, ...AGENT_TOOLS].map((t) => t.name));
const SHARED_TUNE = new Set(TUNE_ACTIONS.map((a) => a.name));

/** Tools called mid-sentence. Prompting a response after them would cut the sentence off. */
const SILENT = new Set([...BOARD_SILENT, "switch_view", "show_agent", "show_branch", "close_branch", "changed_only", "connection_direction", "clear_history", "fly_to", "open_file", "focus_module", "overview", "back", "show_frame", "highlight", "clear_highlight", "set_layer", "set_lens", "clear_filter", "edit_markers"]);

const FOLLOW_UP_SETTLE_MS = 400;
/** The least time between two instruction updates. */
const SYNC_MIN_MS = 2000;
/** How long after they stop talking to wait for the reply to their turn before asking for one. */
const NUDGE_AFTER_SPEECH_MS = 1500;
/**
 * Inworld bills for the audio streamed to it, heard or not, so a session
 * nobody has spoken to in this long is closed. The browser stops its mic on
 * the same clock; this is the backstop for a tab that never does.
 */
const VOICE_IDLE_MS = 10 * 60_000;
/** What the browser may ask for instead (its setting), within these minutes. */
const VOICE_IDLE_MIN = 1;
const VOICE_IDLE_MAX = 60;

/** The idle limit a connection asked for (`?idle=<minutes>`), or the default. */
function idleMs(req?: IncomingMessage): number {
  const n = Number(new URL(req?.url ?? "/", "http://x").searchParams.get("idle"));
  if (!Number.isFinite(n) || n <= 0) return VOICE_IDLE_MS;
  return Math.min(VOICE_IDLE_MAX, Math.max(VOICE_IDLE_MIN, Math.round(n))) * 60_000;
}
/** A browser that stops answering pings (a headset gone to sleep, a dropped network) is cut off. */
const PING_MS = 30_000;

/* ---------------------------- instructions ---------------------------- */

function viewLines(v: View): string[] {
  switch (v.kind) {
    case "text":
      return [`[view ${v.id}] note${v.title ? `: ${v.title}` : ""}`, v.markdown.slice(0, 1200)];
    case "code":
      return [
        `[view ${v.id}] code excerpt ${v.path} lines ${v.startLine}-${v.startLine + v.code.split("\n").length - 1}${v.note ? ` — ${v.note}` : ""}`,
        v.code.split("\n").slice(0, 60).map((l, i) => `${v.startLine + i}: ${l}`).join("\n"),
      ];
    case "diagram":
      return [
        `[view ${v.id}] ${v.layer} diagram: ${v.title}`,
        ...v.nodes.map((n) => `  [node ${n.id}] ${n.label}${n.detail ? ` — ${n.detail}` : ""}`),
        ...v.edges.map((e) => `  ${e.from} -> ${e.to}${e.label ? `: ${e.label}` : ""}`),
      ];
    case "custom":
      return [`[view ${v.id}] custom visualization: ${v.title}`];
    case "diff":
      return [
        `[view ${v.id}] diff of ${v.path}${v.note ? ` — ${v.note}` : ""}`,
        v.diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).slice(0, 40).join("\n"),
      ];
  }
}

function frameDoc(frame: Frame | undefined): string {
  if (!frame) return "";
  return [
    `Current answer on screen — "${frame.title}" (${frame.state}):`,
    frame.answer ? `What the navigator said: ${frame.answer}` : "",
    ...frame.views.flatMap(viewLines),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The branches worth showing: those with commits their base doesn't have. */
type Branches = { base: string; names: string[] };

function codeInstructions(screen: ScreenContext, branches: Branches | null): string {
  const s = session.state;
  const o = s.overview;
  const frame = s.frames.find((f) => f.id === screen.frameId) ?? s.frames.at(-1);

  return [
    "The Code view is on screen: they are flying through a codebase rendered as a 3D map of files and dependencies, and you are sitting next to them, talking them through it. Never read code character by character.",
    "",
    "You move the screen instantly with your tools: fly_to and open_file for files, focus_module for parts of the map, overview to pull back, back to retrace, set_layer for map layers, start_tour for the guided fly-through.",
    "Point while you talk: before you mention something in the current answer, highlight it — a view by its [view <id>], diagram boxes by [node <id>], or code lines by number. The bracketed markers are labels, not on-screen text; never read them aloud.",
    "",
    "You have NOT read this code. You only know what is written below. The moment they want to understand something, see something, or ask about code not shown here, call ask_navigator (or focus_topic for a suggested topic). Say a short line first ('let me pull that up'), then stop; when the result arrives, say it in your own words. Never invent how something is wired.",
    "If they just want to go somewhere — 'take me to the auth code', 'open the server' — that's navigation: use fly_to or focus_module yourself, no navigator needed.",
    "Settings are yours too: tune turns any knob of the Tune panel (how the map looks and moves, and the headset's own settings), reset_tune puts them back, use_preset / save_preset / delete_preset work the presets. Do it straight away and say what you changed in a few words.",
    "They review connections by marking them checked (safe): mark_checked marks one import line, all of a file's (the open one when they say 'this'), or only its inbound or outbound ones; checked_status says what's left. 'Hide checked' means the tune knob showChecked=off for the lines, or filter_map with hideChecked for files fully checked.",
    "",
    AGENTS_ON
      ? "You can also start coding agents (start_agent) when they want the code changed: each works on its own branch, and they review what it did on the map (show_agent). A finished agent's work opens as a pull request on its own; merge_pr merges it, only after they confirm. Questions still go to the navigator."
      : "",
    "",
    `Repository: ${s.repo?.name ?? "(none)"} — status: ${s.status}${s.busy ? " (the navigator is working)" : ""}`,
    o
      ? [
          `In one line: ${o.headline}`,
          `Summary: ${o.summary}`,
          o.welcome ? `Opening line you can use: ${o.welcome}` : "",
          `Stack: ${o.stack.join(", ")}`,
          "Modules (for focus_module):",
          ...o.modules.map((m) => `  [${m.id}] ${m.label} — ${m.summary}`),
          "Runtime links between modules:",
          ...o.edges.map((e) => `  ${e.from} -> ${e.to}: ${e.label} (${e.kind})`),
          "Suggested topics (for focus_topic):",
          ...o.topics.map((t) => `  [${t.id}] ${t.title} — ${t.hook}`),
        ]
          .filter(Boolean)
          .join("\n")
      : "The map is still being charted — the navigator is reading the repo. If they talk to you, say so in a line and let them look around.",
    `Ways to organize the map (for set_lens): [folders] by directory${o ? "; [modules] the logical modules" : ""}${s.lenses.map((l) => `; [${l.id}] ${l.title} — ${l.description}`).join("")}`,
    s.overlays.length
      ? `Markers on the map (for edit_markers): ${s.overlays.map((g) => `[${g.id}] ${g.label} — ${g.paths.length} files${g.frameId ? `, from answer ${g.frameId}` : ""}${g.visible ? "" : " (hidden)"}`).join("; ")}`
      : "",
    branches?.names.length
      ? `Branches ahead of ${branches.base} (for show_branch), newest first: ${branches.names.slice(0, 30).join(", ")}${s.repo?.branch ? `. Checked out: ${s.repo.branch}` : ""}.`
      : "",
    screen.branch
      ? `The map is showing the branch ${screen.branch.name}${screen.branch.base ? ` against ${screen.branch.base}` : ""}${screen.branch.changedOnly ? ", only the files it changed (changed_only off brings back the whole map)" : " (changed_only shows just the files it changed)"}; close_branch goes back to the checked-out code.`
      : "",
    screen.range ? `The map is showing history: ${screen.range}.` : "",
    screen.lens ? `The map is organized by: ${screen.lens}.` : "",
    screen.filter ? `The map is filtered to ${screen.filter}${screen.visibleFiles !== undefined ? ` (${screen.visibleFiles} files)` : ""}.` : "",
    s.agents.length
      ? [
          "Coding agents (for message_agent, stop_agent, show_agent, rebase_agent, open_pr, merge_pr):",
          ...agentLines(),
        ].join("\n")
      : "",
    s.frames.length
      ? `Earlier answers (for show_frame): ${s.frames.map((f) => `[${f.id}] ${f.title}`).join("; ")}`
      : "",
    "",
    screen.openFile ? `Code panel: ${screen.openFile.path}${screen.openFile.line ? ` at line ${screen.openFile.line}` : ""}.` : "",
    screen.focusLabel ? `Camera on: ${screen.focusLabel}.` : "",
    screen.touring ? "The guided tour is playing right now." : "",
    frameDoc(frame),
    screen.story && !screen.story.closed
      ? "A story is open, and it pauses while they talk to you. Answer a quick question about it from its script yourself; for anything that needs the code read or something drawn, ask the navigator, and the story waits while the answer is on screen."
      : "",
    storyNote(screen.story),
    tuneNote({ screen }),
    screen.selection ? `They selected this — "this"/"that" means it:\n"""\n${screen.selection.slice(0, 1500)}\n"""` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Which view is on screen, the project it's in, and what each view last said it shows. */
type Where = { view: "code" | "board"; projectId?: string; code: ScreenContext; board: BoardScreen };

/** Everything the voice is told: who it is, the project, the view on screen (in full), and how to get to the other. */
function instructions(w: Where, branches: Branches | null, extra: { board: Board | null; macros: { phrase: string; steps: string[] }[]; brief: string }): string {
  const onBoard = w.view === "board";
  return [
    "Speak English by default. Switch language only if the user explicitly asks you to, and stay in English otherwise — even if they mix in words from another language.",
    "",
    `You are ${ASSISTANT}, the voice of Constellate: one assistant across a project's two kinds of view — the Code view (a 3D map of one of its repos, with a navigator that reads the code) and its boards (3D planning boards: architecture, deployments, plans, nested like folders, with a builder that designs on them). Quick, dry and capable: short, natural, spoken sentences, a little wit, never a lecture, never bullet points, never introduce yourself.`,
    "",
    extra.brief,
    "",
    onBoard ? boardInstructions(extra.board, w.board, extra.macros) : codeInstructions(w.code, branches),
    "",
    "Moving between views: switch_view goes to the Code view (any of the project's repos) or back to a board; open_board opens a board by name from anywhere.",
    onBoard
      ? "From this board, 'show me the code of this' (or 'expand it', 'where is that in the code') is show_code: it opens the Code view on the item's code, filtered to just that. The map's tools (fly_to, filter_map, ask_navigator…) work from here too: they switch to the Code view first."
      : `From the Code view, show_on_board opens the board item for the code in focus. The board tools (add, connect, build…) work on the last board they had open${extra.board ? ` ("${extra.board.name}")` : ""}, switching to it first.`,
  ]
    .filter((x, i, a) => x !== "" || a[i - 1] !== "")
    .join("\n");
}

type VoiceSettings = { voiceId: string; speed: number; eagerness: "low" | "medium" | "high"; interrupt: boolean; ttsModel: string };
const DEFAULTS: VoiceSettings = { voiceId: process.env.CONSTELLATE_VOICE ?? "Sophie", speed: 1, eagerness: "medium", interrupt: true, ttsModel: "inworld-tts-2" };

/** Voice settings as either view sends them: the map's (VoiceSettings) or a board's Tune (voiceSpeed, eagerness 1–3, interrupt). */
function readSettings(v: Record<string, unknown> | undefined): VoiceSettings {
  const o = v ?? {};
  const eager = typeof o.eagerness === "number" ? (["low", "medium", "high"] as const)[Math.min(2, Math.max(0, Math.round(o.eagerness - 1)))] : (o.eagerness as VoiceSettings["eagerness"]) ?? DEFAULTS.eagerness;
  const speed = typeof o.voiceSpeed === "number" ? o.voiceSpeed : typeof o.speed === "number" ? o.speed : 1;
  return {
    voiceId: typeof o.voiceId === "string" ? o.voiceId : DEFAULTS.voiceId,
    ttsModel: typeof o.ttsModel === "string" ? o.ttsModel : DEFAULTS.ttsModel,
    speed: Math.min(1.5, Math.max(0.6, speed)),
    eagerness: ["low", "medium", "high"].includes(eager) ? eager : "medium",
    interrupt: o.interrupt !== false,
  };
}

/**
 * Only the instructions. Re-sending the audio config restarts Inworld's turn
 * detection and speech, which chopped what they were saying into fragments
 * and cut the voice off mid-sentence whenever the screen or an agent changed.
 */
function instructionsUpdate(text: string) {
  return { type: "session.update", session: { type: "realtime", instructions: text } };
}

function sessionUpdate(text: string, v: VoiceSettings, o: { dictating?: boolean } = {}) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: REALTIME_MODEL,
      instructions: text,
      output_modalities: ["audio"],
      audio: {
        input: {
          // English by default rather than auto-detected, so a stray accent or
          // a word in another language doesn't flip the conversation.
          transcription: { model: "assemblyai/u3-rt-pro", language: "en" },
          // The page decides when they've talked over it (web/lib/useVoice.ts): left to the
          // server, the voice's own echo or a cough cancelled it mid-sentence.
          // While dictating, it hears without answering: their words go to the page as said.
          turn_detection: { type: "semantic_vad", eagerness: v.eagerness, create_response: !o.dictating, interrupt_response: false },
        },
        output: { model: v.ttsModel, voice: v.voiceId, ...(v.speed !== 1 ? { speed: v.speed } : {}) },
      },
      tools: [...TOOLS, ...TUNE_TOOLS, ...CHECK_TOOLS, ...(AGENTS_ON ? AGENT_TOOLS : []), ...VIEW_TOOLS, ...BOARD_TOOLS, ...BOARD_ONLY_TUNE],
      providerData: { stt: { voice_profile: false } },
    },
  };
}

/* ------------------------------- bridge ------------------------------- */

function bridge(client: WebSocket, req?: IncomingMessage) {
  const idleAfter = idleMs(req);
  const key = process.env.INWORLD_API_KEY?.trim();
  if (!key) {
    client.send(JSON.stringify({ type: "proxy.error", message: "INWORLD_API_KEY is not set — voice is off, everything else works." }));
    client.close();
    return;
  }

  const where: Where = { view: "code", code: {}, board: {} };
  let board: Board | null = null;
  let unwatch: (() => void) | null = null;
  let macros: { phrase: string; steps: string[] }[] = [];
  void loadMacros().then((m) => (macros = m));
  const macroList = () => (where.board.tune?.macros === false ? [] : macros);
  let brief = "";
  let briefFor = "";
  /** Taking their next words as an item's name or text (a board's dictation). */
  let dictating = false;
  let branches: Branches | null = null;
  let branchesAt = 0;
  let settings: VoiceSettings = DEFAULTS;
  let upstream: WebSocket | null = null;
  let ready = false;
  let responseActive = false;
  let followUpWhenIdle = false;
  let followUp: ReturnType<typeof setTimeout> | undefined;
  let lastInstructions = "";
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSync = 0;
  let userSpeaking = false;
  let nudgeAfterSpeech = false;
  let pendingSync = false;
  let closed = false;
  let attempt = 0;
  const pending: string[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Restarted on every bit of their speech; when it runs out, the session ends. */
  const stillHere = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      toClient({ type: "proxy.idle" });
      client.close(4000, "idle");
      // Don't wait on the close handshake to stop paying.
      setTimeout(() => client.terminate(), 5000).unref();
    }, idleAfter);
  };
  stillHere();
  let alive = true;
  client.on("pong", () => (alive = true));
  const pinger = setInterval(() => {
    if (!alive) return client.terminate();
    alive = false;
    client.ping();
  }, PING_MS);
  let hadOverview = !!session.state.overview;

  const toClient = (obj: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
  };
  const command = (cmd: UiCommand) => toClient({ type: "proxy.command", cmd });

  const send = (obj: unknown) => {
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(obj));
  };

  const current = () => instructions(where, branches, { board, macros: macroList(), brief });

  /** The project's repos and boards, read again when the project, the board or the repo changes (and now and then). */
  let briefAt = 0;
  const refreshBrief = () => {
    const key = `${where.projectId}|${board?.id}|${session.state.repo?.root}|${where.view}`;
    if (key === briefFor && Date.now() - briefAt < 15_000) return;
    briefFor = key;
    briefAt = Date.now();
    void projectBrief(where.projectId, { boardId: board?.id, view: where.view }).then((b) => {
      if (b === brief) return;
      brief = b;
      sync();
    });
  };

  const openBoard = async (id: string | undefined) => {
    if (!id || id === board?.id) return;
    unwatch?.();
    board = (await getBoard(id))?.board ?? null;
    unwatch = board ? watchBoard(id, (b) => ((board = b), sync())) : null;
    refreshBrief();
    sync();
  };

  /** Send the instructions now if they changed. */
  const flush = () => {
    clearTimeout(syncTimer);
    syncTimer = undefined;
    if (!ready) return;
    const text = current();
    if (text === lastInstructions) return;
    lastInstructions = text;
    lastSync = Date.now();
    send(instructionsUpdate(text));
  };

  /**
   * Re-issue the session's instructions when they changed — but never while
   * they're talking or the voice is speaking, and at most every couple of
   * seconds (a working agent changes them constantly). A held-back update
   * goes out when the turn ends, or right before the voice is asked to speak.
   */
  const sync = () => {
    refreshBrief();
    if (syncTimer) return;
    const wait = Math.max(250, SYNC_MIN_MS - (Date.now() - lastSync));
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      if (userSpeaking || responseActive) pendingSync = true;
      else flush();
    }, wait);
  };
  const settle = () => {
    if (!pendingSync || userSpeaking || responseActive) return;
    pendingSync = false;
    sync();
  };

  /** The branch list, read again at most every 20s: an agent may have made one since. */
  const refreshBranches = () => {
    const root = session.idx?.graph.root;
    if (!root || Date.now() - branchesAt < 20_000) return;
    branchesAt = Date.now();
    void listBranches(root).then(
      (b) => {
        branches = { base: b.base, names: b.branches.filter((x) => x.name !== b.base && x.ahead > 0).map((x) => x.name) };
        sync();
      },
      () => undefined,
    );
  };

  /**
   * Never start a response over one being spoken — it truncates mid-sentence —
   * nor while they're talking: the reply to their turn picks up the news.
   */
  const respond = () => {
    if (userSpeaking) nudgeAfterSpeech = true;
    else if (responseActive) followUpWhenIdle = true;
    else {
      flush();
      send({ type: "response.create" });
    }
  };

  /** A late result, injected as a new turn for the voice to say. */
  const deliver = (text: string) => {
    send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: `[system] ${text}` }] },
    });
    respond();
  };

  // Session changes (the overview landing, a frame finishing) reach the voice's
  // instructions without the browser having to relay them.
  const unsubscribe = subscribe((s) => {
    sync();
    if (!hadOverview && s.overview && ready) {
      hadOverview = true;
      deliver(
        `The map is charted. Give them the opening in your own words — ${s.overview.welcome ?? s.overview.headline} — then offer the guided tour or one of the topics. Keep it short.`,
      );
    }
  });

  // An agent finishing is news: the voice says so, unprompted.
  const offAgents = onAgentFinished((a) => {
    if (!ready) return;
    sync();
    const what =
      a.status === "done"
        ? `finished. It changed ${a.files.length} file${a.files.length === 1 ? "" : "s"} and said: ${a.summary ?? "(nothing)"}`
        : a.status === "failed"
          ? `stopped with a problem: ${a.error ?? "unknown"}`
          : "was stopped";
    deliver(`The coding agent "${a.title}" ${what}\nTell them in a sentence or two, and offer to show it on the map.`);
  });

  const askNavigator = (request: string, topicId?: string) => {
    const started = Date.now();
    void ask(request, { topicId, screen: where.code }).then((res) => {
      const took = ((Date.now() - started) / 1000).toFixed(1);
      if (res.error === "superseded") return;
      if (res.error) {
        console.error(`[voice] navigator failed after ${took}s: ${res.error}`);
        deliver("The navigator hit a problem — tell them briefly and offer to try again.");
        return;
      }
      console.log(`[voice] navigator answered in ${took}s`);
      sync();
      deliver(
        `The navigator finished and its answer is on screen now. It said: ${res.answer}\nTell them in your own words, briefly, pointing (highlight) at the views as you mention them.`,
      );
    });
  };

  const boardTool = boardToolHandler({
    board: () => board,
    screen: () => where.board,
    deliver: (t) => deliver(t),
    sync: () => sync(),
    macros: { get: () => macros, set: (m) => (macros = m) },
    projectId: () => where.projectId,
  });

  /** The project the voice is in: the one on screen, else the one the open repo belongs to. */
  const projectId = async () => where.projectId ?? (session.state.repo ? (await projectOfRepo(session.state.repo.root))?.id : undefined);

  /** Show the Code view: the page switches, then carries out whatever map commands follow. */
  const toCode = (link?: CodeLink) => {
    command({ cmd: "view", view: "code", ...(link ? { link } : {}) });
    where.view = "code";
    sync();
  };
  const toBoard = (boardId?: string, itemId?: string) => {
    command({ cmd: "view", view: "board", ...(boardId ? { boardId } : {}), ...(itemId ? { itemId } : {}) });
    where.view = "board";
    if (boardId) void openBoard(boardId);
    sync();
  };

  /** An item on the board on screen, by name as said; the selection when nothing's said. */
  const itemOf = (said: string): Item | undefined => {
    const b = board;
    if (!b) return undefined;
    if (!said) return b.items.find((i) => where.board.selected?.includes(i.id));
    const low = said.toLowerCase();
    return b.items.find((i) => i.id === said) ?? b.items.find((i) => nameOf(i).toLowerCase() === low) ?? b.items.find((i) => nameOf(i).toLowerCase().includes(low));
  };

  const viewTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const str = (k: string) => String(args[k] ?? "").trim();
    switch (name) {
      case "switch_view": {
        if (args.view === "board") {
          if (str("board")) return viewTool("open_board", { name: str("board") });
          const pid = await projectId();
          const last = board?.id ?? (pid ? (await listBoards(pid))[0]?.id : undefined);
          toBoard(last);
          return { ok: true, view: "board", ...(board ? { board: board.name } : {}) };
        }
        const want = str("repo").toLowerCase();
        if (want) {
          const pid = await projectId();
          const d = pid ? await projectDetail(pid) : null;
          const r = d?.project.repos.find((x) => x.name.toLowerCase() === want) ?? d?.project.repos.find((x) => x.name.toLowerCase().includes(want));
          if (!r) return { ok: false, error: `No repo like that in the project. It has: ${d?.project.repos.map((x) => x.name).join(", ") || "none"}.` };
          toCode({ root: r.root });
          return { ok: true, view: "code", repo: r.name, say: r.root === session.state.repo?.root ? undefined : "It's opening that repo; a moment." };
        }
        toCode();
        return { ok: true, view: "code" };
      }
      case "open_board": {
        const pid = await projectId();
        const d = pid ? await projectDetail(pid) : null;
        const hit = d ? findBoardByName(d.tree, str("name")) : undefined;
        if (!hit) {
          const names = (await listBoards(pid)).slice(0, 10).map((b) => b.name);
          return { ok: false, say: `No board like that. There are: ${names.join(", ") || "none yet"}.` };
        }
        let itemId: string | undefined;
        if (str("item")) {
          const b = (await getBoard(hit.id))?.board;
          const low = str("item").toLowerCase();
          itemId = b?.items.find((i) => nameOf(i).toLowerCase() === low)?.id ?? b?.items.find((i) => nameOf(i).toLowerCase().includes(low))?.id;
        }
        toBoard(hit.id, itemId);
        return { ok: true, opened: hit.name };
      }
      case "show_code": {
        const it = itemOf(str("item"));
        const paths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean) : [];
        const only = args.only !== false;
        const from = board ? { boardId: board.id, itemId: it?.id } : undefined;
        const root = board?.repo?.root;
        if (paths.length || str("module")) {
          toCode({ root, paths, module: str("module") || undefined, only, label: it ? nameOf(it) : undefined, from });
          return { ok: true, say: "Say a few words; the Code view is opening on it." };
        }
        if (!it) return { ok: false, say: "Which item? Ask, or have them select it." };
        const code = it.code;
        if (code?.module || code?.paths?.length) {
          toCode({ root, module: code.module, paths: code.paths, only, label: nameOf(it), from: { boardId: board!.id, itemId: it.id } });
          return { ok: true, showing: nameOf(it), say: "A few words; the Code view is opening, filtered to its code." };
        }
        // No link to follow: the navigator finds it. On the repo that's open, the voice asks it (and hears the answer);
        // on another, the page asks once that repo has opened.
        const request = `Show me the code for "${nameOf(it)}"${it.body ? ` (${it.body.slice(0, 200)})` : ""}${it.tags?.length ? ` [${it.tags.join(", ")}]` : ""} from the board "${board!.name}": find where it lives, filter the map to just that code, and say briefly what it is.`;
        const here = !root || (session.state.repo && path.resolve(session.state.repo.root) === path.resolve(root));
        toCode({ root, label: nameOf(it), from: { boardId: board!.id, itemId: it.id }, ...(here ? {} : { ask: request }) });
        if (here) askNavigator(request);
        return { ok: true, status: "working", say: `${nameOf(it)} has no code link, so the navigator is finding it. Say one short line, then wait for its answer.` };
      }
      case "show_on_board": {
        const root = session.state.repo?.root;
        if (!root) return { ok: false, error: "No repo is open." };
        const p = str("path") || where.code.openFile?.path || "";
        const focus = where.code.focusLabel?.toLowerCase() ?? "";
        const pid = await projectId();
        const hits: { board: Board; item: Item; score: number }[] = [];
        for (const s of await listBoards(pid)) {
          if (s.repo && path.resolve(s.repo) !== path.resolve(root)) continue;
          if (!s.linked) continue;
          const b = (await getBoard(s.id))?.board;
          for (const i of b?.items ?? []) {
            const c = i.code;
            if (!b || !c) continue;
            const byPath = p && c.paths?.some((x) => p === x || p.startsWith(`${x.replace(/\/$/, "")}/`));
            const mod = c.module ? session.state.overview?.modules.find((m) => m.id === c.module) : undefined;
            const byFocus = focus && (nameOf(i).toLowerCase() === focus || mod?.label.toLowerCase() === focus || (mod && p && mod.paths.some((x) => p === x || p.startsWith(`${x.replace(/\/$/, "")}/`))));
            if (byPath || byFocus) hits.push({ board: b, item: i, score: (byPath ? 2 : 0) + (byFocus ? 1 : 0) - (b.parent ? 0.5 : 0) });
          }
        }
        hits.sort((a, b) => b.score - a.score);
        const top = hits[0];
        if (!top) return { ok: false, say: "No board item points at that code yet. Offer to draw it: open a board and build from the repo." };
        toBoard(top.board.id, top.item.id);
        return { ok: true, board: top.board.name, item: nameOf(top.item), others: hits.slice(1, 4).map((h) => `${nameOf(h.item)} on ${h.board.name}`) };
      }
    }
    return { ok: false, error: `Unknown tool ${name}` };
  };

  /** Any tool: the view's own, switching views first when it belongs to the other. */
  const handleTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (VIEW_TOOL_NAMES.has(name)) return viewTool(name, args);
    if (SHARED_TUNE.has(name) || name === "tune_knobs") {
      if (where.view === "board" && board) return (await runBoardTune(name, args, board.id, where.board)) ?? { ok: false, error: `Unknown tool ${name}` };
      if (name === "tune_knobs") return { ok: false, error: "tune_knobs lists a board's knobs; the map's are in your instructions." };
    } else if (BOARD_TOOL_NAMES.has(name)) {
      if (!board) return { ok: false, say: "No board is open yet. Offer to open one (open_board)." };
      if (where.view !== "board") toBoard(board.id);
      return boardTool(name, args);
    } else if (CODE_TOOL_NAMES.has(name) && where.view !== "code") {
      toCode();
    }
    return codeTool(name, args);
  };

  const codeTool = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
    const screen = where.code;
    const idx = session.idx;
    const str = (k: string) => String(args[k] ?? "").trim();
    const real = (p: string) => (idx ? findPath(idx, p) : null);

    switch (name) {
      case "fly_to":
      case "open_file": {
        const p = real(str("path"));
        if (!p) return { ok: false, error: `No file matches "${str("path")}". Ask the navigator to find it.` };
        command(name === "fly_to" ? { cmd: "fly_to", path: p } : { cmd: "open_file", path: p, line: Number(args.line) || undefined });
        return { ok: true, path: p };
      }
      case "focus_module": {
        const id = str("moduleId");
        if (!session.state.overview?.modules.some((m) => m.id === id)) return { ok: false, error: `No module "${id}".` };
        command({ cmd: "focus_module", moduleId: id });
        return { ok: true };
      }
      case "focus_topic": {
        const t = session.state.overview?.topics.find((x) => x.id === str("topicId"));
        if (!t) return { ok: false, error: `No topic "${str("topicId")}".` };
        command({ cmd: "focus", paths: t.paths, label: t.title });
        askNavigator(t.title, t.id);
        return { ok: true, status: "working", say: "One short line that you're heading there. Don't explain yet — the dossier arrives in a moment." };
      }
      case "overview":
        command({ cmd: "overview" });
        return { ok: true };
      case "back":
        command({ cmd: "back" });
        return { ok: true };
      case "show_frame": {
        const id = str("frameId");
        if (!session.state.frames.some((f) => f.id === id)) return { ok: false, error: `No frame "${id}".` };
        command({ cmd: "show_frame", frameId: id });
        return { ok: true };
      }
      case "highlight": {
        const found = findView(str("viewId"));
        if (!found) return { ok: false, error: `No view "${str("viewId")}" — use an id from a [view <id>] marker. Don't mention this.` };
        const nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.map(String) : undefined;
        if (nodeIds && found.view.kind === "diagram") {
          const known = new Set(found.view.nodes.map((n) => n.id));
          const bad = nodeIds.filter((n) => !known.has(n));
          if (bad.length) return { ok: false, error: `Unknown node(s) ${bad.join(", ")} in ${found.view.id}. Don't mention this.` };
        }
        const lines = Array.isArray(args.lines) ? args.lines.map(Number).filter(Number.isFinite) : undefined;
        if (found.frame.id !== screen.frameId) command({ cmd: "show_frame", frameId: found.frame.id });
        command({ cmd: "highlight", viewId: found.view.id, nodeIds, lines });
        return { ok: true };
      }
      case "clear_highlight":
        command({ cmd: "clear_highlight" });
        return { ok: true };
      case "set_layer": {
        const layer = str("layer");
        if (!["imports", "logical", "labels", "folders", "beacons"].includes(layer)) return { ok: false, error: "Unknown layer." };
        command({ cmd: "set_layer", layer: layer as "imports", on: args.on !== false });
        return { ok: true };
      }
      case "start_tour":
        if (!session.state.overview) return { ok: false, error: "The map isn't charted yet." };
        command({ cmd: "start_tour" });
        return { ok: true, say: "Narrate the tour as it flies — one or two sentences per module, in order." };
      case "filter_map": {
        const arr = (k: string) => (Array.isArray(args[k]) ? (args[k] as unknown[]).map(String).filter(Boolean) : []);
        const filter = {
          ...EMPTY_FILTER,
          include: arr("include"),
          exclude: arr("exclude"),
          hideTests: args.hideTests === true,
          hideDocs: args.hideDocs === true,
          hideChecked: args.hideChecked === true || undefined,
          label: str("label") || undefined,
        };
        const kept = idx ? applyFilter(idx.graph.files, filter, fullyChecked(idx.graph.imports, checkedKeys(session.state.checked))) : null;
        if (kept && kept.size === 0) return { ok: false, error: "That leaves nothing on the map — loosen it." };
        command(kept ? { cmd: "filter", filter } : { cmd: "clear_filter" });
        return { ok: true, visibleFiles: kept?.size ?? idx?.graph.files.length };
      }
      case "clear_filter":
        command({ cmd: "clear_filter" });
        return { ok: true };
      case "show_history": {
        const span = str("span");
        // Resolved in the browser, which holds the loaded history.
        command({ cmd: "set_range", range: { from: `span:${span}`, to: `span:${span}` } });
        return { ok: true };
      }
      case "clear_history":
        command({ cmd: "clear_range" });
        return { ok: true };
      case "show_branch": {
        const want = str("branch");
        const names = branches?.names ?? [];
        const bare = (n: string) => n.replace(/^[^/]+\//, "");
        const lower = want.toLowerCase();
        const hits = names.includes(want)
          ? [want]
          : [names.filter((n) => n.toLowerCase() === lower || bare(n).toLowerCase() === lower), names.filter((n) => n.toLowerCase().includes(lower))].find((h) => h.length) ?? [];
        if (!want || hits.length !== 1) {
          return { ok: false, error: hits.length ? `"${want}" could be ${hits.slice(0, 6).join(", ")}: ask which.` : `No branch matches "${want}". The branches: ${names.slice(0, 20).join(", ") || "none ahead of the base"}.` };
        }
        command({ cmd: "show_branch", branch: hits[0], base: branches?.base });
        return { ok: true, branch: hits[0] };
      }
      case "close_branch":
        command({ cmd: "close_branch" });
        return { ok: true };
      case "leave_table":
        if (screen.tune?.mode !== "ar") return { ok: false, error: "They aren't in passthrough, so there's no table." };
        command({ cmd: "leave_table" });
        return { ok: true };
      case "connection_direction": {
        if (!screen.tune?.mode) return { ok: false, error: "They aren't in the headset; the direction is for a focus made there." };
        const dir = args.dir === "in" || args.dir === "out" ? args.dir : "both";
        command({ cmd: "focus_direction", dir });
        return { ok: true };
      }
      case "changed_only":
        if (!screen.branch && !screen.range) return { ok: false, error: "No branch or history is on the map. Show one first." };
        command({ cmd: "changed_only", on: args.on !== false });
        return { ok: true };
      case "replay_history":
        command({ cmd: "replay" });
        return { ok: true, say: "Narrate each commit briefly as it flies by." };
      case "add_marker": {
        const include = Array.isArray(args.include) ? args.include.map(String).filter(Boolean) : [];
        const paths = idx ? [...(applyFilter(idx.graph.files, { ...EMPTY_FILTER, include }) ?? [])] : [];
        if (!str("label") || !paths.length) return { ok: false, error: "Nothing matches those patterns." };
        const why = `matches ${include.join(", ")}`;
        const g = addOverlay({ label: str("label"), summary: "", paths, reasons: Object.fromEntries(paths.map((p) => [p, why])), createdBy: "you" });
        return { ok: true, files: g.paths.length };
      }
      case "edit_markers": {
        const action = str("action") as "hide" | "show" | "delete";
        if (!["hide", "show", "delete"].includes(action)) return { ok: false, error: "Unknown action." };
        const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
        const answer = str("answerId");
        const picked = session.state.overlays.filter((o) => args.all === true || ids.includes(o.id) || (!!answer && o.frameId === answer));
        if (!picked.length) return { ok: false, error: "No markers match." };
        changeOverlays(picked.map((o) => o.id), action);
        return { ok: true, count: picked.length };
      }
      case "set_lens": {
        const id = str("lensId");
        const known = id === "folders" || (id === "modules" && !!session.state.overview) || session.state.lenses.some((l) => l.id === id);
        if (!known) return { ok: false, error: `No lens "${id}". To make a new grouping, use ask_navigator.` };
        command({ cmd: "set_lens", lensId: id });
        return { ok: true };
      }
      case "ask_navigator": {
        const request = str("request");
        if (!request) return { ok: false, say: "Call again with their actual request in `request`." };
        askNavigator(request);
        return { ok: true, status: "working", say: "One short line that you're pulling it up — five words or so. Don't answer yet." };
      }
      case "stop_navigator":
        return { ok: interrupt() };
      default:
        // The Tune panel, then the coding agents, both shared with typed Ask.
        // The voice has its yes for a merge out loud before it calls merge_pr, so it merges.
        return (
          runTune(name, args, { surface: "voice", screen, command, report: () => {} }) ??
          runChecked(name, args, { surface: "voice", screen, command, report: () => {} }) ??
          ((AGENTS_ON &&
            runAction(name, args, {
              surface: "voice",
              screen,
              command,
              report: (news, ok) => deliver(`${news} ${ok ? "Tell them in a line." : "Tell them briefly."}`),
              changed: sync,
            })) || { ok: false, error: `Unknown tool ${name}` })
        );
    }
  };

  const connect = () => {
    if (closed) return;
    const ws = new WebSocket(`${INWORLD_WS}?key=codeflight-${Date.now()}&protocol=realtime`, {
      headers: { Authorization: `Basic ${key}` },
    });
    upstream = ws;

    ws.on("open", () => {
      attempt = 0;
      toClient({ type: "proxy.status", status: "connecting" });
    });

    ws.on("message", (data: RawData) => {
      const text = data.toString();
      let msg: { type?: string; name?: string; call_id?: string; arguments?: string; transcript?: string };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.type === "conversation.item.input_audio_transcription.completed" && dictating && msg.transcript?.trim()) {
        // Their words, as they said them: to the page, and the voice listens normally again.
        dictating = false;
        toClient({ type: "proxy.dictated", text: msg.transcript.trim() });
        send(sessionUpdate(lastInstructions, settings));
      }
      if (msg.type === "response.created" && dictating) send({ type: "response.cancel" });

      if (msg.type === "input_audio_buffer.speech_started") {
        userSpeaking = true;
        stillHere();
      } else if (msg.type === "input_audio_buffer.speech_stopped") {
        userSpeaking = false;
        if (nudgeAfterSpeech) {
          // Their turn usually gets a reply of its own, which covers the news;
          // if none comes, ask for one.
          nudgeAfterSpeech = false;
          clearTimeout(followUp);
          followUp = setTimeout(() => {
            followUp = undefined;
            if (!responseActive && !userSpeaking) respond();
          }, NUDGE_AFTER_SPEECH_MS);
        }
        settle();
      } else if (msg.type === "response.created") {
        responseActive = true;
        userSpeaking = false;
        // The model started on its own (semantic VAD does this); a queued
        // nudge would now collide with it.
        clearTimeout(followUp);
        followUp = undefined;
      } else if (msg.type === "response.done" || msg.type === "response.cancelled" || msg.type === "response.incomplete") {
        responseActive = false;
        if (followUpWhenIdle) {
          followUpWhenIdle = false;
          clearTimeout(followUp);
          followUp = setTimeout(() => {
            followUp = undefined;
            if (!responseActive) respond();
          }, FOLLOW_UP_SETTLE_MS);
        }
        settle();
      }

      switch (msg.type) {
        case "session.created":
          lastInstructions = current();
          ws.send(JSON.stringify(sessionUpdate(lastInstructions, settings)));
          return;
        case "session.updated":
          if (!ready) {
            ready = true;
            toClient({ type: "proxy.status", status: "ready" });
            for (const q of pending.splice(0)) ws.send(q);
          }
          return;
        case "response.function_call_arguments.done": {
          let args: Record<string, unknown> = {};
          try {
            args = msg.arguments ? JSON.parse(msg.arguments) : {};
          } catch {
            /* tolerate malformed args */
          }
          const name = msg.name ?? "";
          // An unanswered call wedges the session for good, so it always gets a result, whatever happened.
          void handleTool(name, args)
            .catch((err) => ({ ok: false, error: String(err) }) as Record<string, unknown>)
            .then((output) => {
              send({
                type: "conversation.item.create",
                item: { type: "function_call_output", call_id: msg.call_id, output: JSON.stringify(output) },
              });
              if (!SILENT.has(name) || output.ok === false) respond();
            });
          return;
        }
      }

      if (client.readyState === WebSocket.OPEN) client.send(text);
    });

    ws.on("close", () => {
      if (closed) return;
      ready = false;
      responseActive = userSpeaking = false;
      toClient({ type: "proxy.status", status: "reconnecting" });
      setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt++));
    });
    ws.on("error", (err) => toClient({ type: "proxy.status", status: "error", message: String(err) }));
  };

  client.on("message", (data: RawData) => {
    const text = data.toString();
    let msg: { type?: string; settings?: Record<string, unknown>; screen?: Record<string, unknown> & { view?: string; projectId?: string }; on?: boolean };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "proxy.settings") {
      const next = readSettings(msg.settings);
      if (JSON.stringify(next) === JSON.stringify(settings)) return;
      settings = next;
      if (ready) {
        lastInstructions = current();
        send(sessionUpdate(lastInstructions, settings, { dictating }));
      }
      return;
    }
    if (msg.type === "proxy.screen") {
      // What's on screen, and which view: { view, projectId, ...that view's screen }.
      const { view, projectId: pid, ...rest } = msg.screen ?? {};
      if (pid) where.projectId = String(pid);
      if (view === "board") {
        where.view = "board";
        where.board = rest as BoardScreen;
        void openBoard(where.board.boardId);
      } else {
        where.view = "code";
        where.code = rest as ScreenContext;
        refreshBranches();
      }
      sync();
      return;
    }
    if (msg.type === "proxy.dictate") {
      dictating = !!msg.on;
      if (ready) send(sessionUpdate(lastInstructions, settings, { dictating }));
      return;
    }
    if (upstream?.readyState === WebSocket.OPEN && ready) upstream.send(text);
    else if (pending.length < 200) pending.push(text);
  });

  client.on("close", () => {
    closed = true;
    clearTimeout(idleTimer);
    clearInterval(pinger);
    unsubscribe();
    offAgents();
    unwatch?.();
    clearTimeout(followUp);
    clearTimeout(syncTimer);
    upstream?.close();
  });

  connect();
}

export function attachVoice(server: {
  on: (ev: "upgrade", cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) => void;
}) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", bridge);
  server.on("upgrade", (req, socket, head) => {
    // One voice for every view; /api/board/voice is the address boards used before they shared it.
    const at = (req.url ?? "").split("?")[0];
    if (at !== "/api/voice" && at !== "/api/board/voice") return; // Vite's HMR socket
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}
