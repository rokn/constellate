import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { z } from "zod";
import type { Story, StoryBeat, StoryContext, StoryCue, View } from "../shared/types";
import { EdgeShape, NodeShape, expandPaths, graphTools } from "./navigator";
import { loadFile, slice } from "./repo";
import { findPath } from "./scan";
import { getStory, newStory, patchStory, removeStory, session } from "./session";
import { synthesize, ttsAvailable, voiceKey } from "./tts";

/**
 * Stories: narrated walkthroughs of the code. The navigator reads, then writes
 * a short script — beats the voice will say — together with everything the
 * screen will show while it's said: verbatim code excerpts, diagrams that draw
 * themselves in as they're narrated, custom animated visualizations, and
 * camera moves on the map. Each cue is anchored to a phrase in the script, so
 * once Inworld has voiced the beats (with word timestamps) the player fires it
 * on the exact word. Everything is prepared before playback starts: watching
 * a story never waits on a model.
 *
 * Writing runs in its own agent session, not the navigator's: a story can be
 * written while you keep asking questions, and three are written at once for
 * the intro.
 */

const MODEL = process.env.CODEFLIGHT_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.CODEFLIGHT_STORY_EFFORT ?? "medium") as "low" | "medium" | "high";
const MAX_WORDS = 230;

const writing = new Map<string, AbortController>();

/* ------------------------------ the script ------------------------------ */

const CUE_KINDS = ["show", "lines", "reveal", "emphasize", "step", "focus", "open"] as const;

const VisualShape = z.object({
  id: z.string().describe("Your short id for it, e.g. 'loop' — cues refer to it"),
  kind: z.enum(["code", "diagram", "custom", "text"]),
  title: z.string().optional(),
  // code
  path: z.string().optional().describe("code: the file"),
  start: z.number().int().optional().describe("code: first line, from what Read showed you"),
  end: z.number().int().optional().describe("code: last line (5–40 lines in all)"),
  note: z.string().optional().describe("code: one line on what to notice"),
  // diagram
  layer: z.enum(["static", "logical"]).optional().describe("diagram: imports (static) or runtime behaviour (logical)"),
  dir: z.enum(["TD", "LR"]).optional(),
  nodes: z.array(NodeShape).optional().describe("diagram: 2–12 boxes"),
  edges: z.array(EdgeShape).optional(),
  // custom
  html: z.string().max(120_000).optional().describe("custom: self-contained HTML; see the instructions for onStoryStep"),
  height: z.number().int().min(160).max(900).optional(),
  // text
  markdown: z.string().optional().describe("text: a short markdown card"),
});

const CueShape = z.object({
  at: z.string().optional().describe("A short exact phrase from this beat's `say` — the cue fires as it's spoken. Omit to fire when the beat starts."),
  do: z.enum(CUE_KINDS),
  visual: z.string().optional().describe("show: the visual's id"),
  lines: z.array(z.number().int()).optional().describe("lines: file line numbers inside the code visual on stage"),
  nodes: z.array(z.string()).optional().describe("reveal / emphasize: node ids of the diagram on stage"),
  step: z.number().int().min(0).optional().describe("step: the custom visual's animation step"),
  paths: z.array(z.string()).optional().describe("focus: files or folder prefixes ending in '/'"),
  label: z.string().optional().describe("focus: short caption"),
  path: z.string().optional().describe("open: the file"),
  line: z.number().int().optional().describe("open: first line to highlight"),
  endLine: z.number().int().optional().describe("open: last line to highlight"),
});

const PublishShape = {
  title: z.string().describe("3–6 words"),
  summary: z.string().describe("One line on what it explains"),
  context: z
    .array(z.object({ path: z.string(), line: z.number().int().optional(), endLine: z.number().int().optional(), why: z.string().describe("A few words") }))
    .min(1)
    .max(12)
    .describe("The parts of the codebase this story is about"),
  visuals: z.array(VisualShape).min(1).max(6),
  beats: z
    .array(
      z.object({
        say: z.string().describe("1–3 short spoken sentences"),
        pauseMs: z.number().int().min(0).max(6000).optional().describe("Silence after the beat, for looking"),
        cues: z.array(CueShape).default([]),
      }),
    )
    .min(3)
    .max(10),
};

type Publish = z.infer<z.ZodObject<typeof PublishShape>>;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/**
 * Checks a script against the code and against itself, and turns it into a
 * story. Every problem is reported at once, so the writer fixes them in one go.
 */
async function compile(a: Publish): Promise<{ errors: string[]; story?: Pick<Story, "title" | "summary" | "context" | "visuals" | "beats"> }> {
  const idx = session.idx!;
  const errors: string[] = [];

  const words = a.beats.reduce((n, b) => n + b.say.split(/\s+/).filter(Boolean).length, 0);
  if (words > MAX_WORDS) errors.push(`The script is ${words} words; keep it under ${MAX_WORDS}. Cut, don't compress.`);

  // Visuals: code is cut from the real file, diagrams are checked for dangling edges.
  const visuals: View[] = [];
  const ranges = new Map<string, { start: number; end: number }>();
  const diagramNodes = new Map<string, Set<string>>();
  for (const v of a.visuals) {
    if (visuals.some((x) => x.id === v.id)) errors.push(`Two visuals have the id "${v.id}".`);
    if (v.kind === "code") {
      const file = v.path ? await loadFile(idx, v.path) : null;
      if (!file || !v.start || !v.end) {
        errors.push(`Code visual "${v.id}" needs a real path, start and end.`);
        continue;
      }
      const cut = slice(file, v.start, v.end);
      ranges.set(v.id, { start: cut.start, end: cut.end });
      visuals.push({ kind: "code", id: v.id, title: v.title, path: file.path, lang: idx.byPath.get(file.path)?.lang ?? "text", startLine: cut.start, code: cut.code, note: v.note, highlight: [], annotations: [] });
    } else if (v.kind === "diagram") {
      const nodes = v.nodes ?? [];
      const edges = v.edges ?? [];
      const ids = new Set(nodes.map((n) => n.id));
      if (nodes.length < 2) errors.push(`Diagram "${v.id}" needs at least two nodes.`);
      const bad = edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
      if (bad.length) errors.push(`Diagram "${v.id}" has edges to unknown nodes: ${bad.map((e) => `${e.from}->${e.to}`).join(", ")}.`);
      diagramNodes.set(v.id, ids);
      visuals.push({
        kind: "diagram",
        id: v.id,
        title: v.title ?? "",
        layer: v.layer ?? "logical",
        dir: v.dir ?? "LR",
        nodes: nodes.map((n) => ({ ...n, path: n.path ? (findPath(idx, n.path) ?? undefined) : undefined })),
        edges,
      });
    } else if (v.kind === "custom") {
      if (!v.html?.trim()) errors.push(`Custom visual "${v.id}" has no html.`);
      else visuals.push({ kind: "custom", id: v.id, title: v.title ?? "", html: v.html, height: v.height });
    } else {
      if (!v.markdown?.trim()) errors.push(`Text visual "${v.id}" has no markdown.`);
      else visuals.push({ kind: "text", id: v.id, title: v.title, markdown: v.markdown });
    }
  }
  const kindOf = new Map(visuals.map((v) => [v.id, v.kind]));

  // Beats: each cue is placed in its narration, and checked against what's
  // on stage at that moment, as the player will replay it.
  let stage: string | null = null;
  const beats: StoryBeat[] = a.beats.map((b, bi) => {
    const say = b.say.replace(/\s+/g, " ").trim();
    const where = `Beat ${bi + 1}`;
    if (say.length > 500) errors.push(`${where} is ${say.length} characters; a beat is one to three short sentences.`);
    const placed = b.cues.map((c) => {
      let at = 0;
      if (c.at?.trim()) {
        at = norm(say).indexOf(norm(c.at.trim()));
        if (at < 0) errors.push(`${where}: the cue phrase "${c.at}" isn't in its narration. Quote the beat's own words exactly.`);
      }
      return { c, at: Math.max(0, at) };
    });
    placed.sort((x, y) => x.at - y.at);

    const cues: StoryCue[] = [];
    for (const { c, at } of placed) {
      const bad = (msg: string) => errors.push(`${where}, cue ${c.do}${c.at ? ` at "${c.at}"` : ""}: ${msg}`);
      switch (c.do) {
        case "show":
          if (!c.visual || !kindOf.has(c.visual)) bad(`no visual "${c.visual}".`);
          else {
            stage = c.visual;
            cues.push({ at, kind: "show", visual: c.visual });
          }
          break;
        case "lines": {
          const r = stage ? ranges.get(stage) : undefined;
          if (!r) bad("needs a code visual on stage (show it first).");
          else {
            const lines = (c.lines ?? []).filter((n) => n >= r.start && n <= r.end);
            if (!lines.length) bad(`lines must be inside ${stage}'s range ${r.start}–${r.end}.`);
            else cues.push({ at, kind: "lines", lines });
          }
          break;
        }
        case "reveal":
        case "emphasize": {
          const ids = stage ? diagramNodes.get(stage) : undefined;
          if (!ids) bad("needs a diagram on stage (show it first).");
          else {
            const unknown = (c.nodes ?? []).filter((n) => !ids.has(n));
            if (unknown.length) bad(`unknown nodes ${unknown.join(", ")} in ${stage}.`);
            else if (c.do === "reveal" && !c.nodes?.length) bad("reveal which nodes?");
            else cues.push({ at, kind: c.do, nodes: c.nodes ?? [] });
          }
          break;
        }
        case "step":
          if (!stage || kindOf.get(stage) !== "custom") bad("needs a custom visual on stage.");
          else cues.push({ at, kind: "step", step: c.step ?? 0 });
          break;
        case "focus": {
          const paths = expandPaths(c.paths ?? []);
          if (!paths.length) bad("none of those paths are in the repository.");
          else cues.push({ at, kind: "focus", paths, label: c.label });
          break;
        }
        case "open": {
          const p = c.path ? findPath(idx, c.path) : null;
          if (!p) bad(`no file matches "${c.path}".`);
          else cues.push({ at, kind: "open", path: p, line: c.line, endLine: c.endLine });
          break;
        }
      }
    }
    return { id: `b${bi}`, say, pauseMs: b.pauseMs ?? 0, cues };
  });
  if (!beats[0]?.cues.some((c) => c.kind === "show" || c.kind === "focus")) {
    errors.push("Beat 1 should put something on screen as it starts: a show or a focus cue without `at`.");
  }

  const context: StoryContext[] = [];
  for (const c of a.context) {
    const p = findPath(idx, c.path);
    if (p) context.push({ path: p, line: c.line, endLine: c.endLine, why: c.why });
    else errors.push(`Context: no file matches "${c.path}".`);
  }

  return errors.length ? { errors } : { errors, story: { title: a.title, summary: a.summary, context, visuals, beats } };
}

/* ------------------------------- prompting ------------------------------- */

const SYSTEM = `You write visual stories about a codebase in Codeflight, where a developer flies through the code as a 3D map. A story is a short narrated walkthrough: a script a voice reads aloud, choreographed with visuals you prepare and camera moves on the map. The repository is your working directory; everything is read-only.

First read — Read/Grep/Glob, and the instant deps/outline tools — until you understand the thing you're explaining and have the exact line numbers you'll show. Then call publish_story exactly once (if it reports problems, fix them all and call it again). Every claim, box and arrow must come from code you read.

The script — this is spoken, and it must be concise:
- 4–7 beats, 100–170 words in all: about a minute of listening. One to three short sentences per beat. Shorter is better; cut anything the visuals already say.
- Open on the hook — what this does and why it's interesting — never "In this story we'll look at". End when the point lands; no recap, no sign-off.
- Write for the ear: plain spoken English, no markdown, no code syntax, no paths read out. Say names the way a person would ("the scan", "openRepo", "the session file").
- Let the visuals carry detail. The voice says what to notice; the screen shows it.
- The voice and the screen must agree: any number, name or count you say has to match what the visual shows at that moment.

The visuals — prepared up front, 2–5 of them:
- code: a verbatim excerpt you choose by line range (5–40 lines). Spotlight lines with "lines" cues as the narration reaches them.
- diagram: boxes and arrows. To make it live, reveal nodes as you name them ("reveal" cues); unrevealed nodes stay hidden until then. "emphasize" picks out nodes later.
- custom: self-contained HTML for what boxes can't say — a sequence, a state machine, a data shape, a timeline. It runs in a sandboxed iframe on a dark background with CSS variables --bg --panel --panel2 --line --text --muted --accent (amber) --accent2 (cyan) --good --bad --font --mono; ~640px wide. Animate it in step with the narration: define window.onStoryStep = function (n) { ... } and drive it with "step" cues (n starts at 0, which it should render on load). Steps may arrive out of order when the reader seeks, so render step n from scratch, don't accumulate. Only network: <script src="https://cdn.jsdelivr.net/npm/d3@7"></script> if you need it. data-path="file" (and data-line) makes an element fly the reader there.
- text: a short markdown card, rarely.

The choreography — cues, each anchored with "at" to a short exact phrase of its beat's narration, or with no "at" to fire as the beat begins:
- show a visual just before the narration talks about it; beat 1 starts with a show or a focus.
- focus moves the map's camera to the files being discussed — use it when the story moves to another part of the code. open puts a file in the code panel at a range; use it sparingly.
- pauseMs after a beat gives the viewer time to look: 800–2500 after a dense excerpt appears or a diagram completes, otherwise 0–400. Use pauses where a person explaining at a whiteboard would stop talking.

The context: the 3–10 places in the code the story is about, each with a few words on why.

Write in English.`;

function orientation(): string {
  const o = session.state.overview;
  if (!o) return "";
  return [
    `What this codebase is: ${o.headline}`,
    `Modules: ${o.modules.map((m) => `${m.label} (${m.summary})`).join("; ")}`,
  ].join("\n");
}

/* ------------------------------- running ------------------------------- */

function progressOf(name: string, input: Record<string, unknown>, root: string): string | null {
  const rel = (p: unknown) => (typeof p === "string" ? path.relative(root, path.resolve(root, p)) : "");
  switch (name.replace(/^mcp__story__/, "")) {
    case "Read":
      return `Reading ${rel(input.file_path)}`;
    case "Grep":
      return `Searching for ${String(input.pattern ?? "").slice(0, 50)}`;
    case "Glob":
      return `Looking for ${String(input.pattern ?? "")}`;
    case "deps":
      return `Tracing ${String(input.path ?? "")}`;
    case "outline":
      return `Outlining ${String(input.path ?? "")}`;
    case "publish_story":
      return "Choreographing the script";
    default:
      return null;
  }
}

async function write(storyId: string, prompt: string) {
  const idx = session.idx;
  if (!idx) throw new Error("No repository is open.");
  const controller = new AbortController();
  writing.set(storyId, controller);
  let published = false;

  const server = createSdkMcpServer({
    name: "story",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      ...graphTools(),
      tool(
        "publish_story",
        "Publish the story: the script with its cues, the prepared visuals, and the context. Call once when you've read enough; fix and call again if it reports problems.",
        PublishShape,
        async (a) => {
          const { errors, story } = await compile(a as Publish);
          if (!story) return { content: [{ type: "text" as const, text: `Not published — fix these and call publish_story again:\n- ${errors.join("\n- ")}` }], isError: true };
          published = true;
          patchStory(storyId, { ...story, state: "voicing", progress: undefined });
          return { content: [{ type: "text" as const, text: `Published "${story.title}": ${story.beats.length} beats, ${story.visuals.length} visuals. Reply with one short line; you're done.` }] };
        },
      ),
    ],
  });

  const tools = ["deps", "outline", "publish_story"].map((t) => `mcp__story__${t}`);
  const q = query({
    prompt,
    options: {
      cwd: idx.graph.root,
      model: MODEL,
      effort: EFFORT,
      systemPrompt: SYSTEM,
      tools: ["Read", "Grep", "Glob"],
      allowedTools: ["Read", "Grep", "Glob", ...tools],
      permissionMode: "dontAsk",
      // Same as the navigator: the opened repo's own hooks must never run.
      settingSources: [],
      mcpServers: { story: server },
      maxTurns: 40,
      abortController: controller,
      stderr: process.env.CODEFLIGHT_DEBUG ? (d) => console.error("[story]", d) : undefined,
    },
  });

  try {
    for await (const msg of q) {
      if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        for (const block of msg.message.content) {
          if (block.type !== "tool_use") continue;
          const p = progressOf(block.name, (block.input ?? {}) as Record<string, unknown>, idx.graph.root);
          if (p && getStory(storyId)?.state === "writing") patchStory(storyId, { progress: p });
        }
      } else if (msg.type === "result" && msg.subtype !== "success" && !published) {
        throw new Error(msg.subtype.replace(/_/g, " "));
      }
    }
    if (!published) throw new Error("The navigator finished without publishing the story.");
  } finally {
    writing.delete(storyId);
  }
  await voice(storyId);
}

/** Voices every beat with the current settings. Without a key, the story plays silent with captions. */
export async function voice(storyId: string) {
  const story = getStory(storyId);
  if (!story?.beats.length) return;
  const settings = session.state.storySettings;
  if (!ttsAvailable()) {
    patchStory(storyId, { state: "ready", silent: true, beats: story.beats.map((b) => ({ ...b, audio: undefined })) });
    return;
  }
  patchStory(storyId, { state: "voicing", progress: "Voicing the narration" });
  const beats = [...story.beats];
  let next = 0;
  // A few at a time: fast, without tripping the API's rate limit.
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < beats.length) {
        const i = next++;
        beats[i] = { ...beats[i], audio: await synthesize(beats[i].say, settings) };
      }
    }),
  );
  if (!getStory(storyId)) return; // deleted meanwhile
  patchStory(storyId, { beats, state: "ready", progress: undefined, silent: false, voiceKey: voiceKey(settings) });
}

function failed(storyId: string, err: unknown) {
  if (!getStory(storyId)) return;
  const message = err instanceof Error ? err.message : String(err);
  // A published story whose voicing failed still plays, silently.
  const s = getStory(storyId)!;
  if (s.beats.length) patchStory(storyId, { state: "ready", silent: true, progress: undefined, error: `Couldn't voice it: ${message}` });
  else patchStory(storyId, { state: "error", progress: undefined, error: message });
  console.error("[story]", message);
}

/* ------------------------------ public api ------------------------------ */

const styleNote = () => {
  const style = session.state.storySettings.style.trim();
  return style ? `\nNarration style the reader asked for: ${style}` : "";
};

export function writeStory(request: string): Story {
  const story = newStory(request);
  const prompt = [orientation(), "", `Write a story that explains: ${request}`, styleNote()].join("\n");
  void write(story.id, prompt).catch((err) => failed(story.id, err));
  return story;
}

/**
 * The repo's intro: three stories on the most interesting parts, written at
 * once. Each is told what the others cover, so they don't retread.
 */
export function writeIntroStories(): Story[] {
  const o = session.state.overview;
  if (!o) return [];
  const subjects = (o.topics.length >= 3 ? o.topics.map((t) => ({ title: t.title, hook: t.hook, paths: t.paths })) : o.modules.map((m) => ({ title: m.label, hook: m.summary, paths: m.paths }))).slice(0, 3);
  // Replace any earlier intro rather than piling a second one on.
  for (const s of session.state.stories.filter((x) => x.intro)) cancel(s.id);
  return subjects.map((subject, i) => {
    const story = newStory(subject.title, i + 1);
    const others = subjects.filter((_, j) => j !== i).map((s) => s.title);
    const prompt = [
      orientation(),
      "",
      `This is story ${i + 1} of 3 that introduce this codebase to someone who just opened it. They play in order.`,
      `Yours: "${subject.title}" — ${subject.hook}`,
      `Where to start reading: ${subject.paths.slice(0, 20).join(", ")}`,
      `The other two cover: ${others.join("; ")}. Don't retread them.`,
      i === 0 ? "As the first, your opening line may place this part in the whole codebase in one sentence." : "",
      styleNote(),
    ]
      .filter(Boolean)
      .join("\n");
    void write(story.id, prompt).catch((err) => failed(story.id, err));
    return story;
  });
}

export function retryStory(id: string) {
  const s = getStory(id);
  if (!s) return;
  if (s.beats.length) return void voice(id).catch((err) => failed(id, err));
  patchStory(id, { state: "writing", error: undefined, progress: undefined });
  const prompt = [orientation(), "", s.intro ? `Write intro story ${s.intro} of 3 for this codebase, about: ${s.request}` : `Write a story that explains: ${s.request}`, styleNote()].join("\n");
  void write(id, prompt).catch((err) => failed(id, err));
}

/** Re-voice with the current settings, if it was voiced differently. */
export function revoiceIfStale(id: string) {
  const s = getStory(id);
  if (!s || s.state !== "ready" || !ttsAvailable()) return false;
  if (s.voiceKey === voiceKey(session.state.storySettings) && !s.silent) return false;
  void voice(id).catch((err) => failed(id, err));
  return true;
}

export function cancel(id: string) {
  writing.get(id)?.abort();
  writing.delete(id);
  return removeStory(id);
}

/** Opening another repo stops whatever was being written for the last one. */
export function cancelAll() {
  for (const c of writing.values()) c.abort();
  writing.clear();
}

