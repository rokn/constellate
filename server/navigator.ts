import { createSdkMcpServer, query, tool, type SDKMessage, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { EMPTY_FILTER, applyFilter } from "../shared/filter";
import type { Lens, LogicalEdge, Overview, ScreenContext, View } from "../shared/types";
import { loadFile, slice } from "./repo";
import { WORKTREE, diffFile, loadHistory } from "./history";
import { digest, findPath, neighbourhood } from "./scan";
import { agentDiff } from "./agents";
import { branchDiff, fileAt } from "./branch";
import { AGENTS_ON } from "./agents";
import { AGENT_ACTIONS, agentLines, describe, type Action } from "./actions";
import { TUNE_ACTIONS, tuneNote } from "./tune";
import {
  afterRescan,
  addLens,
  putLens,
  removeLens,
  setModules,
  addOverlay,
  changeOverlays,
  addView,
  getFrame,
  newFrame,
  patchFrame,
  pushActivity,
  pushCommand,
  session,
  markCharted,
  setOverview,
  viewId,
  emit,
} from "./session";

/**
 * The navigator: Claude Code, via the Agent SDK, pointed at the open repo.
 *
 * It reads with the built-in Read/Grep/Glob — read-only, nothing that writes
 * or runs — and it talks to the screen through an in-process MCP server of
 * "flight" tools: put code on screen, draw a diagram, build a custom
 * visualization, move the camera. It is the only thing in the app that
 * generates anything; the voice only navigates, and hands every request that
 * needs reading or writing to here.
 *
 * A typed request also brings the coding-agent tools the voice has (see
 * actions.ts), so Ask can hand a change to an agent the way speaking does.
 * The navigator still writes nothing itself.
 */

const MODEL = process.env.CODEFLIGHT_MODEL ?? "claude-opus-5-5";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const INTRO_EFFORT = (process.env.CODEFLIGHT_INTRO_EFFORT ?? "medium") as Effort;
const ASK_EFFORT = (process.env.CODEFLIGHT_EFFORT ?? "medium") as Effort;

const BUILTIN = ["Read", "Grep", "Glob"];
const FLIGHT_TOOLS = [
  "deps",
  "outline",
  "focus",
  "open_file",
  "show_code",
  "show_diagram",
  "show_custom",
  "show_text",
  "filter_map",
  "set_lens",
  "get_lens",
  "revise_lens",
  "remove_lens",
  "add_markers",
  "edit_markers",
  "history",
  "read_at",
  "show_diff",
  "set_time_range",
  "changed_only",
  "set_overview",
];
const mcpName = (t: string) => `mcp__flight__${t}`;

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

function idx() {
  if (!session.idx) throw new Error("No repository is open.");
  return session.idx;
}

/** A grouping by id — a lens, or "modules" for the overview's own modules — in one shape. */
function lensById(id: string): Lens | null {
  if (id === "modules") {
    const o = session.state.overview;
    return o ? { id: "modules", title: "Modules", description: "The overview's modules", groups: o.modules, edges: o.edges, createdAt: 0 } : null;
  }
  return session.state.lenses.find((l) => l.id === id) ?? null;
}
const lensList = () =>
  `Groupings: ${[session.state.overview ? "modules (Modules)" : "", ...session.state.lenses.map((l) => `${l.id} (${l.title})`)].filter(Boolean).join(", ") || "none"}.`;

/**
 * Files the branch on the reader's map adds, which the checked-out code
 * doesn't have. While they're looking at it, groupings, markers and focus
 * take these too; they show whenever that branch is on the map.
 */
let branchOnly: string[] = [];

/** Resolves a list of paths or directory prefixes to scanned files (and the branch's own, when one is on screen). */
export function expandPaths(paths: string[], cap = 300): string[] {
  const files = [...idx().graph.files.map((f) => f.path), ...branchOnly];
  const out = new Set<string>();
  for (const raw of paths) {
    const p = raw.trim().replace(/^\.?\//, "");
    if (!p) continue;
    const asDir = p.endsWith("/") ? p : `${p}/`;
    const under = files.filter((f) => f.startsWith(asDir));
    if (under.length) under.forEach((f) => out.add(f));
    else if (branchOnly.includes(p)) out.add(p);
    else {
      const hit = findPath(idx(), p);
      if (hit) out.add(hit);
    }
    if (out.size >= cap) break;
  }
  return [...out].slice(0, cap);
}

/* ------------------------------ the tools ------------------------------ */

export const NodeShape = z.object({
  id: z.string().describe("Short stable id, e.g. 'auth'"),
  label: z.string().describe("A short plain phrase — not a file path"),
  detail: z.string().optional().describe("Optional one-line detail"),
  path: z.string().optional().describe("The file this box stands for, if any; clicking flies there"),
});
export const EdgeShape = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional().describe("What travels this edge: the call, value or event"),
});

/** Instant questions to the static graph — what imports what, a file's shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own schema
export function graphTools(): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "deps",
      "Static dependencies from the import graph: what a file imports, what imports it, or both, up to N hops. Instant — prefer it over grepping for imports.",
      {
        path: z.string(),
        direction: z.enum(["imports", "importers", "both"]).default("both"),
        depth: z.number().int().min(1).max(3).default(1),
      },
      async ({ path: p, direction, depth }) => {
        const real = findPath(idx(), p);
        if (!real) return fail(`No file matches "${p}".`);
        const hood = neighbourhood(idx(), real, direction, depth);
        const ext = idx().byPath.get(real)?.externals ?? [];
        return ok(
          [
            `${real}:`,
            ...hood.map((h) => `  ${h.via === "imports" ? "→" : "←"} ${h.path}${h.hops > 1 ? ` (${h.hops} hops)` : ""}`),
            ext.length ? `  external: ${ext.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n") || `${real} has no in-repo dependencies.`,
        );
      },
    ),
    tool(
      "outline",
      "A file's symbols with line numbers, its size, and its direct imports/importers. Cheaper than reading the whole file when you only need its shape.",
      { path: z.string() },
      async ({ path: p }) => {
        const real = findPath(idx(), p);
        const info = real ? idx().byPath.get(real) : undefined;
        if (!real || !info) return fail(`No file matches "${p}".`);
        return ok(
          [
            `${real} — ${info.lang}, ${info.loc} lines`,
            ...info.symbols.map((s) => `  L${s.line} ${s.kind} ${s.name}`),
            `imports: ${(idx().out.get(real) ?? []).join(", ") || "none"}`,
            `imported by: ${(idx().in.get(real) ?? []).join(", ") || "none"}`,
          ].join("\n"),
        );
      },
    ),
  ];
}

/** What a placement run may use: enough to see where a file belongs, and to put it there. */
const PLACE_TOOLS = ["deps", "outline", "get_lens", "revise_lens"];

/**
 * The voice's own tools for a typed request (the coding agents, actions.ts;
 * the Tune panel, tune.ts), in the SDK's shape. Late news goes to the
 * activity; a merge waits for the Merge button this puts on the answer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own schema
function actionTools(list: Action[], frameId: string, screen: ScreenContext): SdkMcpToolDefinition<any>[] {
  return list.map((a) =>
    tool(
      a.name,
      describe(a, "typed"),
      Object.fromEntries(
        Object.entries(a.properties).map(([k, p]) => {
          const s = p.description ? z.string().describe(p.description) : z.string();
          return [k, a.required.includes(k) ? s : s.optional()];
        }),
      ),
      async (args) => {
        let out: Record<string, unknown> | null;
        try {
          out = a.run(args, {
            surface: "typed",
            screen,
            command: pushCommand,
            report: (news, good) => pushActivity({ kind: good ? "tool" : "error", detail: news }),
            confirmMerge: (agent) => patchFrame(frameId, { confirm: { action: "merge", agentId: agent.id } }),
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
        return out?.ok === false ? fail(JSON.stringify(out)) : ok(JSON.stringify(out));
      },
    ),
  );
}

function flightServer(frameId: string | null, mode: "intro" | "ask" | "place", actions?: ScreenContext, tune?: ScreenContext) {
  const needFrame = () => {
    if (!frameId) throw new Error("Views can only be shown while answering a request.");
    return frameId;
  };
  const show = (view: View) => {
    addView(needFrame(), view);
    return ok(`On screen as view ${view.id}.`);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool has its own schema
  const tools: SdkMcpToolDefinition<any>[] = [
    ...graphTools(),
    tool(
      "focus",
      "Fly the reader's camera to a set of files (or directory prefixes ending in '/'), dimming everything else. Call it early with the files your answer is about, so they travel while you work.",
      { paths: z.array(z.string()).min(1), label: z.string().describe("Short caption for this constellation") },
      async ({ paths, label }) => {
        const files = expandPaths(paths);
        if (!files.length) return fail("None of those paths are in the repository.");
        pushCommand({ cmd: "focus", paths: files, label });
        if (frameId) patchFrame(frameId, { focus: files });
        return ok(`Camera on ${files.length} file(s).`);
      },
    ),
    tool(
      "open_file",
      "Open a file in the reader's code panel, optionally scrolled to and highlighting a line range.",
      { path: z.string(), line: z.number().int().optional(), endLine: z.number().int().optional() },
      async ({ path: p, line, endLine }) => {
        const real = findPath(idx(), p);
        if (!real) return fail(`No file matches "${p}".`);
        pushCommand({ cmd: "open_file", path: real, line, endLine });
        return ok(`Opened ${real}.`);
      },
    ),
    tool(
      "show_code",
      "Put a verbatim excerpt of a real file on screen. You choose the line range (use the line numbers Read showed you); the text is cut from the file server-side. Keep excerpts focused: 5–60 lines.",
      {
        path: z.string(),
        start: z.number().int().min(1),
        end: z.number().int().min(1),
        title: z.string().optional(),
        note: z.string().optional().describe("One line on why this excerpt matters"),
        highlight: z.array(z.number().int()).optional().describe("File line numbers to spotlight"),
        annotations: z
          .array(z.object({ line: z.number().int(), text: z.string() }))
          .optional()
          .describe("Margin notes pinned to file line numbers"),
      },
      async (a) => {
        const file = await loadFile(idx(), a.path);
        if (!file) return fail(`No file matches "${a.path}".`);
        const cut = slice(file, a.start, a.end);
        const inRange = (n: number) => n >= cut.start && n <= cut.end;
        return show({
          kind: "code",
          id: viewId("code"),
          title: a.title,
          path: file.path,
          lang: idx().byPath.get(file.path)?.lang ?? "text",
          startLine: cut.start,
          code: cut.code,
          note: a.note,
          highlight: (a.highlight ?? []).filter(inRange),
          annotations: (a.annotations ?? []).filter((x) => inRange(x.line)),
        });
      },
    ),
    tool(
      "show_diagram",
      "Draw boxes and arrows, laid out automatically. layer 'static' for structure taken from imports; 'logical' for runtime behaviour you verified by reading (calls over HTTP, events, data flow, rendering). Labels are plain phrases; put the file in `path`. 3–12 nodes.",
      {
        title: z.string(),
        layer: z.enum(["static", "logical"]),
        dir: z.enum(["TD", "LR"]).default("LR"),
        nodes: z.array(NodeShape).min(2).max(18),
        edges: z.array(EdgeShape),
      },
      async (a) => {
        const ids = new Set(a.nodes.map((n) => n.id));
        const bad = a.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
        if (bad.length) {
          return fail(`Edges reference unknown nodes: ${bad.map((e) => `${e.from}->${e.to}`).join(", ")}. Fix and call again.`);
        }
        return show({
          kind: "diagram",
          id: viewId("diagram"),
          title: a.title,
          layer: a.layer,
          dir: a.dir,
          nodes: a.nodes.map((n) => ({ ...n, path: n.path ? (findPath(idx(), n.path) ?? undefined) : undefined })),
          edges: a.edges,
        });
      },
    ),
    tool(
      "show_custom",
      [
        "Build a custom visualization as self-contained HTML (inline <style>/<script>, SVG, canvas) — for whatever boxes-and-arrows can't say well: a sequence of a request through the system, a state machine, a timeline, a data shape, a lifecycle, a comparison table, an animated flow.",
        "It renders in a sandboxed iframe on a dark background. CSS variables are predefined: --bg, --panel, --panel2, --line, --text, --muted, --accent (amber), --accent2 (cyan), --good, --bad, --font, --mono. Use them; don't set a page background.",
        "Make anything that stands for code clickable with data-path=\"repo/relative/file.ts\" and optional data-line=\"42\" — the frame wires those to fly the reader there.",
        "Only network access: <script src=\"https://cdn.jsdelivr.net/npm/d3@7\"></script> if you genuinely need d3. Width is ~640px; set `height` to what you need (default 420).",
      ].join(" "),
      {
        title: z.string(),
        html: z.string().max(120_000),
        height: z.number().int().min(160).max(1200).optional(),
      },
      async (a) => show({ kind: "custom", id: viewId("custom"), title: a.title, html: a.html, height: a.height }),
    ),
    tool(
      "show_text",
      "A short markdown note on screen — a list of gotchas, a glossary, steps to reproduce. Use sparingly; prefer showing code or a picture.",
      { title: z.string().optional(), markdown: z.string() },
      async (a) => show({ kind: "text", id: viewId("text"), title: a.title, markdown: a.markdown }),
    ),
  ];

  if (mode !== "intro") {
    tools.push(
      tool(
        "filter_map",
        "Narrow the map to what matters for this question: everything else disappears and the rest re-lays itself out. Patterns are globs ('internal/**', '*.go') or plain substrings ('auth'). Use `paths` for an exact set you chose by reading. Call with nothing but a label to clear.",
        {
          label: z.string().describe("Short name for what's shown, e.g. 'Payment flow, no tests'"),
          include: z.array(z.string()).optional(),
          exclude: z.array(z.string()).optional(),
          paths: z.array(z.string()).optional().describe("Exact files or directory prefixes ending in '/'"),
          hideTests: z.boolean().optional(),
          hideDocs: z.boolean().optional(),
        },
        async (a) => {
          const filter = {
            ...EMPTY_FILTER,
            include: a.include ?? [],
            exclude: a.exclude ?? [],
            hideTests: a.hideTests ?? false,
            hideDocs: a.hideDocs ?? false,
            paths: a.paths?.length ? expandPaths(a.paths, 2000) : undefined,
            label: a.label,
          };
          const kept = applyFilter(idx().graph.files, filter);
          if (kept && kept.size === 0) return fail("That filter leaves nothing on the map. Loosen it.");
          pushCommand(kept ? { cmd: "filter", filter } : { cmd: "clear_filter" });
          return ok(kept ? `Map now shows ${kept.size} of ${idx().graph.files.length} files.` : "Filter cleared.");
        },
      ),
      tool(
        "add_markers",
        [
          "Put markers on top of the map without reorganizing it: each becomes a coloured beacon over its files, with spokes to each one, while the current layout and separation stay exactly as they are.",
          "Use it to point out cross-cutting sets — everything that touches billing, the hot path of a request, the files a change would ripple into — or when they ask to mark something, or group it without asking to reorganize.",
          "Markers are not groupings: a grouping (set_lens) reorganizes the whole map; a marker only points.",
        ].join(" "),
        {
          markers: z
            .array(
              z.object({
                label: z.string().describe("2–4 words"),
                summary: z.string().describe("One short sentence, under 20 words: what it does. Shown when its beacon is hovered"),
                paths: z
                  .array(z.union([z.string(), z.object({ path: z.string(), why: z.string() })]))
                  .describe(
                    "Files (or directory prefixes ending in '/'). Prefer { path, why } with a few words on why that file belongs — the reader sees it when hovering the line to that file.",
                  ),
              }),
            )
            .min(1)
            .max(8),
        },
        async (a) => {
          const made = a.markers
            .map((g) => {
              // Each entry's reason covers every file it expands to.
              const reasons: Record<string, string> = {};
              const paths: string[] = [];
              for (const entry of g.paths) {
                const [p, why] = typeof entry === "string" ? [entry, ""] : [entry.path, entry.why];
                for (const f of expandPaths([p], 1500)) {
                  if (!paths.includes(f)) paths.push(f);
                  if (why) reasons[f] = why;
                }
              }
              return { ...g, paths: paths.slice(0, 1500), reasons };
            })
            .filter((g) => g.paths.length)
            .map((g) =>
              addOverlay({ label: g.label, summary: g.summary, paths: g.paths, reasons: g.reasons, createdBy: "navigator", frameId: frameId ?? undefined }),
            );
          if (!made.length) return fail("None of those paths are in the repository.");
          return ok(`Marked ${made.map((m) => `"${m.label}" [${m.id}] (${m.paths.length} files)`).join(", ")} on the map. The layout is unchanged.`);
        },
      ),
      tool(
        "edit_markers",
        [
          "Hide, show or delete markers on the map. Pick them by id (the screen note lists every marker with its id and the answer that made it), by `answer` — every marker one answer made, using the answer's id, or 'this' for the answer you're writing now — or with `all`.",
          "Hidden markers stay in their list for the reader to bring back; deleted ones are gone. Only delete when they ask to remove or delete; 'hide', 'clear' or 'get rid of for now' means hide.",
        ].join(" "),
        {
          action: z.enum(["hide", "show", "delete"]),
          ids: z.array(z.string()).optional().describe("Marker ids"),
          answer: z.string().optional().describe("An answer's id, or 'this': every marker that answer made"),
          all: z.boolean().optional().describe("Every marker on the map"),
        },
        async (a) => {
          const answer = a.answer === "this" ? frameId : a.answer;
          const picked = session.state.overlays.filter(
            (o) => a.all || a.ids?.includes(o.id) || (!!answer && o.frameId === answer),
          );
          if (!picked.length) {
            const list = session.state.overlays.map((o) => `[${o.id}] ${o.label}`).join("; ");
            return fail(`No markers match. ${list ? `On the map: ${list}.` : "There are none on the map."}`);
          }
          changeOverlays(
            picked.map((o) => o.id),
            a.action,
          );
          const done = { hide: "Hid", show: "Showed", delete: "Deleted" }[a.action];
          return ok(`${done} ${picked.map((o) => `"${o.label}"`).join(", ")}.`);
        },
      ),
      tool(
        "set_lens",
        [
          "Reorganize the map: publish a grouping of the code and the reader's map physically regroups into it, each group a coloured cluster with a beacon, your edges arcing between them.",
          "Use it when they want to see the code organized a different way than folders — by architectural layer, by feature, by runtime process or service, by data flow, by who calls whom, by age or risk.",
          "Groups should cover the code relevant to the grouping (directory prefixes ending in '/' are fine); files you leave out gather in an 'Other' cluster. Edges are how groups relate in this view.",
        ].join(" "),
        {
          title: z.string().describe("2–4 words, e.g. 'By layer'"),
          description: z.string().describe("One sentence on what this grouping shows"),
          groups: z
            .array(
              z.object({
                id: z.string(),
                label: z.string().describe("2–4 words"),
                summary: z.string().describe("One short sentence, under 20 words: what it does. Shown when its beacon is hovered"),
                paths: z.array(z.string()),
              }),
            )
            .min(2)
            .max(14),
          edges: z
            .array(
              z.object({
                from: z.string(),
                to: z.string(),
                label: z.string(),
                kind: z.enum(["calls", "data", "event", "http", "config", "renders", "other"]),
              }),
            )
            .default([]),
        },
        async (a) => {
          const groups = a.groups.map((g) => ({ ...g, paths: expandPaths(g.paths, 3500) })).filter((g) => g.paths.length);
          if (groups.length < 2) return fail("Fewer than two groups matched real files. Check the paths.");
          const ids = new Set(groups.map((g) => g.id));
          const lens: Lens = {
            id: `lens-${Date.now().toString(36)}`,
            title: a.title,
            description: a.description,
            groups,
            edges: a.edges.filter((e): e is LogicalEdge => ids.has(e.from) && ids.has(e.to) && e.from !== e.to),
            createdAt: Date.now(),
          };
          addLens(lens);
          pushCommand({ cmd: "set_lens", lensId: lens.id });
          const covered = new Set(groups.flatMap((g) => g.paths)).size;
          return ok(`Map regrouped into ${groups.length} groups covering ${covered} of ${idx().graph.files.length} files; the rest gather in "Other".`);
        },
      ),
      tool(
        "get_lens",
        "What a grouping holds: its groups (id, label, summary, how many files and in which folders) and its edges. Use it before revising a grouping, so you work from what's there rather than from memory. 'modules' is the overview's own modules.",
        { lensId: z.string().describe("The grouping's id (the screen note says which one is showing), or 'modules'") },
        async (a) => {
          const g = lensById(a.lensId);
          if (!g) return fail(`No grouping "${a.lensId}". ${lensList()}`);
          return ok(
            [
              `${g.title} (${g.id})${g.description ? ` — ${g.description}` : ""}`,
              "Groups:",
              ...g.groups.map((x) => `- ${x.id} — ${x.label} (${x.paths.length} files): ${x.summary} · ${foldPaths(x.paths)}`),
              "Edges:",
              ...(g.edges.length ? g.edges.map((e) => `- ${e.from} → ${e.to} (${e.kind}): ${e.label}`) : ["(none)"]),
            ].join("\n"),
          );
        },
      ),
      tool(
        "revise_lens",
        [
          "Change an existing grouping in place: the reader stays in it and the map just moves the affected files across. Use this — not set_lens — for any change to the organization they have: split or merge a group, move files or folders between groups, add, rename or remove a group, fix an edge.",
          "Operations apply in order. upsert_group creates a group (give a label) or updates one; its paths, if given, move into it from wherever they were. move puts paths into an existing group. remove_group drops a group; its files go to `to`, or to Other. To split X into A and B: upsert_group A with its paths, upsert_group B with its paths, then remove_group X (anything left in X goes to `to`).",
          "Paths can be files or folder prefixes ending in '/'. Groups left with no files are dropped, with their edges.",
        ].join(" "),
        {
          lensId: z.string().describe("The grouping's id, or 'modules' for the overview's modules"),
          title: z.string().optional().describe("New title for the grouping, if it should change"),
          ops: z
            .array(
              z.object({
                op: z.enum(["upsert_group", "move", "remove_group", "add_edge", "remove_edge"]),
                id: z.string().optional().describe("upsert_group / remove_group: the group"),
                label: z.string().optional(),
                summary: z.string().optional().describe("One short sentence, under 20 words: what it does. Shown when its beacon is hovered"),
                paths: z.array(z.string()).optional().describe("upsert_group / move: files or folder prefixes"),
                to: z.string().optional().describe("move: target group; remove_group: where its files go; add_edge / remove_edge: target group"),
                from: z.string().optional().describe("add_edge / remove_edge: source group"),
                kind: z.enum(["calls", "data", "event", "http", "config", "renders", "other"]).optional(),
              }),
            )
            .min(1),
        },
        async (a) => {
          const lens = lensById(a.lensId);
          if (!lens) return fail(`No grouping "${a.lensId}". ${lensList()}`);
          if (lens.derived) return fail(`"${lens.title}" is built from the code and rebuilt with every scan, so it can't be edited. Write a new grouping with set_lens instead, starting from get_lens.`);
          const groups = lens.groups.map((g) => ({ ...g, paths: [...g.paths] }));
          let edges = [...lens.edges];
          const find = (id?: string) => groups.find((g) => g.id === id);
          const take = (paths: string[]) => {
            const set = new Set(paths);
            for (const g of groups) g.paths = g.paths.filter((p) => !set.has(p));
          };
          const notes: string[] = [];
          for (const op of a.ops) {
            if (op.op === "upsert_group") {
              if (!op.id) return fail("upsert_group needs an id.");
              let g = find(op.id);
              if (!g) {
                if (!op.label) return fail(`upsert_group "${op.id}" is new, so it needs a label.`);
                g = { id: op.id, label: op.label, summary: op.summary ?? "", paths: [] };
                groups.push(g);
              }
              if (op.label) g.label = op.label;
              if (op.summary !== undefined) g.summary = op.summary;
              if (op.paths?.length) {
                const files = expandPaths(op.paths, 3500);
                if (!files.length) notes.push(`No files matched ${op.paths.join(", ")} for ${op.id}.`);
                take(files);
                g.paths.push(...files);
              }
            } else if (op.op === "move") {
              const g = find(op.to);
              if (!g) return fail(`move: no group "${op.to}" — create it with upsert_group first.`);
              const files = expandPaths(op.paths ?? [], 3500);
              if (!files.length) notes.push(`move: no files matched ${(op.paths ?? []).join(", ")}.`);
              take(files);
              g.paths.push(...files);
            } else if (op.op === "remove_group") {
              const g = find(op.id);
              if (!g) return fail(`remove_group: no group "${op.id}".`);
              const dest = op.to ? find(op.to) : undefined;
              if (op.to && !dest) return fail(`remove_group: no group "${op.to}" to move its files to.`);
              dest?.paths.push(...g.paths);
              groups.splice(groups.indexOf(g), 1);
            } else if (op.op === "add_edge") {
              if (!find(op.from) || !find(op.to)) return fail(`add_edge: both ends must be groups (${op.from} → ${op.to}).`);
              edges = [...edges.filter((e) => !(e.from === op.from && e.to === op.to)), { from: op.from!, to: op.to!, label: op.label ?? "", kind: op.kind ?? "other" }];
            } else {
              edges = edges.filter((e) => !(e.from === op.from && e.to === op.to));
            }
          }
          const kept = groups.filter((g) => g.paths.length);
          const dropped = groups.filter((g) => !g.paths.length).map((g) => g.id);
          if (kept.length < 2) return fail("That would leave fewer than two groups with files; nothing changed.");
          const ids = new Set(kept.map((g) => g.id));
          edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
          if (lens.id === "modules") setModules(kept, edges);
          else putLens({ ...lens, ...(a.title ? { title: a.title } : {}), groups: kept, edges });
          return ok(
            [
              `Revised ${a.title ?? lens.title} in place: ${kept.map((g) => `${g.label} (${g.paths.length})`).join(", ")}.`,
              dropped.length ? `Dropped empty: ${dropped.join(", ")}.` : "",
              ...notes,
            ]
              .filter(Boolean)
              .join(" "),
          );
        },
      ),
      tool(
        "remove_lens",
        "Delete a grouping the reader no longer wants. If it's the one showing, the map goes back to folders. Only when they ask to remove it — never to replace it with a revised one (revise it instead).",
        { lensId: z.string() },
        async (a) => {
          if (lensById(a.lensId)?.derived) return fail("That grouping is built from the code and comes back with every scan; it can't be removed.");
          const lens = removeLens(a.lensId);
          if (!lens) return fail(`No grouping "${a.lensId}" to remove. ${lensList()}`);
          return ok(`Removed the grouping "${lens.title}".`);
        },
      ),
    );
  }

  if (mode === "ask") {
    const resolveRev = async (rev: string) => {
      if (rev === WORKTREE || rev === "HEAD") return rev === "HEAD" ? (await loadHistory(idx().graph.root)).head ?? rev : rev;
      const h = await loadHistory(idx().graph.root);
      return h.commits.find((c) => c.sha.startsWith(rev) || c.short === rev)?.sha ?? rev;
    };
    tools.push(
      tool(
        "history",
        "Recent git history: commits with the files they touched and lines in/out, optionally only those touching a path (a file, or a directory prefix ending in '/'), and for a single file the files it most often changes together with (coupling that imports don't show). Commit 'worktree' is uncommitted work.",
        {
          path: z.string().optional(),
          limit: z.number().int().min(1).max(80).default(25),
          sinceDays: z.number().min(0).optional(),
        },
        async (a) => {
          const h = await loadHistory(idx().graph.root);
          if (!h.available) return fail("This repository has no git history.");
          const target = a.path ? (a.path.endsWith("/") ? a.path : findPath(idx(), a.path) ?? a.path) : null;
          const touches = (c: (typeof h.commits)[number]) =>
            !target || c.files.some((f) => (target.endsWith("/") ? f.path.startsWith(target) : f.path === target));
          const since = a.sinceDays !== undefined ? Date.now() - a.sinceDays * 86_400_000 : 0;
          const list = h.commits.filter((c) => c.at >= since && touches(c)).slice(0, a.limit);
          const lines = list.map((c) => {
            const add = c.files.reduce((s, f) => s + f.add, 0);
            const del = c.files.reduce((s, f) => s + f.del, 0);
            const files = c.files.slice(0, 8).map((f) => `${f.status} ${f.path} +${f.add}/-${f.del}`).join("; ");
            return `${c.short} ${new Date(c.at).toISOString().slice(0, 10)} ${c.author}: ${c.subject} (+${add}/-${del}, ${c.files.length} files) — ${files}${c.files.length > 8 ? "; …" : ""}`;
          });
          let coupling = "";
          if (target && !target.endsWith("/")) {
            const together = new Map<string, number>();
            let mine = 0;
            for (const c of h.commits) {
              if (c.files.length > 40 || !c.files.some((f) => f.path === target)) continue;
              mine++;
              for (const f of c.files) if (f.path !== target) together.set(f.path, (together.get(f.path) ?? 0) + 1);
            }
            const top = [...together.entries()].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, 10);
            if (top.length) coupling = `\nChanges together with ${target} (of its ${mine} commits): ${top.map(([p, n]) => `${p} ×${n}`).join(", ")}`;
          }
          return ok((lines.join("\n") || "No commits match.") + coupling);
        },
      ),
      tool(
        "read_at",
        "Read a file as it is at a git revision — a commit sha or a branch — rather than as it's checked out. This is how you read a branch that isn't checked out. Lines are numbered.",
        {
          path: z.string(),
          rev: z.string().describe("A commit sha or branch name"),
          offset: z.number().int().min(1).optional().describe("First line (1-based)"),
          limit: z.number().int().min(1).max(2000).default(600),
        },
        async (a) => {
          // A revision, never an option: `git show --output=…` must stay out of reach.
          if (!/^[A-Za-z0-9][\w./@^~-]*$/.test(a.rev) || a.rev.includes("..")) return fail(`Bad revision "${a.rev}".`);
          const text = await fileAt(idx().graph.root, a.rev, a.path.replace(/^\.?\//, ""));
          if (text === null) return fail(`${a.path} doesn't exist at ${a.rev}.`);
          const lines = text.split("\n");
          const from = (a.offset ?? 1) - 1;
          const shown = lines.slice(from, from + a.limit).map((l, i) => `${from + i + 1}\t${l}`);
          const more = from + a.limit < lines.length ? `\n… ${lines.length - from - a.limit} more lines (offset ${from + a.limit + 1})` : "";
          return ok(shown.join("\n") + more);
        },
      ),
      tool(
        "show_diff",
        "Put a real diff of one file on screen, across a span of history: from just before `from` (the older commit) to `to` (the newer commit, or 'worktree' for uncommitted changes). For a single commit, pass the same sha as both. The text comes straight from git.",
        {
          path: z.string(),
          from: z.string().describe("Older commit sha (short is fine)"),
          to: z.string().describe("Newer commit sha, or 'worktree'"),
          title: z.string().optional(),
          note: z.string().optional().describe("One line on what to notice"),
        },
        async (a) => {
          // A path that appears in history is used exactly: it may have been
          // moved or deleted since, and a fuzzy match would find today's
          // namesake — a different file. Only unknown paths get the fuzzy lookup.
          const asked = a.path.replace(/^\.?\//, "");
          const h = await loadHistory(idx().graph.root);
          const inHistory = h.commits.some((c) => c.files.some((f) => f.path === asked));
          const path = inHistory || idx().byPath.has(asked) ? asked : findPath(idx(), asked) ?? asked;
          const [from, to] = await Promise.all([resolveRev(a.from), resolveRev(a.to)]);
          let diff: string;
          try {
            diff = await diffFile(idx().graph.root, path, from, to);
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
          if (!diff.trim()) return fail(`${path} didn't change in that range.`);
          const clipped = diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n… (diff truncated)` : diff;
          return show({
            kind: "diff",
            id: viewId("diff"),
            title: a.title,
            path,
            lang: idx().byPath.get(path)?.lang ?? "text",
            from,
            to,
            diff: clipped,
            note: a.note,
          });
        },
      ),
      tool(
        "set_time_range",
        "Light up a span of history on the reader's map: everything changed between `from` (older commit) and `to` (newer, or 'worktree') glows by how much it changed, and the rest fades. Use it whenever an answer is about what changed.",
        { from: z.string(), to: z.string(), label: z.string().describe("Short name, e.g. 'The auth rewrite'") },
        async (a) => {
          const [from, to] = await Promise.all([resolveRev(a.from), resolveRev(a.to)]);
          pushCommand({ cmd: "set_range", range: { from, to, label: a.label } });
          return ok("Range lit on the map.");
        },
      ),
      tool(
        "changed_only",
        "While a branch or a span of history is on the reader's map: `on` shows only the files it changed (everything else steps off the map); off brings the whole map back. Use it when they ask for just the changes, or for the whole map again.",
        { on: z.boolean() },
        async (a) => {
          pushCommand({ cmd: "changed_only", on: a.on });
          return ok(a.on ? "Only the changed files are on the map." : "The whole map is back.");
        },
      ),
    );
  }

  if (mode === "intro") {
    tools.push(
      tool(
        "set_overview",
        "Publish the map of meaning for this codebase. Call exactly once, after reading enough to be right.",
        {
          headline: z.string().describe("One line: what this codebase is"),
          summary: z.string().describe("3–5 sentences of markdown: what it does and how it hangs together"),
          stack: z.array(z.string()).describe("Main technologies, e.g. ['Next.js', 'Postgres']"),
          entryPoints: z.array(z.string()).describe("Files where execution starts"),
          modules: z
            .array(
              z.object({
                id: z.string(),
                label: z.string().describe("2–4 words"),
                summary: z.string().describe("One short sentence, under 20 words: what it does. Shown when its beacon is hovered"),
                paths: z.array(z.string()).describe("Files, or directory prefixes ending with '/'"),
              }),
            )
            .min(2)
            .max(10),
          edges: z.array(
            z.object({
              from: z.string(),
              to: z.string(),
              label: z.string(),
              kind: z.enum(["calls", "data", "event", "http", "config", "renders", "other"]),
            }),
          ),
          topics: z
            .array(
              z.object({
                id: z.string(),
                title: z.string(),
                hook: z.string().describe("Why it's worth a visit, one line"),
                paths: z.array(z.string()),
              }),
            )
            .min(3)
            .max(7),
        },
        async (a) => {
          const modules = a.modules
            .map((m) => ({ ...m, paths: expandPaths(m.paths) }))
            .filter((m) => m.paths.length);
          const ids = new Set(modules.map((m) => m.id));
          const overview: Overview = {
            headline: a.headline,
            summary: a.summary,
            stack: a.stack,
            entryPoints: a.entryPoints.map((p) => findPath(idx(), p)).filter((p): p is string => !!p),
            modules,
            edges: a.edges.filter((e): e is LogicalEdge => ids.has(e.from) && ids.has(e.to) && e.from !== e.to),
            topics: a.topics
              .map((t) => ({ ...t, paths: expandPaths(t.paths, 80) }))
              .filter((t) => t.paths.length),
          };
          setOverview(overview);
          const dropped = a.modules.length - modules.length;
          return ok(
            `Overview published: ${modules.length} modules, ${overview.edges.length} logical edges, ${overview.topics.length} topics.` +
              (dropped ? ` ${dropped} module(s) dropped because none of their paths exist.` : ""),
          );
        },
      ),
    );
  }

  if (mode === "ask" && actions && frameId) tools.push(...actionTools(AGENT_ACTIONS, frameId, actions));
  if (mode === "ask" && tune && frameId) tools.push(...actionTools(TUNE_ACTIONS, frameId, tune));

  const offered = mode === "place" ? tools.filter((t) => PLACE_TOOLS.includes(t.name)) : tools;
  return createSdkMcpServer({ name: "flight", version: "1.0.0", tools: offered, alwaysLoad: true });
}

/* ------------------------------ prompting ------------------------------ */

const SYSTEM = `You are the navigator in Constellate: a developer is flying through this codebase as a 3D map while you guide them, out loud. The repository is your working directory; everything is read-only.

How you work:
- Read with Read/Grep/Glob, and use the flight tools for the static graph (deps, outline) — they're instant.
- Put things on their screen with show_code, show_diagram, show_custom and show_text. Move their camera with focus (do this early, with the files your answer is about) and open_file.
- Be quick. The reader is waiting mid-flight. Read what you need to be right and no more; usually 1–3 views per answer.

Grounding: every box, arrow and claim must come from code you actually read. Code excerpts are cut from the real files by line range, so get line numbers from what Read showed you. Paths are repo-relative.

Static vs logical: static dependencies are the import graph. Logical dependencies are what happens at runtime — HTTP calls between services, events, queues, shared tables, rendering, config switches. When you draw one, say which it is via the diagram's layer.

Shaping the map: when a question is about part of the codebase, filter_map can hide the rest so the reader only flies through what matters. When they want the code organized differently from folders — layers, features, services, data flow — publish a grouping with set_lens; the map regroups itself.

Changing a grouping they already have is not a new grouping. If they're in a grouping (or in Modules) and ask for something that reads as a change to it — split this group, merge those, move these files over, rename it, add a group for X, take Y out — revise it in place with revise_lens (get_lens first, to see what it holds). The screen note says which grouping is showing and its id; "this module", "that group" and the like mean that grouping. Only publish a new grouping with set_lens when they ask for a different way of organizing the code altogether. When it's unclear, prefer the in-place edit: a duplicate grouping with one change is clutter they have to clean up. remove_lens is for when they ask to delete one. To point out a set of files without disturbing the layout — or when they ask to mark something, or to group it but not to reorganize — use add_markers, which draws beacons on top of whatever organization they're in. Both are cheap; use them when they help. Markers stay until removed: when they ask to hide, clear or delete markers — one, the ones from an answer, or all of them — use edit_markers; "this answer" is the one they have open (the screen note says which).

History: you can read git history (history), show real diffs (show_diff), and light a span of history on the map (set_time_range). For questions about what changed, when, why, or what tends to change together, ground the answer in commits and diffs rather than the current code alone.

Pick the picture that explains best. A request flowing through layers might be a sequence (show_custom). A lifecycle is a state machine. A config surface is a table. A hot path is a code excerpt with highlighted lines. Use show_custom freely — make it look good: clean, legible, a bit of motion where motion carries meaning, and data-path on anything that stands for code.

Your final reply is spoken aloud by a voice and shown as a caption: 2–4 short conversational sentences that tell them what they're now looking at and the one thing to notice. No markdown, no lists, no code, no file paths read out character by character. Never introduce yourself.

Write everything — answers, view titles, notes, diagram labels, visualizations — in English, unless the reader explicitly asks for another language.`;

/** A re-chart: the map as it was charted, and the commit it was charted at. */
export type Rechart = { previous: Overview; since?: string };

/** Module paths, folded into folders so a big module stays a few lines. */
function foldPaths(paths: string[]): string {
  const byDir = new Map<string, number>();
  for (const p of paths) {
    const d = path.posix.dirname(p);
    byDir.set(d, (byDir.get(d) ?? 0) + 1);
  }
  const dirs = [...byDir].sort((a, b) => b[1] - a[1]);
  const shown = dirs.slice(0, 14).map(([d, n]) => `${d}/ (${n})`);
  return shown.join(", ") + (dirs.length > 14 ? `, +${dirs.length - 14} more folders` : "");
}

async function rechartNote(r: Rechart): Promise<string[]> {
  const g = idx().graph;
  const prev = r.previous;
  const onMap = new Set(g.files.map((f) => f.path));
  const placed = new Set(prev.modules.flatMap((m) => m.paths));
  const unplaced = g.files.filter((f) => !placed.has(f.path) && !f.path.endsWith("_test.go")).map((f) => f.path);
  const gone = [...placed].filter((p) => !onMap.has(p));
  let changes = "";
  if (r.since) {
    try {
      const { stdout } = await promisify(execFile)("git", ["diff", "--stat=160", "--no-renames", r.since], { cwd: g.root, maxBuffer: 8 * 1024 * 1024 });
      const lines = stdout.trim().split("\n");
      changes = lines.length > 120 ? [...lines.slice(0, 110), `… ${lines.length - 111} more files`, lines.at(-1)].join("\n") : stdout.trim();
    } catch {
      /* the charted commit is gone (rebased away): the scan is all there is */
    }
  }
  return [
    "",
    "THIS IS A RE-CHART. The reader already knows this map: they've been navigating it, and they keep its modules in their head. The code has changed since it was charted. Your job is to bring the existing chart up to date, not to draw a new one.",
    "",
    "The current chart:",
    `Headline: ${prev.headline}`,
    "Modules (id — label: summary · where its files are):",
    ...prev.modules.map((m) => `- ${m.id} — ${m.label}: ${m.summary} · ${foldPaths(m.paths)}`),
    "Runtime edges:",
    ...prev.edges.map((e) => `- ${e.from} → ${e.to}: ${e.label}`),
    "Topics:",
    ...prev.topics.map((t) => `- ${t.id} — ${t.title}`),
    "",
    changes ? `What changed since it was charted (git diff --stat ${r.since!.slice(0, 10)}, including uncommitted work):\n${changes}` : "There's no record of the commit it was charted at; compare the chart with the scan above.",
    unplaced.length ? `Files on the map now that no module holds (${unplaced.length}): ${foldPaths(unplaced)}` : "",
    gone.length ? `Files the chart holds that no longer exist (${gone.length}): ${foldPaths(gone)}` : "",
    "",
    "How to re-chart:",
    "- Keep the modules: same ids, same labels, same rough boundaries, so everything the reader knows still holds. Put new files into the module they belong to; drop deleted ones; adjust summaries and edges where the changes made them wrong.",
    "- Change the organization only where the changes call for it: a big new subsystem that deserves its own module, a module that was removed or absorbed, or a refactor that really moved responsibilities between modules. A handful of new files, renames or growth inside a module are not reasons. This is a judgement, not a rule — but when in doubt, keep what's there.",
    "- If you do add, merge, split or retire a module, say so in the welcome (\"The approvals code now has its own module…\"), so the reader knows what moved.",
    "- Keep the topics that still make sense; replace only those the changes made stale, and consider one about what changed if it's significant.",
    "- Read only what you need to understand the changes — you don't need to re-read the whole codebase.",
  ].filter((x) => x !== "");
}

async function introPrompt(rechart?: Rechart): Promise<string> {
  const g = idx().graph;
  const extras: string[] = [];
  for (const name of ["README.md", "readme.md", "README", "CLAUDE.md", "AGENTS.md"]) {
    try {
      const t = await readFile(path.join(g.root, name), "utf8");
      extras.push(`--- ${name} (first 4000 chars) ---\n${t.slice(0, 4000)}`);
    } catch {
      /* not there */
    }
  }
  for (const manifest of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile"]) {
    try {
      const t = await readFile(path.join(g.root, manifest), "utf8");
      extras.push(`--- ${manifest} ---\n${t.slice(0, 2500)}`);
    } catch {
      /* not there */
    }
  }

  return [
    "The reader just opened this repository. The 3D map of its files and imports is already on their screen. Your job right now is the intro: give the map its meaning.",
    "",
    "Here is the static scan:",
    digest(idx()),
    "",
    ...extras,
    "",
    ...(rechart ? await rechartNote(rechart) : []),
    "",
    "Do this:",
    rechart
      ? "1. Read what you need to understand the changes — usually a few files; use outline/deps for the rest. Do not use show_* tools in the intro."
      : "1. Read the handful of files that tell you how it hangs together — entry points, the biggest hubs, anything the README points at. Around 6–10 reads; use outline/deps for the rest. Do not use show_* tools in the intro.",
    "2. Call set_overview exactly once" + (rechart ? " with the updated chart (the whole of it, kept modules included)" : "") + ": 4–9 logical modules covering the important code (what you'd draw on a whiteboard, not the folder list), the logical edges between them (how they talk at runtime), and 4–6 topics worth a deep visit with a hook that makes each one sound interesting.",
    rechart
      ? "3. Reply with a spoken welcome of two or three short sentences: what changed in the code and, if anything, in the chart. No greeting, no 'welcome'."
      : "3. Reply with a spoken welcome of two or three short sentences: what this codebase is and the shape of it. No greeting, no 'welcome'.",
  ].join("\n");
}

/** The reader's own notes on a file and its import lines — what they've learned or want to remember. */
function notesOn(path?: string): string {
  if (!path) return "";
  const mine = session.state.notes.filter((n) => (n.target.kind === "file" ? n.target.path === path : n.target.from === path || n.target.to === path));
  if (!mine.length) return "";
  return `Their notes on it:\n${mine
    .map((n) => `- ${n.target.kind === "file" ? "on the file" : `on the import ${n.target.from} → ${n.target.to}`}: ${n.text.slice(0, 600)}`)
    .join("\n")}`;
}

/** A visual on a story's stage, in a line. */
function describeVisual(v: View): string {
  if (v.kind === "code") {
    const end = v.startLine + v.code.split("\n").length - 1;
    return `code from ${v.path}:${v.startLine}-${end}${v.title ? ` (${v.title})` : ""}${v.highlight.length ? `, lines ${v.highlight.join(", ")} spotlit` : ""}`;
  }
  if (v.kind === "diff") return `the diff of ${v.path}`;
  if (v.kind === "text") return `a note${v.title ? `, "${v.title}"` : ""}`;
  return `${v.kind === "diagram" ? "a diagram" : "a visualization"}, "${v.title}"`;
}

/**
 * The story they're watching, or watched last: its whole script with where
 * they are, what's on its stage there, and the code it covers — so "this",
 * "that part" and "what you just said" have something to point at.
 */
export function storyNote(at?: ScreenContext["story"]): string {
  const st = at && session.state.stories.find((x) => x.id === at.id);
  if (!at || !st?.beats.length) return "";
  const n = Math.max(0, Math.min(at.beat, st.beats.length - 1));
  const of = `beat ${n + 1} of ${st.beats.length}`;
  const where = at.closed
    ? `Earlier they watched your story "${st.title}" (they closed it at ${of}). Questions about "the story" or something it said mean this one.`
    : at.parked
      ? `They paused your story "${st.title}" at ${of} to ask this — it's a question about what the story is saying there. "This", "that" and "what you just said" mean that beat and what's on its stage. Answer it; the story resumes after.`
      : `They're watching your story "${st.title}" right now, at ${of}${at.playing ? "" : " (paused)"}. "This", "that" and "what you just said" mean that beat and what's on its stage.`;
  // What the stage and the camera were showing by that beat: the latest cue of each kind.
  let visual: View | undefined;
  let lines: number[] = [];
  let focus: string[] = [];
  for (const b of st.beats.slice(0, n + 1)) {
    for (const c of b.cues) {
      if (c.kind === "show") (visual = st.visuals.find((v) => v.id === c.visual)), (lines = []);
      else if (c.kind === "lines") lines = c.lines;
      else if (c.kind === "focus") focus = c.paths;
    }
  }
  return [
    where,
    `What it explains: ${st.summary}`,
    "The script (each beat is what the voice said):",
    ...st.beats.map((b, i) => `${i + 1}. ${b.say}${i === n ? "   ← they are here" : ""}`),
    visual ? `On the stage at that beat: ${describeVisual(visual)}${lines.length ? `, spotlighting lines ${lines.join(", ")}` : ""}.` : "",
    focus.length ? `The map's camera was on: ${focus.slice(0, 12).join(", ")}${focus.length > 12 ? "…" : ""}.` : "",
    st.context.length ? `The code the story covers: ${st.context.map((c) => `${c.path}${c.line ? `:${c.line}${c.endLine ? `-${c.endLine}` : ""}` : ""} (${c.why})`).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The markers on the map, with ids and the answer that made each, for edit_markers. */
function markersNote(): string {
  const ms = session.state.overlays;
  if (!ms.length) return "";
  const from = (id?: string) => {
    const f = id ? getFrame(id) : undefined;
    return f ? `from answer [${f.id}] "${f.title}"` : "marked by them";
  };
  return `Markers on the map: ${ms.map((o) => `[${o.id}] ${o.label} (${o.paths.length} files, ${from(o.frameId)}${o.visible ? "" : ", hidden"})`).join("; ")}.`;
}

/**
 * The branch on the reader's map, in full: its commits and the files it
 * changes, and how to read it when it isn't checked out. Also lets groupings
 * take the files only the branch has, for as long as this request runs.
 */
async function branchNote(b?: ScreenContext["branch"]): Promise<string> {
  branchOnly = [];
  if (!b) return "";
  try {
    const d = b.agent ? await agentDiff(b.agent) : await branchDiff(idx().graph.root, b.name, b.base);
    branchOnly = d.files.filter((f) => f.status !== "D" && !idx().byPath.has(f.path)).map((f) => f.path);
    const tip = d.head.slice(0, 10);
    const MAX_FILES = 250;
    return [
      "",
      "",
      "[The branch on their map]",
      d.agent
        ? `They're looking at what the coding agent "${d.agent.title}" changed: its branch ${d.branch}, compared with the commit it started from (${d.mergeBase.slice(0, 10)}), tip ${tip}${d.agent.live ? ", which includes edits it hasn't committed yet" : ""}. The map shows the code as the agent has it, with what it changed lit.`
        : `They're looking at the branch ${d.branch} compared with ${d.base}, since they forked (merge base ${d.mergeBase.slice(0, 10)}, tip ${tip}). The map shows the code as it is at the branch tip, with what it changed lit.`,
      b.changedOnly
        ? "Only the files it changed are on the map right now; changed_only with on: false brings the whole map back."
        : "changed_only shows just the files it changed, when they want only the changes.",
      d.checkedOut
        ? "It's checked out, so Read, Grep, outline and deps see the branch."
        : `It isn't checked out: Read, Grep, outline and deps see ${session.state.repo?.branch ?? "the checked-out branch"}, not this branch. Read the branch's version of a file with read_at (rev ${tip}); its diffs with show_diff.`,
      `Commits (${d.commits.length}, newest first):`,
      ...d.commits.slice(0, 40).map((c) => `- ${c.sha.slice(0, 10)} ${c.author}: ${c.subject}`),
      d.commits.length > 40 ? `- … ${d.commits.length - 40} more` : "",
      `Files it changes (${d.files.length}; A added, M modified, D deleted):`,
      ...d.files.slice(0, MAX_FILES).map((f) => `- ${f.status} ${f.path} +${f.add}/-${f.del}`),
      d.files.length > MAX_FILES ? `- … ${d.files.length - MAX_FILES} more` : "",
      branchOnly.length
        ? `${branchOnly.length} of these exist only on the branch. Groupings, markers and focus take them like any other file; they show whenever this branch is on the map.`
        : "",
      "Asked to reorganize, create or revise a grouping as usual: the branch's map is drawn with whichever grouping is selected.",
    ]
      .filter((l, i) => l || i < 2)
      .join("\n");
  } catch (err) {
    return `\n\n[The branch on their map]\n${b.name}: couldn't read it (${err instanceof Error ? err.message : String(err)}).`;
  }
}

function screenNote(screen?: ScreenContext): string {
  if (!screen) return "";
  const bits = [
    screen.openFile ? `They have ${screen.openFile.path}${screen.openFile.line ? ` open at line ${screen.openFile.line}` : ""} in the code panel.` : "",
    notesOn(screen.openFile?.path),
    screen.focusLabel ? `The camera is on: ${screen.focusLabel}.` : "",
    screen.lens ? `The map is organized by ${screen.lens}${screen.lensId && screen.lensId !== "folders" ? ` (grouping id: ${screen.lensId})` : ""}.` : "",
    screen.range ? `The map is showing history: ${screen.range}.` : "",
    screen.filter ? `The map is filtered to ${screen.filter}${screen.visibleFiles !== undefined ? ` (${screen.visibleFiles} files)` : ""}.` : "",
    screen.frameId && getFrame(screen.frameId) ? `They have your answer [${screen.frameId}] "${getFrame(screen.frameId)!.title}" open — "this answer" means it.` : "",
    markersNote(),
    storyNote(screen.story),
    screen.selection ? `They have selected this text — "this"/"that" means it:\n"""\n${screen.selection.slice(0, 2000)}\n"""` : "",
  ].filter(Boolean);
  return bits.length ? `\n\n[What's on their screen]\n${bits.join("\n")}` : "";
}

/**
 * For a typed request: Ask hands changes to coding agents, as the voice does.
 * The routing is the voice's — questions answered here, changes to an agent,
 * a merge only on their say-so — and so are the tools.
 */
function agentsNote(): string {
  const lines = agentLines();
  return [
    "",
    "",
    "[Coding agents]",
    "This was typed into Ask, which also hands work to coding agents, the way the voice does. A question about the code is yours to answer as always: read, show, explain.",
    "But when they ask for the code to be written, fixed or changed, don't explain how you'd do it and don't read around first — the agent reads for itself. Call start_agent with the task in their words (plus anything from this conversation it needs), then say in a sentence that it's on it.",
    "A correction or follow-up for an agent goes to message_agent. open_pr when they ask to open a PR, land, ship or submit one; show_agent to see what one changed; stop_agent and discard_agent only when they ask.",
    "merge_pr when they ask to merge: from here it never merges, it puts a Merge button on this answer for them to press, because merging to main deploys. Say what would be merged and that they can confirm it there.",
    "When it's unclear whether they want an answer or a change, answer, and offer to start an agent.",
    lines.length ? `Agents (for message_agent, stop_agent, show_agent, open_pr, merge_pr, discard_agent):\n${lines.join("\n")}` : "No agents yet.",
  ].join("\n");
}

/* ------------------------------- running ------------------------------- */

/** Turns the agent's tool calls into activity, so a wait reads as work — and lights up the files being read. */
function narrate(msg: SDKMessage, root: string) {
  if (msg.type !== "assistant" || msg.parent_tool_use_id) return;
  for (const block of msg.message.content) {
    if (block.type !== "tool_use") continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const rel = (p: unknown) =>
      typeof p === "string" ? path.relative(root, path.resolve(root, p)) : undefined;
    const name = block.name.replace(/^mcp__flight__/, "");
    switch (name) {
      case "Read": {
        const p = rel(input.file_path);
        pushActivity({ kind: "read", detail: `Reading ${p}`, path: p });
        break;
      }
      case "Grep":
        pushActivity({ kind: "search", detail: `Searching for ${String(input.pattern ?? "").slice(0, 60)}` });
        break;
      case "Glob":
        pushActivity({ kind: "search", detail: `Looking for ${String(input.pattern ?? "")}` });
        break;
      case "deps":
      case "outline": {
        const p = typeof input.path === "string" ? findPath(idx(), input.path) ?? undefined : undefined;
        pushActivity({ kind: "read", detail: `${name === "deps" ? "Tracing dependencies of" : "Outlining"} ${p ?? input.path}`, path: p });
        break;
      }
      case "show_code":
        pushActivity({ kind: "tool", detail: `Cutting an excerpt from ${String(input.path)}` });
        break;
      case "show_diagram":
        pushActivity({ kind: "tool", detail: `Drawing ${String(input.title ?? "a diagram")}` });
        break;
      case "show_custom":
        pushActivity({ kind: "tool", detail: `Building ${String(input.title ?? "a visualization")}` });
        break;
      case "set_overview":
        pushActivity({ kind: "tool", detail: "Charting the map" });
        break;
      case "filter_map":
        pushActivity({ kind: "tool", detail: `Filtering the map: ${String(input.label ?? "")}` });
        break;
      case "read_at":
        pushActivity({ kind: "read", detail: `Reading ${String(input.path)} at ${String(input.rev).slice(0, 12)}`, path: typeof input.path === "string" ? input.path : undefined });
        break;
      case "history":
        pushActivity({ kind: "search", detail: `Reading history${input.path ? ` of ${String(input.path)}` : ""}` });
        break;
      case "show_diff":
        pushActivity({ kind: "tool", detail: `Cutting the diff of ${String(input.path)}` });
        break;
      case "add_markers":
        pushActivity({ kind: "tool", detail: "Marking the map" });
        break;
      case "edit_markers":
        pushActivity({ kind: "tool", detail: `${{ hide: "Hiding", show: "Showing", delete: "Deleting" }[String(input.action)] ?? "Changing"} markers` });
        break;
      case "set_lens":
        pushActivity({ kind: "tool", detail: `Regrouping the map ${String(input.title ?? "")}`.trim() });
        break;
      case "revise_lens":
        pushActivity({ kind: "tool", detail: "Revising the grouping" });
        break;
      case "remove_lens":
        pushActivity({ kind: "tool", detail: "Removing a grouping" });
        break;
      case "focus":
        pushActivity({ kind: "tool", detail: `Steering to ${String(input.label ?? "the files")}` });
        break;
      case "start_agent":
        pushActivity({ kind: "tool", detail: `Starting a coding agent${input.title ? `: ${String(input.title)}` : ""}` });
        break;
      case "message_agent":
        pushActivity({ kind: "tool", detail: "Telling the agent more" });
        break;
      case "open_pr":
        pushActivity({ kind: "tool", detail: "Opening a pull request" });
        break;
      case "merge_pr":
        pushActivity({ kind: "tool", detail: "Asking you to confirm the merge" });
        break;
    }
  }
}

type RunResult = { answer: string; error?: string };

async function run(opts: {
  prompt: string;
  frameId: string | null;
  mode: "intro" | "ask" | "place";
  effort: Effort;
  signal: AbortController;
  /** A typed request: the agent tools too, with what's on their screen. */
  actions?: ScreenContext;
  /** A typed request: the Tune panel's knobs and presets too, with what's on their screen. */
  tune?: ScreenContext;
}): Promise<RunResult> {
  const root = idx().graph.root;
  const tools = [
    ...(opts.mode === "place" ? PLACE_TOOLS : FLIGHT_TOOLS.filter((t) => opts.mode === "intro" || t !== "set_overview")),
    ...(opts.mode === "ask" && opts.actions ? AGENT_ACTIONS.map((a) => a.name) : []),
    ...(opts.mode === "ask" && opts.tune ? TUNE_ACTIONS.map((a) => a.name) : []),
  ];
  let live = "";
  let answer = "";

  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: root,
      model: MODEL,
      effort: opts.effort,
      systemPrompt: SYSTEM,
      tools: BUILTIN,
      allowedTools: [...BUILTIN, ...tools.map(mcpName)],
      // Anything not on the allow-list is refused rather than asked about —
      // there is no one at a terminal to ask.
      permissionMode: "dontAsk",
      // The opened repo's own .claude settings could carry hooks; this is a
      // read-only explorer and must not run them.
      settingSources: [],
      mcpServers: { flight: flightServer(opts.frameId, opts.mode, opts.actions, opts.tune) },
      // A placement is housekeeping on the side: it doesn't join the conversation.
      resume: opts.mode === "place" ? undefined : session.agentSessionId,
      includePartialMessages: true,
      maxTurns: opts.mode === "intro" ? 30 : opts.mode === "place" ? 25 : 40,
      abortController: opts.signal,
      stderr: process.env.CODEFLIGHT_DEBUG ? (d) => console.error("[navigator]", d) : undefined,
    },
  });

  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      if (opts.mode !== "place") session.agentSessionId = msg.session_id;
    } else if (msg.type === "stream_event" && !msg.parent_tool_use_id && opts.frameId) {
      const ev = msg.event;
      // Each new assistant message replaces the caption: text between tool
      // calls is narration of progress, and only the last message is the answer.
      if (ev.type === "message_start") live = "";
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        live += ev.delta.text;
        patchFrame(opts.frameId, { answer: live });
      }
    } else if (msg.type === "assistant") {
      narrate(msg, root);
    } else if (msg.type === "result") {
      if (msg.subtype === "success") answer = msg.result;
      else return { answer: live, error: msg.subtype.replace(/_/g, " ") };
    }
  }
  return { answer: answer || live };
}

/* ------------------------------ public api ------------------------------ */

let intro: Promise<void> | null = null;
let current: { controller: AbortController; frameId: string } | null = null;

let introCtl: AbortController | null = null;

export function runIntro(rechart?: Rechart): Promise<void> {
  intro = (async () => {
    session.state.busy = true;
    emit();
    const controller = new AbortController();
    introCtl = controller;
    try {
      const res = await run({ prompt: await introPrompt(rechart), frameId: null, mode: "intro", effort: INTRO_EFFORT, signal: controller });
      // Stopped for another repo: what it would write belongs to the one it left.
      if (controller.signal.aborted) return;
      if (!session.state.overview) {
        throw new Error(res.error ?? "The navigator finished without charting the map.");
      }
      // The spoken welcome is kept with the overview so a reopened session can
      // play it again without another run.
      session.state.overview = { ...session.state.overview, welcome: res.answer };
      markCharted();
      session.state.status = "ready";
    } catch (err) {
      if (controller.signal.aborted) return;
      session.state.status = "error";
      session.state.error = err instanceof Error ? err.message : String(err);
      pushActivity({ kind: "error", detail: session.state.error });
    } finally {
      if (introCtl === controller) introCtl = null;
      if (!controller.signal.aborted) {
        session.state.busy = false;
        emit();
      }
    }
  })();
  return intro;
}

/* ------------------------------ new files ------------------------------ */

/**
 * New files land in "Other" in every grouping until something puts them
 * somewhere. After a rescan finds some, and once things settle, the navigator
 * places them: into the module or group they belong to, or a new one when
 * they form something the grouping doesn't have yet. A file is offered once;
 * one it leaves out stays out.
 */
const PLACE_AFTER_MS = Number(process.env.CODEFLIGHT_PLACE_SECONDS ?? 20) * 1000;
const PLACE_EFFORT = (process.env.CODEFLIGHT_PLACE_EFFORT ?? "low") as Effort;
/** More than this is a re-chart's job, not a placement's. */
const PLACE_MAX = 300;
const pending = new Set<string>();
let placeTimer: ReturnType<typeof setTimeout> | undefined;
let placing: Promise<void> | null = null;
let placeCtl: AbortController | null = null;

afterRescan.push((added) => {
  if (PLACE_AFTER_MS <= 0) return;
  for (const p of added) pending.add(p);
  if (!pending.size) return;
  clearTimeout(placeTimer);
  placeTimer = setTimeout(() => void placeNewFiles(), PLACE_AFTER_MS);
});

async function placeNewFiles(): Promise<void> {
  if (placing) {
    // One at a time: these wait for the next.
    placeTimer = setTimeout(() => void placeNewFiles(), PLACE_AFTER_MS);
    return;
  }
  // Mid-chart there's nothing to place them in yet, and the chart takes in every file.
  const o = session.state.overview;
  if (!session.idx || !o || session.state.status !== "ready") return;
  const onMap = new Set(session.idx.graph.files.map((f) => f.path));
  const files = [...pending].filter((p) => onMap.has(p));
  pending.clear();
  const groupings = [
    { id: "modules", title: "Modules", groups: o.modules },
    ...session.state.lenses.map((l) => ({ id: l.id, title: l.title, groups: l.groups })),
  ]
    .map((g) => {
      const held = new Set(g.groups.flatMap((x) => x.paths));
      return { ...g, loose: files.filter((p) => !held.has(p)) };
    })
    .filter((g) => g.loose.length);
  if (!groupings.length) return;
  if (files.length > PLACE_MAX) {
    pushActivity({ kind: "tool", detail: `${files.length} new files — re-chart the overview to place them` });
    return;
  }

  const prompt = [
    "New files have appeared in the repository since the reader's map was organized, and the groupings below don't hold them yet, so they sit in \"Other\". Place them.",
    "",
    "For each grouping: put each new file into the group it belongs to (revise_lens: move, or upsert_group with paths). When several new files together form something the groups don't cover — a new subsystem, a new feature area — add a group for them (upsert_group with a new id, a short label and a summary of under 20 words). Leave everything that's already placed where it is; don't rename, merge or retire groups. A file that fits nowhere (a stray script, a fixture) can stay out.",
    "Decide from paths, outline and deps first; read a file only when they don't settle it. Groupings are independent: place the files in each one by its own logic.",
    "",
    ...groupings.flatMap((g) => [
      `Grouping ${g.id} — ${g.title}:`,
      ...g.groups.map((x) => `- ${x.id} — ${x.label}: ${x.summary} · ${foldPaths(x.paths)}`),
      `New files it doesn't hold (${g.loose.length}): ${g.loose.join(", ")}`,
      "",
    ]),
    "End with one short sentence on what you placed and any group you added.",
  ].join("\n");

  const controller = new AbortController();
  placeCtl = controller;
  placing = (async () => {
    const n = new Set(groupings.flatMap((g) => g.loose)).size;
    pushActivity({ kind: "tool", detail: `Placing ${n} new file${n === 1 ? "" : "s"} on the map` });
    try {
      const res = await run({ prompt, frameId: null, mode: "place", effort: PLACE_EFFORT, signal: controller });
      if (controller.signal.aborted) return;
      pushActivity(res.error ? { kind: "error", detail: `Placing new files: ${res.error}` } : { kind: "tool", detail: res.answer.trim().slice(0, 200) || "Placed the new files" });
    } catch (err) {
      if (controller.signal.aborted) return;
      pushActivity({ kind: "error", detail: `Placing new files: ${err instanceof Error ? err.message : String(err)}` });
    }
  })().finally(() => {
    placing = null;
    if (placeCtl === controller) placeCtl = null;
  });
  return placing;
}

/**
 * Answers a request by building a new frame. A new request supersedes one in
 * flight — on a voice call, asking for something else means "stop, do this".
 * A typed request (`typed`) may also start, message, land or ask to merge a
 * coding agent; the voice has those tools itself, so its requests don't.
 */
export async function ask(
  request: string,
  opts: { topicId?: string; screen?: ScreenContext; title?: string; typed?: boolean } = {},
): Promise<{ frameId: string; answer: string; error?: string }> {
  if (intro) await intro.catch(() => {});
  if (current) {
    current.controller.abort();
    patchFrame(current.frameId, { state: "done" });
  }

  const topic = opts.topicId ? session.state.overview?.topics.find((t) => t.id === opts.topicId) : undefined;
  const frame = newFrame(opts.title ?? topic?.title ?? request.slice(0, 80), request, topic?.id);
  const controller = new AbortController();
  current = { controller, frameId: frame.id };
  session.state.busy = true;
  emit();

  const prompt = topic
    ? [
        `Take the reader on a deep dive into "${topic.title}" — ${topic.hook}`,
        `Relevant files: ${topic.paths.slice(0, 40).join(", ")}`,
        "Focus the camera on it first. Then build the dossier: the picture that best explains how it works (a diagram or a custom visualization), and the one or two code excerpts that are the heart of it.",
        request && request !== topic.title ? `They asked: ${request}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : request;

  // A topic's deep dive is a tour, not a request that could be a task.
  const actions = opts.typed && AGENTS_ON && !topic;
  const typed = !!opts.typed && !topic;

  try {
    const res = await run({
      prompt: prompt + screenNote(opts.screen) + (await branchNote(opts.screen?.branch)) + (actions ? agentsNote() : "") + (typed ? `\n\n${tuneNote({ screen: opts.screen ?? {} })}\nIf they ask to change a setting (how the map looks or moves, the headset's settings) or to use, save or delete a preset, do it with tune, reset_tune and the preset tools.` : ""),
      frameId: frame.id,
      mode: "ask",
      effort: ASK_EFFORT,
      signal: controller,
      actions: actions ? opts.screen ?? {} : undefined,
      tune: typed ? opts.screen ?? {} : undefined,
    });
    if (controller.signal.aborted) return { frameId: frame.id, answer: res.answer, error: "superseded" };
    patchFrame(frame.id, {
      state: res.error ? "error" : "done",
      answer: res.answer,
      error: res.error,
    });
    return { frameId: frame.id, ...res };
  } catch (err) {
    const message = controller.signal.aborted ? "superseded" : err instanceof Error ? err.message : String(err);
    if (!controller.signal.aborted) {
      patchFrame(frame.id, { state: "error", error: message });
      pushActivity({ kind: "error", detail: message });
    }
    return { frameId: frame.id, answer: getFrame(frame.id)?.answer ?? "", error: message };
  } finally {
    if (current?.frameId === frame.id) {
      branchOnly = [];
      current = null;
      session.state.busy = false;
      emit();
    }
  }
}

/** Stop everything the navigator is doing, without a trace: another repo is about to open. */
export function stopNavigator() {
  introCtl?.abort();
  introCtl = null;
  intro = null;
  current?.controller.abort();
  current = null;
  placeCtl?.abort();
  branchOnly = [];
  clearTimeout(placeTimer);
  pending.clear();
  session.state.busy = false;
}

export function interrupt() {
  if (!current) return false;
  current.controller.abort();
  patchFrame(current.frameId, { state: "done" });
  current = null;
  session.state.busy = false;
  emit();
  return true;
}
