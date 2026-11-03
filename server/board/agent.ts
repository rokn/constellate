import { createSdkMcpServer, query, tool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  ARCH_KINDS,
  COLORS,
  ITEM_KINDS,
  LINK_STYLES,
  PROTOCOLS,
  SHAPES,
  STATUSES,
  defaultsFor,
  describeBoard,
  nameOf,
  newId,
  type Board,
  type BoardScreen,
  type Item,
  type ItemKind,
  type ItemStatus,
  type Link,
  type Op,
  type Part,
  type Vec3,
} from "../../shared/board";
import { ARRANGEMENTS, arrange } from "../../shared/boardLayout";

import { awaitBuild } from "./holo";
import { agentSessionOf, boardInside, change, command, getBoard, saveVersion, setActivity, setAgentSession } from "./store";
import { LIBRARY, findPrefab } from "../../shared/holoLibrary";
import { TEMPLATE_NAMES, layTemplate } from "../../shared/templates";
import { TUNE_TOOLS, runBoardTune } from "./tune";
import { repoBrief } from "./repo";
import { grepCode, listFiles, readCode } from "./code";
import path from "node:path";
import { CACHE_DIR, session } from "../session";
import { getProject } from "../projects";
import { BOARD_ACTIONS } from "../../shared/boardActions";

/**
 * The workshop's assistant: Claude, via the Agent SDK, with nothing but
 * board tools. It reads no files and runs nothing; it builds on the board.
 * The voice hands it everything that needs design (an architecture, a plan,
 * a hologram); simple moves the voice does itself.
 */

const MODEL = process.env.BOARD_MODEL ?? process.env.CODEFLIGHT_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.BOARD_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";
export const ASSISTANT = process.env.BOARD_ASSISTANT_NAME ?? "Jarvis";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const kind = z.enum(ITEM_KINDS as [ItemKind, ...ItemKind[]]);

const partSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    shape: z.enum(SHAPES),
    name: z.string().optional(),
    size: vec3.optional(),
    radius: z.number().optional(),
    tube: z.number().optional(),
    height: z.number().optional(),
    radiusTop: z.number().optional(),
    teeth: z.number().int().optional(),
    points: z.array(z.array(z.number())).optional(),
    depth: z.number().optional(),
    text: z.string().optional(),
    pos: vec3.optional(),
    rot: vec3.optional(),
    scale: z.union([vec3, z.number()]).optional(),
    color: z.string().optional(),
    opacity: z.number().optional(),
    wire: z.boolean().optional(),
    explode: vec3.optional(),
    anim: z.object({ spin: vec3.optional(), bob: z.number().optional(), pulse: z.number().optional() }).optional(),
    repeat: z.object({ count: z.number().int(), offset: vec3.optional(), rotate: vec3.optional(), radial: z.number().optional() }).optional(),
    children: z.array(partSchema).optional(),
  }),
) as z.ZodType<Part>;

const itemFields = {
  label: z.string().optional(),
  body: z.string().optional().describe("Notes and text: the words on it."),
  pos: vec3.optional().describe("[x, y, z] metres; omit to have it placed in a free spot near where they're looking."),
  rotY: z.number().optional(),
  scale: z.number().optional(),
  color: z.string().optional().describe(`A palette name (${Object.keys(COLORS).join(", ")}) or #rrggbb.`),
  status: z.enum(STATUSES as [ItemStatus, ...ItemStatus[]]).optional(),
  tags: z.array(z.string()).optional(),
  size: z.tuple([z.number(), z.number()]).optional().describe("frame: [width, depth] on the table; note: [width, height]."),
  spin: z.boolean().optional(),
  explode: z.number().optional(),
  attach: z.string().optional().describe("Pin it to another item (id, ref or label): it moves with it. For notes about a component."),
  metrics: z
    .array(z.object({ label: z.string(), value: z.number(), unit: z.string().optional(), max: z.number().optional() }))
    .optional()
    .describe("Numbers shown as gauges beside it: RPS, p99 latency, monthly cost, uptime… max sets a full gauge."),
  code: z
    .object({ module: z.string().optional(), paths: z.array(z.string()).max(12).optional() })
    .optional()
    .describe("Where it is in the board's repo: the code map's module id (from the repo brief's Modules list) and its main folders or files, repo-relative. Set it on every block drawn from code: it links the block to the code map."),
};

const linkFields = {
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  style: z.enum(LINK_STYLES as [string, ...string[]]).optional(),
  both: z.boolean().optional(),
  color: z.string().optional(),
  protocol: z.enum(PROTOCOLS as unknown as [string, ...string[]]).optional().describe("How it talks; each moves differently on the board. Guessed from the label when omitted."),
  sample: z.string().optional().describe("A short sample of what flows (a JSON body, an event, a query): it rides along the link now and then."),
};

const SYSTEM = `You are ${ASSISTANT}, the assistant in a holographic workshop — a 3D planning board that stands on a round holotable, seen on a desktop or in a Meta Quest 3 (often in passthrough, the hologram on their real desk). Think Tony Stark's workshop: you build what they're thinking about, in light, and you're quick, dry and capable.

You change the board only with your tools. What you say back is spoken aloud by a voice, so keep the final answer to one to three short sentences: what you built and the one thing worth knowing. Never list every item.

## The space
Metres. The table's top is y = 0, its middle is the origin, it's about 2.8 m across (radius 1.4). x is left→right, z is back→front (+z is toward them), y is up. Items stand on the table at y = 0 unless lifted. Keep things within radius ~1.3. Items about 0.25–0.35 m apart read well. Their focus point (where they're looking) is given with each request: build near it unless told otherwise.

## Components
Architecture blocks (${ARCH_KINDS.join(", ")}) are holographic shapes with a floating label; link them to show how they talk. Link styles: sync (solid, request/response), async (dashed, events/messages), data (thick, data flow), depends (thin, faint). Labels on links say what flows ("REST", "orders.created", "SQL"). Give links a protocol (${PROTOCOLS.join(", ")}) — each moves its own way: REST packets out with replies back, gRPC streams both ways, Kafka a dense stream, SQL heavy chunks — and, for the important ones, a short sample message (a JSON body, an event) that rides along.
Whiteboard: note (a glowing sticky note with a body of text, default gold — use for decisions, open questions, risks, TODOs), text (floating words, for titles and annotations; lift it to y≈0.3), frame (a labelled zone drawn on the table, size [width, depth], to group: "Frontend", "VPC", "Phase 1"), ink (freehand strokes; they draw these, you rarely do).
Holograms (kind holo): any 3D object, made of parts. Use them for physical things (a drone, an engine, a building, a robot arm, a device), for metaphors (a core, a vault), or anything the blocks can't show. Make them look like Stark's: glowing wireframe edges with a faint fill, several distinct parts, a slow spin, parts that explode outward along sensible directions.

Status (idea, planned, building, done, risk) shows as a coloured ring; use it when they talk about progress or risk.
Colours: ${Object.keys(COLORS).join(", ")}, or #rrggbb. Cyan is the default; amber for highlights; red for risk.

## Building well
- An architecture: add the blocks and their links in ONE add call (use refs to link new items), then arrange with "flow" (sources at the back, sinks at the front). Group with frames when there are tiers or boundaries; put the frame under its items (frames are drawn flat on the table).
- A plan or roadmap: frames as phases in a row, notes inside each.
- Don't pile things on top of each other: give positions, or let add place them, or arrange afterwards.
- Changing something: update it; don't remove and re-add (that breaks links and their undo).
- Ids look like i3fk2ab9. Refer to items by id in tools; in your answer, by name.
- Point at what you built at the end (point), so their view goes there.

## Hologram parts
A hologram is a list of parts, each {shape, pos, rot (degrees), scale, size/radius/…, color, opacity (fill, 0–1, default 0.12), wire (edges only), explode ([dx,dy,dz] where it flies when pulled apart), anim {spin [deg/s x,y,z], bob (m), pulse (0–1)}, repeat {count, offset, rotate, radial (radius: copies round a circle about y)}, children}.
Shapes: box (size [w,h,d]), sphere (radius), cylinder (radius, radiusTop, height), cone (radius, height), torus (radius, tube), ring (radius, tube = inner radius; flat, lies in xz), capsule (radius, height), plane (size [w,h]), icosahedron/octahedron/tetrahedron/dodecahedron (radius), gear (radius, teeth, depth), tube (points: [[x,y,z],…], radius), lathe (points: [[r,y],…] profile spun about y), extrude (points: [[x,y],…] outline, depth), text (text, size [height]).
Design about 0.4 m tall (the item's scale enlarges it), centred on the origin with its base near y = 0. Use 6–40 parts for a rich model. Give each meaningful part an explode vector away from the centre so pulling it apart is satisfying.
For what's tedious to list (many teeth, a helix, a lattice, a city of towers), give a script instead of parts: the body of a JavaScript function that receives \`api\` and returns the parts array. api has: range(n) → [0..n-1], lerp(a,b,t), rand() (seeded), TAU, deg(radians→degrees). Plain Math works. No DOM, no network; it runs in a sandbox with a 2 s limit. The tool tells you if it threw; fix it and try again.

## Code
A board drawn from a repo (or linked to one) remembers it, and you can read that repo whenever they ask: repo_files (list, by folder or glob), repo_grep (search), repo_read (a file, or a stretch of it). Use them for questions about how it works ("where do refunds happen?", "what calls the ledger?") and for redesigns — read what's really there before proposing a change, and say what you based it on. Answer from the code, briefly, not from the board alone.
Blocks drawn from code carry a code link (code: the code map's module id and its main paths), so they expand into the Code view right where they are. Keep those links when you change or split blocks; give new ones a link when they map to real code.
The board is part of a project, with a Code view beside it. When they ask to see the code of something ("show me the code of this", "expand the order service", "where is that in the code?"), call show_code: it switches them to the Code view, filtered to that item's code. For an item with no link, find its code first (repo_grep / repo_files), give it the link with update, then show_code.

## More you can do
- simulate: play a request moving hop by hop through the architecture, with captions — the best answer to "what happens when…".
- present: a guided tour with captions, stop by stop.
- flag / clear_flags: a design review. When they ask for a review, flag the real issues (3–8), then tell them the top one or two.
- metrics on items (gauges): when they ask for load, latency or cost estimates, set realistic numbers with units.
- attach: pin notes to the item they're about.
- place_prefab: ready-made holograms (instant). template: a whole starting layout to adapt.
- inside: open a block's own board and design its internals there.
- save_version: before a big change they might want to undo, or when they ask.
- tune / tune_knobs / use_preset: how the workshop looks and behaves.
- repo: read a code repo (the one open in Constellate, or a path) and build its real architecture — services, datastores, queues, external APIs, with links named for what flows and their protocols. Use frames for deployment boundaries. Put the important modules' internals on their inside boards only if asked.
- C4: the board is the system in context; an item's inside board holds its containers, theirs the components, then code. When asked for a C4 model, build the top level here and use inside with a request for the levels below.
- Pictures: when they send a photo of a whiteboard, a sketch, or a drawing made in ink, read every box, label and arrow and build it for real — blocks for boxes (pick the kind from the words), links for arrows (with their labels), notes for loose text, frames for grouped areas — laid out as the picture is. When the request says where the ink is, put each thing where its strokes were and remove the ink strokes you replaced.
- screen_action: switch modes and panels on their screens (desk mode, wall mode, snapshots, the shelf, …) when they ask.

Don't ask clarifying questions for things you can reasonably decide — make a good first version; they'll tell you what to change.`;

/* ------------------------------ placement ------------------------------- */

/** A free spot near `near` on the table: a spiral out until nothing's within `gap`. */
function freeSpot(taken: Vec3[], near: Vec3, gap = 0.26): Vec3 {
  for (let k = 0; k < 400; k++) {
    const r = k === 0 ? 0 : gap * Math.sqrt(k) * 0.9;
    const a = k * 2.399963;
    const p: Vec3 = [near[0] + Math.cos(a) * r, 0, near[2] + Math.sin(a) * r];
    if (Math.hypot(p[0], p[2]) > 1.35) continue;
    if (taken.every((t) => Math.hypot(t[0] - p[0], t[2] - p[2]) >= gap)) return [round(p[0]), 0, round(p[2])];
  }
  return [round(near[0]), 0, round(near[2])];
}
const round = (n: number) => Math.round(n * 1000) / 1000;

/** An item named by id, by a ref made in this call, or failing those by its label. */
function resolver(b: Board, refs: Map<string, string>) {
  return (s: string): string | null => {
    if (refs.has(s)) return refs.get(s)!;
    if (b.items.some((i) => i.id === s)) return s;
    const low = s.toLowerCase();
    return b.items.find((i) => nameOf(i).toLowerCase() === low)?.id ?? b.items.find((i) => nameOf(i).toLowerCase().includes(low))?.id ?? null;
  };
}

/* -------------------------------- tools --------------------------------- */

function boardServer(boardId: string, screen: BoardScreen, report: (line: string) => void, run: string) {
  const current = async () => (await getBoard(boardId))?.board ?? null;
  /** The repo this board reads: its own link, else its project's (the one the Code view shows), else the one open in the code map. */
  const repoRoot = async () => {
    const b = await current();
    if (b?.repo?.root) return b.repo.root;
    const p = b?.projectId ? await getProject(b.projectId) : null;
    return p?.activeRepo ?? p?.repos[0]?.root ?? session.state.repo?.root ?? null;
  };
  const focus = (): Vec3 => screen.focus ?? [0, 0, 0];

  const tools = [
    tool(
      "board",
      "What's on the board now: every item and link in brief. With ids, those items in full (a hologram's parts, a note's text).",
      { ids: z.array(z.string()).optional() },
      async ({ ids }) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        if (ids?.length) return ok(JSON.stringify(b.items.filter((i) => ids.includes(i.id)), null, 1));
        return ok(describeBoard(b, { selected: screen.selected }));
      },
    ),
    tool(
      "add",
      "Add items, and optionally links between them, in one step. Give each new item a `ref` to link it in the same call (links take refs, ids or labels). Items without pos are placed in free spots near their focus. `arrange` lays the new items out afterwards.",
      {
        items: z.array(z.object({ ref: z.string().optional(), kind, ...itemFields })).max(80),
        links: z
          .array(z.object(linkFields))
          .optional(),
        arrange: z.enum(ARRANGEMENTS as [string, ...string[]]).optional(),
        center: vec3.optional().describe("Where to centre the arrangement; their focus by default."),
      },
      async (a) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        report(`Adding ${a.items.length} item${a.items.length === 1 ? "" : "s"}`);
        const refs = new Map<string, string>();
        const taken = b.items.filter((i) => i.kind !== "frame" && i.kind !== "ink").map((i) => i.pos);
        const items: Item[] = a.items.map((it) => {
          const id = newId();
          if (it.ref) refs.set(it.ref, id);
          const { ref: _r, ...rest } = it;
          const pos = rest.pos ?? (it.kind === "frame" ? ([focus()[0], 0, focus()[2]] as Vec3) : freeSpot(taken, focus()));
          if (rest.attach) rest.attach = refs.get(rest.attach) ?? rest.attach;
          if (it.kind !== "frame") taken.push(pos);
          return { ...defaultsFor(it.kind), ...rest, id, kind: it.kind, pos } as Item;
        });
        const find = resolver({ ...b, items: [...b.items, ...items] }, refs);
        for (const it of items) if (it.attach) it.attach = find(it.attach) ?? undefined;
        const links: Link[] = [];
        const missing: string[] = [];
        for (const l of a.links ?? []) {
          const from = find(l.from);
          const to = find(l.to);
          if (!from || !to) missing.push(`${l.from} → ${l.to}`);
          else links.push({ id: newId("l"), from, to, label: l.label, style: l.style as Link["style"], both: l.both, color: l.color, protocol: l.protocol as Link["protocol"], sample: l.sample });
        }
        const ops: Op[] = [{ op: "add", items, links }];
        if (a.arrange) {
          const ids = items.filter((i) => i.kind !== "frame").map((i) => i.id);
          const tmp = { ...b, items: [...b.items, ...items], links: [...b.links, ...links] };
          for (const [id, pos] of arrange(tmp, ids, a.arrange as never, { center: a.center ?? focus() })) {
            const it = items.find((i) => i.id === id);
            if (it) it.pos = pos;
          }
        }
        await change(boardId, ops, run);
        return ok(
          [
            `Added: ${items.map((i) => `${i.id} ${i.kind} "${nameOf(i)}"${refsOf(refs, i.id)} at [${i.pos.join(", ")}]`).join("; ")}.`,
            links.length ? `Linked ${links.length}.` : "",
            missing.length ? `Couldn't link (no such item): ${missing.join(", ")}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      },
    ),
    tool(
      "update",
      "Change items: move, relabel, recolour, restatus, resize, rewrite a note. Only the fields given change.",
      { changes: z.array(z.object({ id: z.string(), kind: kind.optional(), ...itemFields })).max(120) },
      async ({ changes }) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        report(`Updating ${changes.length} item${changes.length === 1 ? "" : "s"}`);
        const find = resolver(b, new Map());
        const ops: Op[] = [];
        const missing: string[] = [];
        for (const { id, ...patch } of changes) {
          const real = find(id);
          if (patch.attach) patch.attach = find(patch.attach) ?? undefined;
          if (!real) missing.push(id);
          else ops.push({ op: "update", id: real, patch });
        }
        await change(boardId, ops, run);
        return ok(`Updated ${ops.length}.${missing.length ? ` Not found: ${missing.join(", ")}.` : ""}`);
      },
    ),
    tool(
      "remove",
      "Remove items (their links go with them) or links, by id.",
      { ids: z.array(z.string()) },
      async ({ ids }) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        const find = resolver(b, new Map());
        const items = ids.map(find).filter((x): x is string => !!x);
        const links = ids.filter((id) => b.links.some((l) => l.id === id));
        report(`Removing ${items.length + links.length}`);
        await change(boardId, [{ op: "remove", ids: items }, { op: "unlink", ids: links }], run);
        return ok(`Removed ${items.length} item(s) and ${links.length} link(s).`);
      },
    ),
    tool(
      "connect",
      "Link existing items (by id or label). A link that exists already gets the new label and style.",
      { links: z.array(z.object(linkFields)) },
      async (a) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        const find = resolver(b, new Map());
        const links: Link[] = [];
        const missing: string[] = [];
        for (const l of a.links) {
          const from = find(l.from);
          const to = find(l.to);
          if (!from || !to) missing.push(`${l.from} → ${l.to}`);
          else links.push({ id: newId("l"), from, to, label: l.label, style: l.style as Link["style"], both: l.both, color: l.color, protocol: l.protocol as Link["protocol"], sample: l.sample });
        }
        report(`Linking ${links.length}`);
        await change(boardId, [{ op: "link", links }], run);
        return ok(`Linked ${links.length}.${missing.length ? ` Not found: ${missing.join(", ")}.` : ""}`);
      },
    ),
    tool(
      "arrange",
      "Lay items out on the table: flow (layered by their links — the right one for architectures), grid, row, column, ring, or stack (a tower). Omit ids for everything that isn't a frame or ink.",
      {
        ids: z.array(z.string()).optional(),
        how: z.enum(ARRANGEMENTS as [string, ...string[]]),
        center: vec3.optional(),
        spacing: z.number().optional().describe("Metres between items, ~0.32 by default."),
        direction: z.enum(["front-to-back", "left-to-right"]).optional().describe("flow only."),
      },
      async (a) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        const find = resolver(b, new Map());
        const ids = a.ids?.length ? a.ids.map(find).filter((x): x is string => !!x) : b.items.filter((i) => i.kind !== "frame" && i.kind !== "ink").map((i) => i.id);
        report(`Arranging ${ids.length}`);
        const at = arrange(b, ids, a.how as never, { center: a.center ?? (a.ids?.length ? focus() : [0, 0, 0]), spacing: a.spacing, direction: a.direction });
        await change(
          boardId,
          [...at].map(([id, pos]) => ({ op: "update" as const, id, patch: { pos } })),
          run,
        );
        return ok(`Arranged ${at.size}.`);
      },
    ),
    tool(
      "hologram",
      "Create a hologram, or rebuild an existing one (give its id): from parts, or from a script that returns parts. With a script, waits for a screen to build it and tells you if it failed.",
      {
        id: z.string().optional(),
        label: z.string().optional(),
        parts: z.array(partSchema).optional(),
        script: z.string().optional(),
        pos: vec3.optional(),
        scale: z.number().optional(),
        color: z.string().optional(),
        spin: z.boolean().optional(),
        explode: z.number().optional(),
      },
      async (a) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        if (!a.parts?.length && !a.script?.trim()) return fail("Give parts or a script.");
        const existing = a.id ? b.items.find((i) => i.id === resolver(b, new Map())(a.id!)) : undefined;
        const id = existing?.id ?? newId();
        report(`${existing ? "Rebuilding" : "Building"} ${a.label ?? existing?.label ?? "a hologram"}`);
        const holo = a.script?.trim() ? { script: a.script, parts: existing?.holo?.parts } : { parts: a.parts };
        const fields = {
          holo,
          ...(a.label !== undefined ? { label: a.label } : {}),
          ...(a.scale !== undefined ? { scale: a.scale } : {}),
          ...(a.color !== undefined ? { color: a.color } : {}),
          ...(a.spin !== undefined ? { spin: a.spin } : {}),
          ...(a.explode !== undefined ? { explode: a.explode } : {}),
          ...(a.pos ? { pos: a.pos } : {}),
        };
        if (existing) await change(boardId, [{ op: "update", id, patch: fields }], run);
        else {
          const taken = b.items.filter((i) => i.kind !== "frame" && i.kind !== "ink").map((i) => i.pos);
          const item = { ...defaultsFor("holo"), spin: true, ...fields, id, kind: "holo", pos: a.pos ?? freeSpot(taken, focus(), 0.4) } as Item;
          await change(boardId, [{ op: "add", items: [item] }], run);
        }
        if (!a.script?.trim()) return ok(`Hologram ${id} with ${a.parts!.length} part(s).`);
        const r = await awaitBuild(boardId, id, a.script);
        if (r.ok === true) return ok(`Hologram ${id} built: ${r.parts} part(s).`);
        if (r.ok === false) return fail(`Hologram ${id}: the script failed — ${r.error}. Fix it and call hologram again with id ${id}.`);
        return ok(`Hologram ${id} saved. ${r.reason}`);
      },
    ),
    tool(
      "point",
      "Bring their view to items (and optionally select them), so they see what you mean or what you made. Without ids, the whole board.",
      { ids: z.array(z.string()).optional(), select: z.boolean().optional() },
      async ({ ids, select }) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        const find = resolver(b, new Map());
        const real = (ids ?? []).map(find).filter((x): x is string => !!x);
        if (!real.length) command(boardId, { cmd: "overview" });
        else command(boardId, { cmd: "focus", ids: real });
        if (select) command(boardId, { cmd: "select", ids: real });
        return ok("Done.");
      },
    ),
    tool(
      "simulate",
      "Play a request flowing through the system, hop by hop, on every screen: a bright pulse runs along each hop (from → to, by id or label) with a caption. For 'what happens when…', 'walk me through checkout', failure paths. 3–12 hops.",
      { title: z.string(), steps: z.array(z.object({ from: z.string(), to: z.string(), say: z.string().describe("One short line: what happens on this hop") })).min(1).max(20) },
      async ({ title, steps }) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        const find = resolver(b, new Map());
        const out = steps.map((s) => ({ from: find(s.from) ?? undefined, to: find(s.to) ?? undefined, say: s.say }));
        const bad = out.filter((s) => !s.from || !s.to).length;
        command(boardId, { cmd: "play", kind: "flow", title, steps: out.filter((s) => s.from && s.to) });
        report(`Simulating ${title}`);
        return ok(`Playing ${out.length - bad} hop(s) on their screens.${bad ? ` ${bad} named items that don't exist.` : ""} It takes about ${Math.round((out.length - bad) * 2.4)}s.`);
      },
    ),
    tool(
      "present",
      "Give them a guided tour of the board on every screen: each stop brings their view to items and shows a caption. For 'walk me through this', 'present the design', onboarding someone. 3–10 stops.",
      { title: z.string(), stops: z.array(z.object({ ids: z.array(z.string()), say: z.string().describe("One or two short sentences for this stop") })).min(1).max(15) },
      async ({ title, stops }) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        const find = resolver(b, new Map());
        const steps = stops.map((s) => ({ ids: s.ids.map(find).filter((x): x is string => !!x), say: s.say }));
        command(boardId, { cmd: "play", kind: "tour", title, steps });
        report(`Presenting ${title}`);
        return ok(`The tour is playing: ${steps.length} stops.`);
      },
    ),
    tool(
      "flag",
      "A design review finding on an item: a beacon above it (info cyan, warn amber, risk red) with the finding in a few words. Use for single points of failure, missing auth, hot paths, unclear ownership, cost traps. Replaces that item's flags unless append.",
      { id: z.string(), level: z.enum(["info", "warn", "risk"]), text: z.string(), append: z.boolean().optional() },
      async ({ id, level, text, append }) => {
        const b = await current();
        const real = b ? resolver(b, new Map())(id) : null;
        const it = real ? b!.items.find((i) => i.id === real) : null;
        if (!it) return fail(`No item "${id}".`);
        await change(boardId, [{ op: "update", id: it.id, patch: { flags: [...(append ? it.flags ?? [] : []), { level, text }] } }], run);
        return ok("Flagged.");
      },
    ),
    tool("clear_flags", "Take review flags off items (all of them when no ids).", { ids: z.array(z.string()).optional() }, async ({ ids }) => {
      const b = await current();
      if (!b) return fail("The board is gone.");
      const find = resolver(b, new Map());
      const which = ids?.length ? ids.map(find).filter((x): x is string => !!x) : b.items.filter((i) => i.flags?.length).map((i) => i.id);
      await change(boardId, which.map((id) => ({ op: "update" as const, id, patch: { flags: null as never } })), run);
      return ok(`Cleared ${which.length}.`);
    }),
    tool(
      "place_prefab",
      `Place a ready-made hologram from the library, instantly: ${LIBRARY.map((p) => p.name).join(", ")}. Faster than building one; use it when one fits.`,
      { name: z.string(), pos: vec3.optional(), scale: z.number().optional(), color: z.string().optional(), label: z.string().optional() },
      async (a) => {
        const p = findPrefab(a.name);
        if (!p) return fail(`No prefab "${a.name}". There are: ${LIBRARY.map((x) => x.name).join(", ")}.`);
        const b = await current();
        if (!b) return fail("The board is gone.");
        const taken = b.items.filter((i) => i.kind !== "frame" && i.kind !== "ink").map((i) => i.pos);
        const id = newId();
        await change(boardId, [{ op: "add", items: [{ id, kind: "holo", label: a.label ?? p.name, color: a.color ?? p.color, spin: true, scale: a.scale, holo: { parts: p.parts }, pos: a.pos ?? freeSpot(taken, focus(), 0.4) }] }], run);
        return ok(`Placed ${p.name} as ${id}.`);
      },
    ),
    tool(
      "template",
      `Lay out a starting board around a point: ${TEMPLATE_NAMES.map((t) => `${t.name} (${t.about})`).join("; ")}. Then adapt it with update/add to what they asked.`,
      { name: z.string(), center: vec3.optional() },
      async ({ name, center }) => {
        const t = layTemplate(name, center ?? [0, 0, 0]);
        if (!t) return fail(`No template "${name}".`);
        report(`Laying out ${name}`);
        await change(boardId, [{ op: "add", items: t.items, links: t.links }], run);
        return ok(`Laid out: ${t.items.map((i) => `${i.id} ${i.kind} "${nameOf(i)}"`).join("; ")}.`);
      },
    ),
    tool(
      "inside",
      "Open the inside of an item: its own board, for what it's made of (a service's modules, a device's subsystems). Every screen goes there. With a request, you then design the inside on that board, in the background.",
      { id: z.string(), request: z.string().optional() },
      async ({ id, request }) => {
        const b = await current();
        const real = b ? resolver(b, new Map())(id) : null;
        if (!real) return fail(`No item "${id}".`);
        const inner = await boardInside(boardId, real);
        if (!inner) return fail("Couldn't open it.");
        command(boardId, { cmd: "open", boardId: inner.id });
        if (request) setTimeout(() => void askBoard(inner.id, request, { ...screen, boardId: inner.id, selected: [], focus: [0, 0, 0] }), 1500);
        return ok(`Opened ${inner.name} (${inner.id}).${request ? " Designing its inside there now." : ""}`);
      },
    ),
    tool(
      "repo_files",
      "List files in the board's repo: everything, a folder (dir), or a glob (\"*.go\", \"src/**/*.ts\").",
      { dir: z.string().optional(), glob: z.string().optional() },
      async ({ dir, glob }) => {
        const root = await repoRoot();
        if (!root) return fail("This board isn't linked to a repo. Use the repo tool first (it links it).");
        report("Looking through the code");
        return ok(await listFiles(root, { dir, glob }));
      },
    ),
    tool(
      "repo_read",
      "Read a file of the board's repo (repo-relative path), or a stretch of it: from (line, 1-based) and lines.",
      { file: z.string(), from: z.number().int().optional(), lines: z.number().int().optional() },
      async ({ file, from, lines }) => {
        const root = await repoRoot();
        if (!root) return fail("This board isn't linked to a repo. Use the repo tool first (it links it).");
        report(`Reading ${file.split("/").pop()}`);
        return ok(await readCode(root, file, from, lines));
      },
    ),
    tool(
      "repo_grep",
      "Search the board's repo: a regex (case-insensitive), over files matching a glob or under a folder. Returns file:line: text.",
      { pattern: z.string(), glob: z.string().optional(), dir: z.string().optional() },
      async ({ pattern, glob, dir }) => {
        const root = await repoRoot();
        if (!root) return fail("This board isn't linked to a repo. Use the repo tool first (it links it).");
        report(`Searching the code for ${pattern.slice(0, 30)}`);
        return ok(await grepCode(root, pattern, { glob, dir }));
      },
    ),
    tool(
      "repo",
      "Read a code repository so you can draw its architecture: the repo open in Constellate's code map (its charted modules and how they talk, its stack, entry points, import graph) and its compose files, Kubernetes manifests, Dockerfiles and package manifests. Give `path` for another folder on this machine.",
      { path: z.string().optional() },
      async ({ path: dir }) => {
        report("Reading the repo");
        try {
          const brief = await repoBrief(dir);
          // The board remembers it: later questions and redesigns can read the code.
          const open = session.state.repo;
          const root = dir ? path.resolve(dir) : open?.root;
          if (root && !brief.startsWith("No repo is open")) {
            const same = open && path.resolve(open.root) === root;
            await change(boardId, [{ op: "repo", repo: { root, name: same ? open.name : path.basename(root), ...(same && open.branch ? { branch: open.branch } : {}) } }], run);
          }
          return ok(brief);
        } catch (e) {
          return fail(`Couldn't read it: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    ),
    tool(
      "screen_action",
      `Do something on their screens that isn't a board change: ${BOARD_ACTIONS.filter((a) => a.id !== "none").map((a) => `${a.id} (${a.label})`).join(", ")}.`,
      { action: z.string() },
      async ({ action }) => {
        const a = BOARD_ACTIONS.find((x) => x.id === action);
        if (!a) return fail(`No action "${action}".`);
        command(boardId, { cmd: "action", id: a.id });
        return ok(`${a.label}: done.`);
      },
    ),
    tool(
      "show_code",
      "Open the Code view (the 3D map of the repo) on the code behind an item — 'show me the code of this', 'expand it into code'. Follows the item's code link, or the paths/module you give (find them with repo_grep first when it has none, and set its code link with update so it works next time). By default the map is filtered to only that code.",
      { item: z.string().optional().describe("Item id or name; the selected item when omitted"), paths: z.array(z.string()).optional(), module: z.string().optional(), only: z.boolean().optional() },
      async ({ item, paths, module, only }) => {
        const b = await current();
        if (!b) return fail("The board is gone.");
        const id = item ? resolver(b, new Map())(item) : screen.selected?.[0];
        const it = id ? b.items.find((i) => i.id === id) : undefined;
        const ref = { module: module ?? it?.code?.module, paths: paths?.length ? paths : it?.code?.paths };
        if (!ref.module && !ref.paths?.length) return fail(`${it ? `"${nameOf(it)}" has no code link.` : "No item."} Find its code with repo_grep / repo_files, then call again with paths.`);
        command(boardId, { cmd: "code", link: { root: (await repoRoot()) ?? undefined, ...ref, only: only !== false, label: it ? nameOf(it) : undefined, itemId: it?.id } });
        return ok("The Code view is opening on it.");
      },
    ),
    tool("save_version", "Keep the board as it is now as a named version they can go back to.", { label: z.string() }, async ({ label }) => {
      const v = await saveVersion(boardId, label);
      return ok(v ? `Saved "${label}".` : "Nothing's changed since the last version.");
    }),
    tool("rename_board", "Give the board a name.", { name: z.string() }, async ({ name }) => {
      await change(boardId, [{ op: "rename", name }], run);
      return ok("Renamed.");
    }),
    ...TUNE_TOOLS.map((t) =>
      tool(
        t.name,
        t.description,
        Object.fromEntries(Object.keys(t.properties).map((k) => [k, z.string()])),
        async (a: Record<string, unknown>) => ok(JSON.stringify(await runBoardTune(t.name, a, boardId, screen))),
      ),
    ),
    tool("clear_board", "Remove everything on the board. Only when they clearly ask to start over.", {}, async () => {
      report("Clearing the board");
      await change(boardId, [{ op: "clear" }], run);
      return ok("Cleared. (They can undo.)");
    }),
  ];
  return { server: createSdkMcpServer({ name: "board", version: "1.0.0", tools, alwaysLoad: true }), names: tools.map((t) => `mcp__board__${t.name}`) };
}

function refsOf(refs: Map<string, string>, id: string) {
  for (const [r, v] of refs) if (v === id) return ` (ref ${r})`;
  return "";
}

/* ------------------------------ asking it ------------------------------- */

const running = new Map<string, AbortController>();

function screenNote(s: BoardScreen, b: Board): string {
  const sel = (s.selected ?? []).map((id) => b.items.find((i) => i.id === id)).filter(Boolean) as Item[];
  return [
    "",
    "---",
    `They're ${s.mode === "ar" ? "in passthrough, the board on their desk" : s.mode === "vr" ? "in VR" : "at the desktop"}.`,
    s.focus ? `Their focus point on the table: [${s.focus.map((n) => n.toFixed(2)).join(", ")}].` : "",
    sel.length ? `Selected: ${sel.map((i) => `${i.id} ${i.kind} "${nameOf(i)}"`).join(", ")}. "This", "it" and "these" mean the selection.` : "Nothing is selected.",
    "",
    describeBoard(b, { max: 120, selected: s.selected }),
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * Ask the assistant to do something on a board. A new request on the same
 * board stops the one before (they changed their mind). Resolves with what it
 * said, to be spoken.
 */
export type BoardImage = { data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" };

export async function askBoard(boardId: string, request: string, screen: BoardScreen = {}, o: { images?: BoardImage[] } = {}): Promise<{ answer: string; error?: string }> {
  const l = await getBoard(boardId);
  if (!l) return { answer: "", error: "No such board." };
  running.get(boardId)?.abort();
  const ctl = new AbortController();
  running.set(boardId, ctl);

  let line = "Thinking";
  let answer = "";
  let live = "";
  const status = (patch: Partial<NonNullable<Board["activity"]>>) => setActivity(boardId, { busy: true, line, at: Date.now(), ...patch });
  status({});
  const { server, names } = boardServer(
    boardId,
    screen,
    (s) => {
      line = s;
      status({});
    },
    `run:${newId("r")}`,
  );

  const text = request + screenNote(screen, l.board);
  // With pictures (a photo of a whiteboard, a sketch), the request goes as a message with them in it.
  const prompt = (): string | AsyncIterable<SDKUserMessage> => {
    const imgs = o.images ?? [];
    if (!imgs.length) return text;
    return (async function* () {
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [...imgs.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })), { type: "text" as const, text }] },
      } as SDKUserMessage;
    })();
  };
  const run = (resume: string | undefined) =>
    query({
      prompt: prompt(),
      options: {
        cwd: CACHE_DIR,
        model: MODEL,
        effort: EFFORT,
        systemPrompt: SYSTEM,
        tools: [],
        allowedTools: names,
        permissionMode: "dontAsk",
        settingSources: [],
        mcpServers: { board: server },
        resume,
        includePartialMessages: true,
        maxTurns: 40,
        abortController: ctl,
        stderr: process.env.CODEFLIGHT_DEBUG ? (d) => console.error("[board-agent]", d) : undefined,
      },
    });

  const drive = async (resume: string | undefined) => {
    for await (const msg of run(resume)) {
      if (msg.type === "system" && msg.subtype === "init") setAgentSession(boardId, msg.session_id);
      else if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
        const ev = msg.event;
        if (ev.type === "message_start") live = "";
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") live += ev.delta.text;
      } else if (msg.type === "result") {
        if (msg.subtype === "success") answer = msg.result;
        else throw new Error(msg.subtype.replace(/_/g, " "));
      }
    }
  };

  // A version to come back to, before anything it does lands.
  await saveVersion(boardId, `Before: ${request.slice(0, 80)}`).catch(() => null);
  try {
    const resume = agentSessionOf(boardId);
    try {
      await drive(resume);
    } catch (err) {
      // A conversation that can't be resumed (expired, from another machine): start a fresh one.
      if (!resume || ctl.signal.aborted) throw err;
      setAgentSession(boardId, undefined);
      await drive(undefined);
    }
    if (ctl.signal.aborted) return { answer: "", error: "superseded" };
    answer = (answer || live).trim();
    setActivity(boardId, { busy: false, answer, at: Date.now() });
    return { answer };
  } catch (err) {
    if (ctl.signal.aborted) return { answer: "", error: "superseded" };
    const error = err instanceof Error ? err.message : String(err);
    console.error("[board-agent]", error);
    setActivity(boardId, { busy: false, error, at: Date.now() });
    return { answer: "", error };
  } finally {
    if (running.get(boardId) === ctl) running.delete(boardId);
  }
}

export function stopBoardAgent(boardId: string): boolean {
  const c = running.get(boardId);
  if (!c) return false;
  c.abort();
  running.delete(boardId);
  setActivity(boardId, { busy: false, at: Date.now() });
  return true;
}
