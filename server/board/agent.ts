import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  ARCH_KINDS,
  COLORS,
  ITEM_KINDS,
  LINK_STYLES,
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
import { CACHE_DIR } from "../session";
import { awaitBuild } from "./holo";
import { agentSessionOf, change, command, getBoard, setActivity, setAgentSession } from "./store";

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
};

const SYSTEM = `You are ${ASSISTANT}, the assistant in a holographic workshop — a 3D planning board that stands on a round holotable, seen on a desktop or in a Meta Quest 3 (often in passthrough, the hologram on their real desk). Think Tony Stark's workshop: you build what they're thinking about, in light, and you're quick, dry and capable.

You change the board only with your tools. What you say back is spoken aloud by a voice, so keep the final answer to one to three short sentences: what you built and the one thing worth knowing. Never list every item.

## The space
Metres. The table's top is y = 0, its middle is the origin, it's about 2.8 m across (radius 1.4). x is left→right, z is back→front (+z is toward them), y is up. Items stand on the table at y = 0 unless lifted. Keep things within radius ~1.3. Items about 0.25–0.35 m apart read well. Their focus point (where they're looking) is given with each request: build near it unless told otherwise.

## Components
Architecture blocks (${ARCH_KINDS.join(", ")}) are holographic shapes with a floating label; link them to show how they talk. Link styles: sync (solid, request/response), async (dashed, events/messages), data (thick, data flow), depends (thin, faint). Labels on links say what flows ("REST", "orders.created", "SQL").
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
          .array(z.object({ from: z.string(), to: z.string(), label: z.string().optional(), style: z.enum(LINK_STYLES as [string, ...string[]]).optional(), both: z.boolean().optional(), color: z.string().optional() }))
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
          if (it.kind !== "frame") taken.push(pos);
          return { ...defaultsFor(it.kind), ...rest, id, kind: it.kind, pos } as Item;
        });
        const find = resolver({ ...b, items: [...b.items, ...items] }, refs);
        const links: Link[] = [];
        const missing: string[] = [];
        for (const l of a.links ?? []) {
          const from = find(l.from);
          const to = find(l.to);
          if (!from || !to) missing.push(`${l.from} → ${l.to}`);
          else links.push({ id: newId("l"), from, to, label: l.label, style: l.style as Link["style"], both: l.both, color: l.color });
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
      { links: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional(), style: z.enum(LINK_STYLES as [string, ...string[]]).optional(), both: z.boolean().optional(), color: z.string().optional() })) },
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
          else links.push({ id: newId("l"), from, to, label: l.label, style: l.style as Link["style"], both: l.both, color: l.color });
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
    tool("rename_board", "Give the board a name.", { name: z.string() }, async ({ name }) => {
      await change(boardId, [{ op: "rename", name }], run);
      return ok("Renamed.");
    }),
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
export async function askBoard(boardId: string, request: string, screen: BoardScreen = {}): Promise<{ answer: string; error?: string }> {
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

  const run = (resume: string | undefined) =>
    query({
      prompt: request + screenNote(screen, l.board),
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
