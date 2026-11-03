import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ARCH_KINDS, COLORS, ITEM_KINDS, PROTOCOLS, STATUSES, defaultsFor, describeBoard, nameOf, newId, type Board, type BoardScreen, type Item, type ItemKind, type Op, type Vec3 } from "../../shared/board";
import { ASSISTANT, askBoard, stopBoardAgent } from "./agent";
import { boardInside, change, command, getBoard, listVersions, redo, restoreVersion, saveVersion, undo, watch } from "./store";
import { LIBRARY, findPrefab } from "../../shared/holoLibrary";
import { TEMPLATE_NAMES, layTemplate } from "../../shared/templates";
import { TUNE_TOOLS, runBoardTune } from "./tune";
import { BOARD_ACTIONS, findAction } from "../../shared/boardActions";
import { findMacro, loadMacros, runMacro, saveMacros } from "./macros";
import { listBoards } from "./store";

/**
 * The workshop's voice: an Inworld realtime session, bridged here, as the
 * code map's is (server/voice.ts). It does the quick things itself — select,
 * point, add one block, link two, move, recolour, undo — and hands anything
 * that needs designing to the assistant (agent.ts), then says what it built.
 */

const INWORLD_WS = "wss://api.inworld.ai/api/v1/realtime/session";
const REALTIME_MODEL = process.env.INWORLD_REALTIME_MODEL ?? "openai/gpt-5.6-luna";
const VOICE = process.env.BOARD_VOICE ?? "Edward";
const TTS_MODEL = process.env.BOARD_TTS_MODEL ?? "inworld-tts-2";
const IDLE_MS = 10 * 60_000;
const PING_MS = 30_000;
const SYNC_MIN_MS = 2000;
const FOLLOW_UP_SETTLE_MS = 400;

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required },
});
const names = { type: "array", items: { type: "string" }, description: "Item ids, or their names as said" };

const TOOLS = [
  fn(
    "build",
    `Hand a request to ${ASSISTANT}'s builder — the part of you that designs: architectures, plans, several items at once, holograms of anything, reorganising, rewriting notes — and that can read the board's repo, so questions about the code ("where do refunds happen?", "what calls this?") and redesigns grounded in it go here too. Pass their request in their words. Returns at once; the result comes a little later.`,
    { request: { type: "string" } },
    ["request"],
  ),
  fn("stop_building", "Cancel what the builder is doing, when they change their mind."),
  fn("add", "Add one component, instantly, near where they're looking.", {
    kind: { type: "string", enum: ITEM_KINDS },
    label: { type: "string" },
    body: { type: "string", description: "For a note or text: its words" },
    color: { type: "string", enum: Object.keys(COLORS) },
  }, ["kind"]),
  fn("connect", "Link two items, instantly.", {
    from: { type: "string" },
    to: { type: "string" },
    label: { type: "string" },
    style: { type: "string", enum: ["sync", "async", "data", "depends"] },
    protocol: { type: "string", enum: PROTOCOLS },
  }, ["from", "to"]),
  fn("remove", "Delete items (by id or name). They can undo.", { items: names }, ["items"]),
  fn("select", "Select items, so 'this' means them. Empty to clear the selection.", { items: names }, ["items"]),
  fn("point", "Bring their view to items. Empty for the whole board.", { items: names }, ["items"]),
  fn("move", "Nudge items: left, right, forward (toward them), back, up or down, by metres (0.2 by default).", {
    items: names,
    direction: { type: "string", enum: ["left", "right", "forward", "back", "up", "down"] },
    metres: { type: "number" },
  }, ["items", "direction"]),
  fn("style", "Recolour, restatus, rescale or relabel items.", {
    items: names,
    color: { type: "string", enum: Object.keys(COLORS) },
    status: { type: "string", enum: STATUSES },
    scale: { type: "number" },
    label: { type: "string" },
  }, ["items"]),
  fn("explode", "Pull a hologram apart (1) or put it back together (0), or anywhere between.", { items: names, amount: { type: "number" } }, ["items", "amount"]),
  fn("spin", "Start or stop a hologram turning on its own.", { items: names, on: { type: "boolean" } }, ["items", "on"]),
  fn("hologram", `Place a ready-made hologram, instantly: ${LIBRARY.map((p) => p.name).join(", ")}. For anything else, build.`, { name: { type: "string" } }, ["name"]),
  fn("template", `Lay out a starting board where they're looking, instantly: ${TEMPLATE_NAMES.map((t) => t.name).join(", ")}.`, { name: { type: "string" } }, ["name"]),
  fn("open_inside", "Go inside an item: its own board, for what it's made of. Made the first time.", { item: { type: "string" } }, ["item"]),
  fn("go_up", "Back out to the board this one is inside of."),
  fn("save_version", "Keep the board as it is now, under a name, to come back to.", { label: { type: "string" } }, ["label"]),
  fn("restore_version", "Go back to an earlier version: 'previous' (the last one kept) or words from its label.", { which: { type: "string" } }, ["which"]),
  fn("layers", "What's shown: hide kinds of things (notes, ink, frames, holograms, links, architecture), show everything, or isolate items (everything else dims).", {
    hide: { type: "array", items: { type: "string" } },
    isolate: names,
    reset: { type: "boolean" },
  }),
  fn("undo", "Undo the last change."),
  fn("redo", "Redo what was undone."),
  fn("tool", "Switch what their hands or mouse do: select (pick and move), connect (pick two to link), ink (draw in the air), lasso (sweep to select many), erase (sweep to delete many).", { tool: { type: "string", enum: ["select", "connect", "ink", "lasso", "erase"] } }, ["tool"]),
  fn("open_board", "Switch to another board by its name (they stay in the headset).", { name: { type: "string" } }, ["name"]),
  fn(
    "run_action",
    `Do something on their screens: ${BOARD_ACTIONS.filter((a) => a.id !== "none").map((a) => `${a.id} (${a.label})`).join("; ")}. E.g. desk-mode when they want the board on their desk, wall-mode, room-scale, snapshot, shelf, structure-sketch (their ink → real blocks), photo-import (photograph a whiteboard), repo-board (the open repo's architecture), tiers.`,
    { action: { type: "string" } },
    ["action"],
  ),
  fn("dictate", "Take their next words, exactly, as an item's name (or a note's text). For when they want to say it themselves, word for word.", { item: { type: "string", description: "The item; the selection when omitted" } }),
  fn(
    "define_macro",
    "Teach yourself a phrase that runs several things in order. Each step is an action id from run_action (e.g. 'snapshot', 'save-version', 'desk-mode') or words for the builder (e.g. 'review the design and flag the risks'). The same phrase replaces it.",
    { phrase: { type: "string" }, steps: { type: "array", items: { type: "string" } } },
    ["phrase", "steps"],
  ),
  fn("run_macro", "Run a macro they taught you, when they say its phrase.", { phrase: { type: "string" } }, ["phrase"]),
  fn("delete_macro", "Forget a macro.", { phrase: { type: "string" } }, ["phrase"]),
];
TOOLS.push(...TUNE_TOOLS.map((t) => fn(t.name, t.description, t.properties, t.required)));
const SILENT = new Set(["select", "point", "move", "style", "explode", "spin", "tool", "add", "connect", "tune", "hologram", "layers", "run_action"]);

function instructions(b: Board | null, s: BoardScreen, macros: { phrase: string; steps: string[] }[] = []): string {
  const where = s.mode === "ar" ? "in passthrough on a Quest, the board a hologram on their desk" : s.mode === "vr" ? "in VR" : "at their desktop";
  return [
    `You are ${ASSISTANT}, the voice of a holographic workshop — a 3D planning board on a round holotable, Tony Stark style. They are ${where}.`,
    "Speak like a quick, dry, capable assistant: short sentences, a little wit, never a lecture. One or two sentences per turn unless they ask for more.",
    "",
    "Do the small things yourself with your tools, instantly: add one block, connect two, select, point, move, recolour, explode or spin a hologram, undo.",
    `Anything that needs designing — an architecture, a plan, several items, a hologram of something, rearranging, rewriting — goes to build. Don't describe what you'd build; call build with their request, say a few words ("On it."), then tell them what came back when it lands.`,
    "Call tools without announcing them. Refer to items by name, never by id.",
    "How it looks and behaves (glow, label size, panels, sounds, the table, your own voice…) is the Tune panel: change it with tune (read tune_knobs for the keys), presets with use_preset / save_preset.",
    `Kinds: architecture ${ARCH_KINDS.join(", ")}; note, text, frame, ink; holo (a 3D model — always via build).`,
    "",
    b ? describeBoard(b, { max: 80, selected: s.selected }) : "No board is open.",
    s.selected?.length ? `"This", "it" and "these" mean the selected items.` : "",
    b?.activity?.busy ? `The builder is working right now: ${b.activity.line ?? "thinking"}.` : "",
    macros.length ? `Their macros — when they say one of these phrases, call run_macro with it: ${macros.map((m) => `"${m.phrase}" (${m.steps.join(" → ")})`).join("; ")}.` : "",
    "When they say \"when I say X, do Y and Z\", that's define_macro.",
  ]
    .filter(Boolean)
    .join("\n");
}

function bridge(client: WebSocket, req?: IncomingMessage) {
  const key = process.env.INWORLD_API_KEY?.trim();
  if (!key) {
    client.send(JSON.stringify({ type: "proxy.error", message: "INWORLD_API_KEY is not set — voice is off; typing to the assistant still works." }));
    client.close();
    return;
  }
  const idleMin = Number(new URL(req?.url ?? "/", "http://x").searchParams.get("idle"));
  const idleAfter = Number.isFinite(idleMin) && idleMin >= 1 && idleMin <= 60 ? idleMin * 60_000 : IDLE_MS;

  let screen: BoardScreen = {};
  let macros: { phrase: string; steps: string[] }[] = [];
  void loadMacros().then((m) => (macros = m));
  const macroList = () => (screen.tune?.macros === false ? [] : macros);
  /** Taking their next words as an item's name or text. */
  let dictating = false;
  let board: Board | null = null;
  let unwatch: (() => void) | null = null;
  let upstream: WebSocket | null = null;
  let ready = false;
  let closed = false;
  let attempt = 0;
  let responseActive = false;
  let userSpeaking = false;
  let followUpWhenIdle = false;
  let pendingSync = false;
  let lastInstructions = "";
  let lastSync = 0;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let followUp: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const pending: string[] = [];

  const toClient = (o: unknown) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(o));
  const send = (o: unknown) => upstream?.readyState === WebSocket.OPEN && upstream.send(JSON.stringify(o));
  const stillHere = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      toClient({ type: "proxy.idle" });
      client.close(4000, "idle");
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

  const flush = () => {
    clearTimeout(syncTimer);
    syncTimer = undefined;
    if (!ready) return;
    const text = instructions(board, screen, macroList());
    if (text === lastInstructions) return;
    lastInstructions = text;
    lastSync = Date.now();
    send({ type: "session.update", session: { type: "realtime", instructions: text } });
  };
  // Never mid-turn: re-sending instructions while someone talks chops their speech.
  const sync = () => {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      if (userSpeaking || responseActive) pendingSync = true;
      else flush();
    }, Math.max(250, SYNC_MIN_MS - (Date.now() - lastSync)));
  };
  const respond = () => {
    if (userSpeaking) followUpWhenIdle = true;
    else if (responseActive) followUpWhenIdle = true;
    else {
      flush();
      send({ type: "response.create" });
    }
  };
  const deliver = (text: string) => {
    send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `[system] ${text}` }] } });
    respond();
  };

  /** Their voice settings, from the Tune panel: speed, eagerness, whether they can talk over it. */
  let voiceSettings = { speed: 1, eagerness: "medium" as "low" | "medium" | "high", interrupt: true };
  const fullSession = () => ({
    type: "session.update",
    session: {
      type: "realtime",
      model: REALTIME_MODEL,
      instructions: lastInstructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: "assemblyai/u3-rt-pro", language: "en" },
          // The page decides when they've talked over it (web/lib/useVoice.ts, with the
          // interrupt setting): left to the server, its own echo cancelled it mid-sentence.
          turn_detection: { type: "semantic_vad", eagerness: voiceSettings.eagerness, create_response: true, interrupt_response: false },
        },
        output: { model: TTS_MODEL, voice: VOICE, ...(voiceSettings.speed !== 1 ? { speed: voiceSettings.speed } : {}) },
      },
      tools: TOOLS,
      providerData: { stt: { voice_profile: false } },
    },
  });

  const openBoard = async (id: string | undefined) => {
    if (!id || id === board?.id) return;
    unwatch?.();
    board = (await getBoard(id))?.board ?? null;
    unwatch = board ? watch(id, (b) => ((board = b), sync())) : null;
    sync();
  };

  /** Items by id or by name as said; the selection when they said nothing. */
  const pick = (list: unknown): Item[] => {
    const b = board;
    if (!b) return [];
    const said = Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!said.length) return b.items.filter((i) => screen.selected?.includes(i.id));
    const out: Item[] = [];
    for (const s of said) {
      const low = s.toLowerCase();
      const hit =
        b.items.find((i) => i.id === s) ??
        b.items.find((i) => nameOf(i).toLowerCase() === low) ??
        b.items.find((i) => nameOf(i).toLowerCase().includes(low)) ??
        b.items.find((i) => i.kind === low);
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out;
  };

  const handleTool = async (name: string, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const b = board;
    if (!b) return { ok: false, say: "No board is open." };
    const id = b.id;
    const edit = (ops: Op[]) => change(id, ops, `voice:${Date.now()}`);
    switch (name) {
      case "build": {
        const request = String(a.request ?? "").trim();
        if (!request) return { ok: false, say: "Call again with their request." };
        const t0 = Date.now();
        void askBoard(id, request, screen).then((r) => {
          if (r.error === "superseded") return;
          console.log(`[board-voice] built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          if (r.error) deliver(`The builder hit a problem (${r.error}). Tell them briefly and offer to try again.`);
          else deliver(`The builder finished. It said: ${r.answer}\nTell them in your own words, in a sentence or two.`);
        });
        return { ok: true, status: "working", say: "A few words that you're on it. Don't describe the result yet." };
      }
      case "stop_building":
        return { ok: stopBoardAgent(id) };
      case "add": {
        const kind = (ITEM_KINDS.includes(a.kind as ItemKind) ? a.kind : "note") as ItemKind;
        const f: Vec3 = screen.focus ?? [0, 0, 0];
        const taken = b.items.map((i) => i.pos);
        let pos: Vec3 = [f[0], 0, f[2]];
        for (let k = 1; k < 200 && taken.some((t) => Math.hypot(t[0] - pos[0], t[2] - pos[2]) < 0.24); k++) {
          const r = 0.24 * Math.sqrt(k);
          pos = [f[0] + Math.cos(k * 2.4) * r, 0, f[2] + Math.sin(k * 2.4) * r];
        }
        const item = { ...defaultsFor(kind), id: newId(), kind, pos } as Item;
        if (a.label) item.label = String(a.label);
        if (a.body) item.body = String(a.body);
        if (a.color) item.color = String(a.color);
        await edit([{ op: "add", items: [item] }]);
        command(id, { cmd: "select", ids: [item.id] });
        return { ok: true, id: item.id };
      }
      case "connect": {
        const [from] = pick([a.from]);
        const [to] = pick([a.to]);
        if (!from || !to) return { ok: false, say: "Couldn't find one of those; ask which." };
        await edit([{ op: "link", links: [{ id: newId("l"), from: from.id, to: to.id, label: a.label ? String(a.label) : undefined, style: a.style as never, protocol: a.protocol as never }] }]);
        return { ok: true };
      }
      case "remove": {
        const items = pick(a.items);
        if (!items.length) return { ok: false, say: "Nothing matched." };
        await edit([{ op: "remove", ids: items.map((i) => i.id) }]);
        return { ok: true, removed: items.map(nameOf) };
      }
      case "select": {
        const items = Array.isArray(a.items) && a.items.length ? pick(a.items) : [];
        command(id, { cmd: "select", ids: items.map((i) => i.id) });
        return { ok: true, selected: items.map(nameOf) };
      }
      case "point": {
        const items = Array.isArray(a.items) && a.items.length ? pick(a.items) : [];
        command(id, items.length ? { cmd: "focus", ids: items.map((i) => i.id) } : { cmd: "overview" });
        return { ok: true };
      }
      case "move": {
        const items = pick(a.items);
        const m = typeof a.metres === "number" ? a.metres : 0.2;
        const d: Record<string, Vec3> = { left: [-m, 0, 0], right: [m, 0, 0], forward: [0, 0, m], back: [0, 0, -m], up: [0, m, 0], down: [0, -m, 0] };
        const v = d[String(a.direction)] ?? [0, 0, 0];
        await edit(items.map((i) => ({ op: "update" as const, id: i.id, patch: { pos: [i.pos[0] + v[0], Math.max(0, i.pos[1] + v[1]), i.pos[2] + v[2]] as Vec3 } })));
        return { ok: items.length > 0 };
      }
      case "style": {
        const items = pick(a.items);
        const patch: Partial<Item> = {};
        if (a.color) patch.color = String(a.color);
        if (a.status) patch.status = a.status as Item["status"];
        if (typeof a.scale === "number") patch.scale = a.scale;
        if (a.label) patch.label = String(a.label);
        await edit(items.map((i) => ({ op: "update" as const, id: i.id, patch })));
        return { ok: items.length > 0 };
      }
      case "explode":
      case "spin": {
        const items = pick(a.items).filter((i) => i.kind === "holo");
        if (!items.length) return { ok: false, say: "That isn't a hologram." };
        const patch = name === "explode" ? { explode: Math.min(1, Math.max(0, Number(a.amount) || 0)) } : { spin: !!a.on };
        await edit(items.map((i) => ({ op: "update" as const, id: i.id, patch })));
        return { ok: true };
      }
      case "hologram": {
        const p = findPrefab(String(a.name ?? ""));
        if (!p) return { ok: false, say: `Not in the library. It has: ${LIBRARY.map((x) => x.name).join(", ")}. Or build it.` };
        const f: Vec3 = screen.focus ?? [0, 0, 0];
        const item = { id: newId(), kind: "holo", label: p.name, color: p.color, spin: true, holo: { parts: p.parts }, pos: [f[0], 0, f[2]] } as Item;
        await edit([{ op: "add", items: [item] }]);
        command(id, { cmd: "select", ids: [item.id] });
        return { ok: true };
      }
      case "template": {
        const t = layTemplate(String(a.name ?? ""), screen.focus ?? [0, 0, 0]);
        if (!t) return { ok: false, say: `No such template. There are: ${TEMPLATE_NAMES.map((x) => x.name).join(", ")}.` };
        await saveVersion(id, `Before template ${a.name}`);
        await edit([{ op: "add", items: t.items, links: t.links }]);
        command(id, { cmd: "overview" });
        return { ok: true, added: t.items.length };
      }
      case "open_inside": {
        const [it] = pick([a.item]);
        if (!it) return { ok: false, say: "Couldn't find it; ask which." };
        const inner = await boardInside(id, it.id);
        if (!inner) return { ok: false };
        command(id, { cmd: "open", boardId: inner.id });
        return { ok: true, say: `You're inside ${nameOf(it)} now. It's ${inner.items.length ? "got things in it" : "empty — offer to design it"}.` };
      }
      case "go_up": {
        if (!b.parent) return { ok: false, say: "This board isn't inside anything." };
        command(id, { cmd: "open", boardId: b.parent.boardId });
        return { ok: true };
      }
      case "save_version": {
        const v = await saveVersion(id, String(a.label ?? "Saved"));
        return { ok: true, say: v ? "Saved." : "Nothing's changed since the last one." };
      }
      case "restore_version": {
        const list = await listVersions(id);
        const w = String(a.which ?? "previous").toLowerCase();
        const v = w === "previous" || w === "last" ? list[0] : list.find((x) => x.label.toLowerCase().includes(w));
        if (!v) return { ok: false, say: list.length ? `No version like that. The latest: ${list.slice(0, 4).map((x) => x.label).join("; ")}.` : "No versions kept yet." };
        return { ok: await restoreVersion(id, v.id), restored: v.label };
      }
      case "layers": {
        const isolate = Array.isArray(a.isolate) && a.isolate.length ? pick(a.isolate).map((i) => i.id) : null;
        command(id, a.reset ? { cmd: "layers", hide: [], isolate: null } : { cmd: "layers", hide: Array.isArray(a.hide) ? a.hide.map(String) : undefined, isolate });
        return { ok: true };
      }
      case "undo":
        return { ok: await undo(id) };
      case "redo":
        return { ok: await redo(id) };
      case "tool":
        command(id, { cmd: "tool", tool: a.tool as "select" | "connect" | "ink" | "lasso" | "erase" });
        return { ok: true };
      case "open_board": {
        const n = String(a.name ?? "").trim().toLowerCase();
        const list = await listBoards();
        const hit = list.find((x) => x.name.toLowerCase() === n) ?? list.find((x) => x.name.toLowerCase().includes(n));
        if (!hit) return { ok: false, say: `No board like that. There are: ${list.slice(0, 8).map((x) => x.name).join(", ")}.` };
        command(id, { cmd: "open", boardId: hit.id });
        return { ok: true, opened: hit.name };
      }
      case "run_action": {
        const act = findAction(String(a.action ?? ""));
        if (!act || act.id === "none") return { ok: false, say: "No such action." };
        command(id, { cmd: "action", id: act.id });
        return { ok: true, did: act.label };
      }
      case "dictate": {
        const [it] = a.item ? pick([a.item]) : pick([]);
        command(id, { cmd: "dictate", id: it?.id });
        return { ok: true, say: it ? `Say "go ahead" in two words or fewer; their next words become ${nameOf(it)}'s ${it.kind === "note" || it.kind === "text" ? "text" : "name"}.` : "Say 'go ahead' briefly; their next words become a new note." };
      }
      case "define_macro": {
        const phrase = String(a.phrase ?? "").trim();
        const steps = Array.isArray(a.steps) ? a.steps.map(String).filter(Boolean) : [];
        if (!phrase || !steps.length) return { ok: false, say: "Ask what the phrase is and what it should do." };
        macros = await saveMacros([...(await loadMacros()).filter((m) => m.phrase !== phrase.toLowerCase()), { phrase, steps }]);
        sync();
        return { ok: true, saved: phrase, steps };
      }
      case "run_macro": {
        const m = await findMacro(String(a.phrase ?? ""));
        if (!m) return { ok: false, say: `No macro like that. ${macros.length ? `There are: ${macros.map((x) => x.phrase).join(", ")}.` : "None are taught yet."}` };
        void runMacro(m, id, screen, () => {}).then((done) => deliver(`The macro "${m.phrase}" finished: ${done.join("; ")}. Tell them briefly.`));
        return { ok: true, status: "running", steps: m.steps, say: "A word that it's running." };
      }
      case "delete_macro": {
        const m = await findMacro(String(a.phrase ?? ""));
        if (!m) return { ok: false, say: "No macro like that." };
        macros = await saveMacros((await loadMacros()).filter((x) => x !== m));
        sync();
        return { ok: true, deleted: m.phrase };
      }
      default:
        return (await runBoardTune(name, a, id, screen)) ?? { ok: false, error: `Unknown tool ${name}` };
    }
  };

  const connect = () => {
    if (closed) return;
    const ws = new WebSocket(`${INWORLD_WS}?key=workshop-${Date.now()}&protocol=realtime`, { headers: { Authorization: `Basic ${key}` } });
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
      switch (msg.type) {
        case "input_audio_buffer.speech_started":
          userSpeaking = true;
          stillHere();
          break;
        case "input_audio_buffer.speech_stopped":
          userSpeaking = false;
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (dictating && msg.transcript?.trim()) {
            // Their words, as they said them: to the page, and the voice listens normally again.
            dictating = false;
            toClient({ type: "proxy.dictated", text: msg.transcript.trim() });
            send(fullSession());
          }
          break;
        case "response.created":
          if (dictating) send({ type: "response.cancel" });
          responseActive = true;
          userSpeaking = false;
          clearTimeout(followUp);
          break;
        case "response.done":
        case "response.cancelled":
        case "response.incomplete":
          responseActive = false;
          if (followUpWhenIdle) {
            followUpWhenIdle = false;
            clearTimeout(followUp);
            followUp = setTimeout(() => !responseActive && !userSpeaking && respond(), FOLLOW_UP_SETTLE_MS);
          }
          if (pendingSync) {
            pendingSync = false;
            sync();
          }
          break;
        case "session.created":
          lastInstructions = instructions(board, screen, macroList());
          ws.send(JSON.stringify(fullSession()));
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
          // Every call gets an answer, whatever happens: an unanswered one wedges the session.
          void handleTool(name, args)
            .catch((err) => ({ ok: false, error: String(err) }) as Record<string, unknown>)
            .then((output) => {
              send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: msg.call_id, output: JSON.stringify(output) } });
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
    let msg: { type?: string; screen?: BoardScreen };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "proxy.screen") {
      screen = msg.screen ?? {};
      void openBoard(screen.boardId);
      sync();
      return;
    }
    if (msg.type === "proxy.dictate") {
      dictating = !!(msg as { on?: boolean }).on;
      // While dictating, it hears without answering.
      if (ready) {
        const full = fullSession() as { session: { audio: { input: { turn_detection: Record<string, unknown> } } } };
        if (dictating) full.session.audio.input.turn_detection.create_response = false;
        send(full);
      }
      return;
    }
    if (msg.type === "proxy.settings") {
      const v = (msg as { settings?: { voiceSpeed?: number; eagerness?: number; interrupt?: boolean } }).settings ?? {};
      const next = {
        speed: typeof v.voiceSpeed === "number" ? Math.min(1.5, Math.max(0.6, v.voiceSpeed)) : 1,
        eagerness: (["low", "medium", "high"] as const)[Math.min(2, Math.max(0, Math.round((v.eagerness ?? 2) - 1)))],
        interrupt: v.interrupt !== false,
      };
      if (JSON.stringify(next) === JSON.stringify(voiceSettings)) return;
      voiceSettings = next;
      if (ready) send(fullSession());
      return;
    }
    if (upstream?.readyState === WebSocket.OPEN && ready) upstream.send(text);
    else if (pending.length < 200) pending.push(text);
  });

  client.on("close", () => {
    closed = true;
    clearTimeout(idleTimer);
    clearTimeout(syncTimer);
    clearTimeout(followUp);
    clearInterval(pinger);
    unwatch?.();
    upstream?.close();
  });

  connect();
}

export function attachBoardVoice(server: { on: (ev: "upgrade", cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) => void }) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", bridge);
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/api/board/voice") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}
