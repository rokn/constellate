import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { EMPTY_FILTER, applyFilter } from "../shared/filter";
import type { Frame, ScreenContext, UiCommand, View } from "../shared/types";
import { ask, interrupt } from "./navigator";
import { findPath } from "./scan";
import { addOverlay, findView, removeOverlay, session, subscribe } from "./session";

/**
 * The voice: an Inworld realtime session, bridged through this server.
 *
 * Inworld is only the conversation and the instant moves — flying, opening,
 * pointing, toggling. It never writes anything. Every request that needs the
 * code read or something new drawn goes through `ask_navigator` to the Claude
 * navigator, which owns the screen's content; the voice then says what came
 * back. Two authors on one screen would race.
 */

const INWORLD_WS = "wss://api.inworld.ai/api/v1/realtime/session";
// The voice drives the UI through tools, so the session model must support them.
const REALTIME_MODEL = process.env.INWORLD_REALTIME_MODEL ?? "openai/gpt-5.5";

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
  }, ["label"]),
  fn("clear_filter", "Show the whole map again."),
  fn("show_history", "Light up what changed in a span of history on the map: the last commit, the last day/week/month, everything loaded, or the uncommitted changes. Instant. For a specific commit or a question about what changed, ask the navigator.", {
    span: { type: "string", enum: ["last_commit", "day", "week", "month", "all", "uncommitted"] },
  }, ["span"]),
  fn("clear_history", "Back to the present: stop showing history on the map."),
  fn("replay_history", "Play through the commits toward the present, one at a time: the map turns to each commit in turn."),
  fn("mark_group", "Mark a group of files on top of the map by path patterns (globs or plain words), without reorganizing anything: a coloured beacon appears over those files. For a group that needs the code read to choose, ask the navigator.", {
    label: { type: "string" },
    include: { type: "array", items: { type: "string" } },
  }, ["label", "include"]),
  fn("remove_group", "Remove a marked group (ids from the marked groups list).", { groupId: { type: "string" } }, ["groupId"]),
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

/** Tools called mid-sentence. Prompting a response after them would cut the sentence off. */
const SILENT = new Set(["clear_history", "fly_to", "open_file", "focus_module", "overview", "back", "show_frame", "highlight", "clear_highlight", "set_layer", "set_lens", "clear_filter", "remove_group"]);

const FOLLOW_UP_SETTLE_MS = 400;

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

function instructions(screen: ScreenContext): string {
  const s = session.state;
  const o = s.overview;
  const frame = s.frames.find((f) => f.id === screen.frameId) ?? s.frames.at(-1);

  return [
    "Speak English by default. Switch language only if the user explicitly asks you to, and stay in English otherwise — even if they mix in words from another language.",
    "",
    "You are the navigator's voice in Constellate. The user is flying through a codebase rendered as a 3D map of files and dependencies, and you are sitting next to them, talking them through it. Short, natural, spoken sentences. Never read code character by character, never list bullet points, never introduce yourself.",
    "",
    "You move the screen instantly with your tools: fly_to and open_file for files, focus_module for parts of the map, overview to pull back, back to retrace, set_layer for map layers, start_tour for the guided fly-through.",
    "Point while you talk: before you mention something in the current answer, highlight it — a view by its [view <id>], diagram boxes by [node <id>], or code lines by number. The bracketed markers are labels, not on-screen text; never read them aloud.",
    "",
    "You have NOT read this code. You only know what is written below. The moment they want to understand something, see something, or ask about code not shown here, call ask_navigator (or focus_topic for a suggested topic). Say a short line first ('let me pull that up'), then stop; when the result arrives, say it in your own words. Never invent how something is wired.",
    "If they just want to go somewhere — 'take me to the auth code', 'open the server' — that's navigation: use fly_to or focus_module yourself, no navigator needed.",
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
      ? `Groups marked on the map (for remove_group): ${s.overlays.map((g) => `[${g.id}] ${g.label} — ${g.paths.length} files${g.visible ? "" : " (hidden)"}`).join("; ")}`
      : "",
    screen.range ? `The map is showing history: ${screen.range}.` : "",
    screen.lens ? `The map is organized by: ${screen.lens}.` : "",
    screen.filter ? `The map is filtered to ${screen.filter}${screen.visibleFiles !== undefined ? ` (${screen.visibleFiles} files)` : ""}.` : "",
    s.frames.length
      ? `Earlier answers (for show_frame): ${s.frames.map((f) => `[${f.id}] ${f.title}`).join("; ")}`
      : "",
    "",
    screen.openFile ? `Code panel: ${screen.openFile.path}${screen.openFile.line ? ` at line ${screen.openFile.line}` : ""}.` : "",
    screen.focusLabel ? `Camera on: ${screen.focusLabel}.` : "",
    screen.touring ? "The guided tour is playing right now." : "",
    frameDoc(frame),
    screen.selection ? `They selected this — "this"/"that" means it:\n"""\n${screen.selection.slice(0, 1500)}\n"""` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type VoiceSettings = { voiceId: string; speed: number; eagerness: "low" | "medium" | "high"; interrupt: boolean; ttsModel: string };
const DEFAULTS: VoiceSettings = { voiceId: "Sophie", speed: 1, eagerness: "medium", interrupt: true, ttsModel: "inworld-tts-2" };

function sessionUpdate(text: string, v: VoiceSettings) {
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
          turn_detection: { type: "semantic_vad", eagerness: v.eagerness, create_response: true, interrupt_response: v.interrupt },
        },
        output: { model: v.ttsModel, voice: v.voiceId, ...(v.speed !== 1 ? { speed: v.speed } : {}) },
      },
      tools: TOOLS,
      providerData: { stt: { voice_profile: false } },
    },
  };
}

/* ------------------------------- bridge ------------------------------- */

function bridge(client: WebSocket) {
  const key = process.env.INWORLD_API_KEY?.trim();
  if (!key) {
    client.send(JSON.stringify({ type: "proxy.error", message: "INWORLD_API_KEY is not set — voice is off, everything else works." }));
    client.close();
    return;
  }

  let screen: ScreenContext = {};
  let settings = DEFAULTS;
  let upstream: WebSocket | null = null;
  let ready = false;
  let responseActive = false;
  let followUpWhenIdle = false;
  let followUp: ReturnType<typeof setTimeout> | undefined;
  let lastInstructions = "";
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let attempt = 0;
  const pending: string[] = [];
  let hadOverview = !!session.state.overview;

  const toClient = (obj: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
  };
  const command = (cmd: UiCommand) => toClient({ type: "proxy.command", cmd });

  const send = (obj: unknown) => {
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(obj));
  };

  /** Re-issue the session's instructions, but only when they actually changed. */
  const sync = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (!ready) return;
      const text = instructions(screen);
      if (text === lastInstructions) return;
      lastInstructions = text;
      send(sessionUpdate(text, settings));
    }, 250);
  };

  /** Never start a response over one being spoken — it truncates mid-sentence. */
  const respond = () => {
    if (responseActive) followUpWhenIdle = true;
    else send({ type: "response.create" });
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

  const askNavigator = (request: string, topicId?: string) => {
    const started = Date.now();
    void ask(request, { topicId, screen }).then((res) => {
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

  const handleTool = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
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
          label: str("label") || undefined,
        };
        const kept = idx ? applyFilter(idx.graph.files, filter) : null;
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
      case "replay_history":
        command({ cmd: "replay" });
        return { ok: true, say: "Narrate each commit briefly as it flies by." };
      case "mark_group": {
        const include = Array.isArray(args.include) ? args.include.map(String).filter(Boolean) : [];
        const paths = idx ? [...(applyFilter(idx.graph.files, { ...EMPTY_FILTER, include }) ?? [])] : [];
        if (!str("label") || !paths.length) return { ok: false, error: "Nothing matches those patterns." };
        const why = `matches ${include.join(", ")}`;
        const g = addOverlay({ label: str("label"), summary: "", paths, reasons: Object.fromEntries(paths.map((p) => [p, why])), createdBy: "you" });
        return { ok: true, files: g.paths.length };
      }
      case "remove_group":
        removeOverlay(str("groupId"));
        return { ok: true };
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
        return { ok: false, error: `Unknown tool ${name}` };
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
      let msg: { type?: string; name?: string; call_id?: string; arguments?: string };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.type === "response.created") {
        responseActive = true;
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
            if (!responseActive) send({ type: "response.create" });
          }, FOLLOW_UP_SETTLE_MS);
        }
      }

      switch (msg.type) {
        case "session.created":
          lastInstructions = instructions(screen);
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
          let output: Record<string, unknown>;
          try {
            output = handleTool(msg.name ?? "", args);
          } catch (err) {
            // An unanswered call wedges the session for good, so it always
            // gets a result, whatever happened.
            output = { ok: false, error: String(err) };
          }
          send({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: msg.call_id, output: JSON.stringify(output) },
          });
          if (!SILENT.has(msg.name ?? "") || output.ok === false) respond();
          return;
        }
      }

      if (client.readyState === WebSocket.OPEN) client.send(text);
    });

    ws.on("close", () => {
      if (closed) return;
      ready = false;
      toClient({ type: "proxy.status", status: "reconnecting" });
      setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt++));
    });
    ws.on("error", (err) => toClient({ type: "proxy.status", status: "error", message: String(err) }));
  };

  client.on("message", (data: RawData) => {
    const text = data.toString();
    let msg: { type?: string; settings?: Partial<VoiceSettings>; screen?: ScreenContext };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "proxy.settings") {
      settings = { ...DEFAULTS, ...(msg.settings ?? {}) };
      lastInstructions = "";
      sync();
      return;
    }
    if (msg.type === "proxy.screen") {
      screen = msg.screen ?? {};
      sync();
      return;
    }
    if (upstream?.readyState === WebSocket.OPEN && ready) upstream.send(text);
    else if (pending.length < 200) pending.push(text);
  });

  client.on("close", () => {
    closed = true;
    unsubscribe();
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
    if ((req.url ?? "").split("?")[0] !== "/api/voice") return; // Vite's HMR socket
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}
