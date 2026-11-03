/**
 * The workshop: a spatial planning board, separate from the code map. A board
 * is a set of items standing on a round holotable and the links between them,
 * in metres, in the board's own space: y up, the table's top at y = 0, its
 * middle at the origin, and its front (where you stand) toward +z.
 *
 * The server owns every board. Clients and the agent change one only through
 * ops (see applyOps), and every change is pushed to every open client, so the
 * desktop and the headset show the same board, live.
 */

export type Vec3 = [number, number, number];

/** Architecture blocks: the parts of a system. */
export const ARCH_KINDS = ["service", "database", "queue", "api", "client", "user", "cache", "storage", "function", "external", "cloud"] as const;
/** Whiteboard basics. */
export const BOARD_KINDS = ["note", "text", "frame", "ink"] as const;
/** Holographic models: a 3D object built from parts (or a script that makes them). */
export const HOLO_KINDS = ["holo"] as const;

export type ArchKind = (typeof ARCH_KINDS)[number];
export type ItemKind = ArchKind | (typeof BOARD_KINDS)[number] | (typeof HOLO_KINDS)[number];
export const ITEM_KINDS: readonly ItemKind[] = [...ARCH_KINDS, ...BOARD_KINDS, ...HOLO_KINDS];

export type ItemStatus = "idea" | "planned" | "building" | "done" | "risk";
export const STATUSES: readonly ItemStatus[] = ["idea", "planned", "building", "done", "risk"];

/** The palette: names the agent and the voice can use, and what they look like. */
export const COLORS: Record<string, string> = {
  cyan: "#5fd4ff",
  ice: "#bfefff",
  blue: "#4c8dff",
  teal: "#3ef2c9",
  green: "#7dff9a",
  amber: "#ffb547",
  orange: "#ff7a3d",
  red: "#ff4d5e",
  magenta: "#ff4fd8",
  violet: "#a98bff",
  gold: "#ffd75e",
  white: "#e8f6ff",
};
export const DEFAULT_COLOR = COLORS.cyan;

/** A colour name from the palette, or any #rrggbb; anything else falls back to cyan. */
export function colorOf(c: string | undefined, fallback = DEFAULT_COLOR): string {
  if (!c) return fallback;
  if (COLORS[c]) return COLORS[c];
  return /^#[0-9a-f]{6}$/i.test(c) ? c : fallback;
}

/* --------------------------------- holo --------------------------------- */

export const SHAPES = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "ring",
  "capsule",
  "plane",
  "icosahedron",
  "octahedron",
  "tetrahedron",
  "dodecahedron",
  "gear",
  "tube",
  "lathe",
  "extrude",
  "text",
] as const;
export type Shape = (typeof SHAPES)[number];

/**
 * One part of a hologram. Sizes are metres before the item's own scale; a
 * hologram is designed to fit in about 0.4 m. Angles are degrees.
 */
export type Part = {
  shape: Shape;
  name?: string;
  /** box: [w, h, d]. Others: a non-uniform stretch of the shape. */
  size?: Vec3;
  radius?: number;
  /** torus, ring: the tube's radius, or the ring's inner radius. */
  tube?: number;
  height?: number;
  /** The top radius of a cylinder (a cone is 0). */
  radiusTop?: number;
  /** gear: how many teeth. */
  teeth?: number;
  /** tube: the path, as points; lathe: the profile, as [radius, y] pairs; extrude: the outline, as [x, y] pairs. */
  points?: number[][];
  /** extrude: how thick. */
  depth?: number;
  /** text: what it says. */
  text?: string;
  pos?: Vec3;
  rot?: Vec3;
  scale?: Vec3 | number;
  color?: string;
  /** 0..1, how solid the hologram's fill is (the edges always glow). */
  opacity?: number;
  /** Only the glowing edges, no fill. */
  wire?: boolean;
  /** Where this part flies to (an offset, m) when the model is pulled apart. */
  explode?: Vec3;
  anim?: {
    /** Degrees per second about x, y, z. */
    spin?: Vec3;
    /** Up and down, this many metres. */
    bob?: number;
    /** Brightness pulse, 0..1. */
    pulse?: number;
  };
  /** Copies of this part: along an offset, or round a circle. */
  repeat?: { count: number; offset?: Vec3; rotate?: Vec3; radial?: number };
  children?: Part[];
};

export type Holo = {
  parts?: Part[];
  /**
   * JavaScript that returns Part[] (the body of a function given `api`),
   * for what's easier to compute than to list: run in a sandbox in the
   * browser, and its parts kept here once built.
   */
  script?: string;
  /** What the last build of the script said, if it failed. */
  error?: string;
  /** The script that `parts` were built from: a different one builds again. */
  builtFrom?: string;
};

/* --------------------------------- items -------------------------------- */

export type Item = {
  id: string;
  kind: ItemKind;
  pos: Vec3;
  /** Turn about the vertical, degrees. Ink and holos may carry a full rotation instead. */
  rotY?: number;
  /** A full rotation as a quaternion [x, y, z, w]; wins over rotY. */
  quat?: [number, number, number, number];
  scale?: number;
  label?: string;
  /** Notes and text: what it says (a few lines; markdown-ish bullets are fine). */
  body?: string;
  color?: string;
  status?: ItemStatus;
  /** A frame or a note: width and depth (frame, on the table) or width and height (note), metres. */
  size?: [number, number];
  /** Ink: the stroke's points, relative to pos. */
  points?: Vec3[];
  /** Ink: line width, metres. */
  width?: number;
  holo?: Holo;
  /** A hologram pulled apart: 0 together, 1 fully apart. */
  explode?: number;
  /** A hologram that turns slowly on its own. */
  spin?: boolean;
  /** Tech or anything else worth a tag: "Go", "Postgres 16", "gRPC". */
  tags?: string[];
  /** Pinned to another item: moves with it (a note on a service). */
  attach?: string;
  /** A design review's findings on it: a beacon above it. */
  flags?: Flag[];
  /** Numbers worth seeing on it: gauges beside it (RPS, latency, cost). */
  metrics?: Metric[];
  /** Its own board, inside it: what it's made of. */
  sub?: string;
  /** Where it is in the code (the board's repo): a module of the code map, and its main paths. */
  code?: CodeRef;
};

/** An item's place in the code: the code map's module id, and the folders or files it is. */
export type CodeRef = { module?: string; paths?: string[] };

/** The repository a board was drawn from: Jarvis can read it, and items link into its code map. */
export type BoardRepo = { root: string; name: string; branch?: string };

export type Flag = { level: "info" | "warn" | "risk"; text: string };
export type Metric = { label: string; value: number; unit?: string; max?: number };

export type LinkStyle = "sync" | "async" | "data" | "depends";
export const LINK_STYLES: readonly LinkStyle[] = ["sync", "async", "data", "depends"];

export type Link = {
  id: string;
  from: string;
  to: string;
  label?: string;
  style?: LinkStyle;
  color?: string;
  /** Both ways. */
  both?: boolean;
  /** How it talks: picks how its traffic moves (REST packets, a Kafka stream, gRPC both ways…). Guessed from the label when unset. */
  protocol?: Protocol;
  /** A sample of what flows along it (a JSON body, an event): shown riding along now and then. */
  sample?: string;
  /** Drawn by hand: the points (board space) it passes through. */
  via?: Vec3[];
};

export const PROTOCOLS = ["rest", "grpc", "graphql", "kafka", "amqp", "websocket", "sql", "http", "events", "file"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** A link's protocol: as set, or guessed from its label and style. */
export function protocolOf(l: Pick<Link, "protocol" | "label" | "style">): Protocol | null {
  if (l.protocol) return l.protocol;
  const s = (l.label ?? "").toLowerCase();
  if (/grpc|protobuf|rpc/.test(s)) return "grpc";
  if (/graphql|gql/.test(s)) return "graphql";
  if (/kafka|kinesis|stream|topic|pulsar/.test(s)) return "kafka";
  if (/amqp|rabbit|sqs|sns|queue|pub\/?sub|nats/.test(s)) return "amqp";
  if (/websocket|\bws\b|socket|sse|realtime/.test(s)) return "websocket";
  if (/sql|postgres|mysql|query|jdbc|select/.test(s)) return "sql";
  if (/rest|json|https?|api|get|post/.test(s)) return "rest";
  if (/s3|blob|file|upload|csv|parquet/.test(s)) return "file";
  if (/\w+\.\w+/.test(s) || l.style === "async") return "events";
  if (l.style === "data") return "sql";
  return null;
}

export type Board = {
  id: string;
  name: string;
  items: Item[];
  links: Link[];
  createdAt: number;
  updatedAt: number;
  /** Bumped on every change. */
  rev: number;
  /**
   * The board this one is under: inside one of its items (the item it opened
   * from), or filed under it, like a folder in a folder.
   */
  parent?: { boardId: string; itemId?: string; name: string };
  /** The project it belongs to (shared/project.ts). */
  projectId?: string;
  /** Links to items on other boards: drawn when both boards stand in the room. */
  xlinks?: XLink[];
  /** Views kept as cards: where the head was, what it looked at (board space). */
  snaps?: Snap[];
  /** The repo it was drawn from (or linked to): Jarvis reads it; items point into it. */
  repo?: BoardRepo;
  /** What the assistant is doing on this board right now, for the status line. */
  activity?: { busy: boolean; line?: string; answer?: string; error?: string; at: number };
};

export type BoardSummary = {
  id: string;
  name: string;
  updatedAt: number;
  items: number;
  createdAt?: number;
  projectId?: string;
  /** The board it's under, and the item it's inside of (if it's an item's inside). */
  parent?: string;
  itemId?: string;
  /** The repo it's linked to (its root). */
  repo?: string;
  /** Items on it that point into the code. */
  linked?: number;
};

/** A link from an item here to an item on another board. */
export type XLink = { id: string; from: string; board: string; to: string; label?: string };

/** A view kept as a card: tap it to stand there again. */
export type Snap = { id: string; label: string; at: number; head: Vec3; look: Vec3; scale?: number; selected?: string[]; thumb?: string };

/* ---------------------------------- ops --------------------------------- */

export type ItemPatch = Partial<Omit<Item, "id" | "kind">> & { kind?: ItemKind };

export type Op =
  | { op: "add"; items: Item[]; links?: Link[] }
  | { op: "update"; id: string; patch: ItemPatch }
  | { op: "remove"; ids: string[] }
  | { op: "link"; links: Link[] }
  | { op: "unlink"; ids: string[] }
  | { op: "updateLink"; id: string; patch: Partial<Omit<Link, "id">> }
  | { op: "rename"; name: string }
  | { op: "clear" }
  | { op: "xlink"; links: XLink[] }
  | { op: "unxlink"; ids: string[] }
  | { op: "snap"; snap: Snap }
  | { op: "repo"; repo: BoardRepo | null }
  | { op: "unsnap"; ids: string[] };

/** Changes to a board are coalesced under this key: a drag's many moves are one step to undo. */
export type OpBatch = { ops: Op[]; /** Same key as the last batch within a moment: one undo step. */ merge?: string };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clampN = (n: unknown, lo: number, hi: number, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d);
const v3 = (v: unknown, d: Vec3 = [0, 0, 0]): Vec3 =>
  Array.isArray(v) && v.length >= 3 ? [r3(clampN(v[0], -20, 20, d[0])), r3(clampN(v[1], -5, 10, d[1])), r3(clampN(v[2], -20, 20, d[2]))] : d;

/** An item made safe to keep: known kind, numbers in range, nothing unbounded. */
export function cleanItem(i: Partial<Item> & { id: string }): Item {
  const kind = ITEM_KINDS.includes(i.kind as ItemKind) ? (i.kind as ItemKind) : "note";
  const out: Item = { id: i.id, kind, pos: v3(i.pos) };
  if (i.rotY !== undefined) out.rotY = r3(clampN(i.rotY, -3600, 3600, 0) % 360);
  if (Array.isArray(i.quat) && i.quat.length === 4 && i.quat.every((n) => typeof n === "number" && Number.isFinite(n))) out.quat = i.quat.map(r3) as Item["quat"];
  if (i.scale !== undefined) out.scale = r3(clampN(i.scale, 0.05, 20, 1));
  if (typeof i.label === "string") out.label = i.label.slice(0, 120);
  if (typeof i.body === "string") out.body = i.body.slice(0, 4000);
  if (typeof i.color === "string") out.color = i.color.slice(0, 16);
  if (i.status && STATUSES.includes(i.status)) out.status = i.status;
  if (Array.isArray(i.size) && i.size.length === 2) out.size = [r3(clampN(i.size[0], 0.02, 10, 0.3)), r3(clampN(i.size[1], 0.02, 10, 0.2))];
  if (Array.isArray(i.points)) out.points = i.points.slice(0, 4000).map((p) => v3(p));
  if (i.width !== undefined) out.width = r3(clampN(i.width, 0.001, 0.1, 0.006));
  if (i.holo && typeof i.holo === "object") {
    const h: Holo = {};
    if (Array.isArray(i.holo.parts)) h.parts = i.holo.parts.slice(0, 2000);
    if (typeof i.holo.script === "string") h.script = i.holo.script.slice(0, 40_000);
    if (typeof i.holo.error === "string") h.error = i.holo.error.slice(0, 2000);
    if (typeof i.holo.builtFrom === "string") h.builtFrom = i.holo.builtFrom.slice(0, 40_000);
    out.holo = h;
  }
  if (i.explode !== undefined) out.explode = r3(clampN(i.explode, 0, 1, 0));
  if (i.spin !== undefined) out.spin = !!i.spin;
  if (Array.isArray(i.tags)) out.tags = i.tags.filter((t) => typeof t === "string").slice(0, 8).map((t) => t.slice(0, 40));
  if (typeof i.attach === "string" && i.attach !== i.id) out.attach = i.attach.slice(0, 40);
  if (Array.isArray(i.flags))
    out.flags = i.flags
      .filter((f) => f && typeof f.text === "string")
      .slice(0, 6)
      .map((f) => ({ level: (["info", "warn", "risk"] as const).includes(f.level) ? f.level : "warn", text: f.text.slice(0, 200) }));
  if (Array.isArray(i.metrics))
    out.metrics = i.metrics
      .filter((m) => m && typeof m.label === "string" && typeof m.value === "number" && Number.isFinite(m.value))
      .slice(0, 5)
      .map((m) => ({ label: m.label.slice(0, 24), value: m.value, ...(m.unit ? { unit: String(m.unit).slice(0, 12) } : {}), ...(typeof m.max === "number" && m.max > 0 ? { max: m.max } : {}) }));
  if (typeof i.sub === "string") out.sub = i.sub.slice(0, 40);
  if (i.code && typeof i.code === "object") {
    const code: CodeRef = {};
    if (typeof i.code.module === "string" && i.code.module) code.module = i.code.module.slice(0, 80);
    if (Array.isArray(i.code.paths)) code.paths = i.code.paths.filter((p) => typeof p === "string" && p && !p.includes("..")).slice(0, 12).map((p) => p.replace(/^\/+/, "").slice(0, 200));
    if (code.module || code.paths?.length) out.code = code;
  }
  return out;
}

export function cleanLink(l: Partial<Link> & { id: string; from: string; to: string }): Link {
  const out: Link = { id: l.id, from: l.from, to: l.to };
  if (typeof l.label === "string" && l.label) out.label = l.label.slice(0, 80);
  if (l.style && LINK_STYLES.includes(l.style)) out.style = l.style;
  if (typeof l.color === "string") out.color = l.color.slice(0, 16);
  if (l.both) out.both = true;
  if (l.protocol && (PROTOCOLS as readonly string[]).includes(l.protocol)) out.protocol = l.protocol;
  if (typeof l.sample === "string" && l.sample.trim()) out.sample = l.sample.slice(0, 400);
  if (Array.isArray(l.via) && l.via.length) out.via = l.via.slice(0, 12).map((p) => v3(p));
  return out;
}

/**
 * Apply ops to a board, in place. Ops that name something gone are skipped,
 * not errors: two people (or a person and the agent) can race on one item.
 * Returns whether anything changed.
 */
export function applyOps(b: Board, ops: Op[]): boolean {
  let changed = false;
  const byId = () => new Map(b.items.map((i) => [i.id, i]));
  for (const o of ops) {
    switch (o.op) {
      case "add": {
        const have = byId();
        for (const it of o.items) {
          if (have.has(it.id)) continue;
          b.items.push(cleanItem(it));
          changed = true;
        }
        if (o.links?.length) changed = link(b, o.links) || changed;
        break;
      }
      case "update": {
        const idx = b.items.findIndex((i) => i.id === o.id);
        if (idx < 0) break;
        const cur = b.items[idx];
        const next = { ...cur, ...o.patch, id: cur.id } as Item;
        // An explicit undefined clears a field.
        for (const [k, v] of Object.entries(o.patch)) if (v === null || v === undefined) delete (next as Record<string, unknown>)[k];
        // A plain turn replaces a full rotation, and the other way round.
        if (o.patch.rotY !== undefined && o.patch.quat === undefined) delete next.quat;
        b.items[idx] = cleanItem(next);
        changed = true;
        break;
      }
      case "remove": {
        const gone = new Set(o.ids);
        const before = b.items.length;
        b.items = b.items.filter((i) => !gone.has(i.id));
        const lb = b.links.length;
        b.links = b.links.filter((l) => !gone.has(l.from) && !gone.has(l.to) && !gone.has(l.id));
        if (b.xlinks?.length) b.xlinks = b.xlinks.filter((x) => !gone.has(x.from) && !gone.has(x.id));
        // What was pinned to them stays, unpinned.
        b.items = b.items.map((i) => (i.attach && gone.has(i.attach) ? (({ attach: _a, ...rest }) => rest)(i) : i));
        changed = changed || b.items.length !== before || b.links.length !== lb;
        break;
      }
      case "link":
        changed = link(b, o.links) || changed;
        break;
      case "unlink": {
        const gone = new Set(o.ids);
        const before = b.links.length;
        b.links = b.links.filter((l) => !gone.has(l.id));
        changed = changed || b.links.length !== before;
        break;
      }
      case "updateLink": {
        const idx = b.links.findIndex((l) => l.id === o.id);
        if (idx < 0) break;
        b.links[idx] = cleanLink({ ...b.links[idx], ...o.patch, id: o.id });
        changed = true;
        break;
      }
      case "rename":
        if (o.name.trim() && o.name !== b.name) {
          b.name = o.name.trim().slice(0, 80);
          changed = true;
        }
        break;
      case "clear":
        if (b.items.length || b.links.length) {
          b.items = [];
          b.links = [];
          b.xlinks = [];
          changed = true;
        }
        break;
      case "xlink": {
        const ids = new Set(b.items.map((i) => i.id));
        const list = b.xlinks ?? [];
        for (const x of o.links) {
          if (!ids.has(x.from) || typeof x.board !== "string" || typeof x.to !== "string" || list.some((y) => y.from === x.from && y.board === x.board && y.to === x.to)) continue;
          list.push({ id: x.id, from: x.from, board: x.board.slice(0, 40), to: x.to.slice(0, 40), ...(x.label ? { label: String(x.label).slice(0, 80) } : {}) });
          changed = true;
        }
        b.xlinks = list.slice(-200);
        break;
      }
      case "unxlink": {
        const before = b.xlinks?.length ?? 0;
        b.xlinks = (b.xlinks ?? []).filter((x) => !o.ids.includes(x.id));
        changed = changed || b.xlinks.length !== before;
        break;
      }
      case "repo": {
        const r = o.repo;
        if (!r) {
          if (b.repo) changed = true;
          delete b.repo;
        } else if (typeof r.root === "string" && r.root && JSON.stringify(r) !== JSON.stringify(b.repo)) {
          b.repo = { root: r.root.slice(0, 400), name: String(r.name ?? "").slice(0, 120), ...(r.branch ? { branch: String(r.branch).slice(0, 120) } : {}) };
          changed = true;
        }
        break;
      }
      case "snap": {
        const sn = o.snap;
        if (!sn?.id || !Array.isArray(sn.head) || !Array.isArray(sn.look)) break;
        const clean: Snap = {
          id: sn.id,
          label: String(sn.label ?? "View").slice(0, 60),
          at: typeof sn.at === "number" ? sn.at : Date.now(),
          head: v3(sn.head),
          look: v3(sn.look),
          ...(typeof sn.scale === "number" ? { scale: r3(clampN(sn.scale, 0.02, 20, 1)) } : {}),
          ...(Array.isArray(sn.selected) ? { selected: sn.selected.slice(0, 50).map(String) } : {}),
          ...(typeof sn.thumb === "string" && sn.thumb.startsWith("data:image/") && sn.thumb.length < 60_000 ? { thumb: sn.thumb } : {}),
        };
        b.snaps = [...(b.snaps ?? []).filter((x) => x.id !== sn.id), clean].slice(-24);
        changed = true;
        break;
      }
      case "unsnap": {
        const before = b.snaps?.length ?? 0;
        b.snaps = (b.snaps ?? []).filter((x) => !o.ids.includes(x.id));
        changed = changed || b.snaps.length !== before;
        break;
      }
    }
  }
  return changed;
}

function link(b: Board, links: Link[]): boolean {
  const ids = new Set(b.items.map((i) => i.id));
  const have = new Set(b.links.map((l) => l.id));
  let changed = false;
  for (const l of links) {
    if (have.has(l.id) || !ids.has(l.from) || !ids.has(l.to) || l.from === l.to) continue;
    // One link per direction between two items: a second one replaces the label.
    const dup = b.links.find((x) => x.from === l.from && x.to === l.to);
    if (dup) {
      Object.assign(dup, cleanLink({ ...dup, ...l, id: dup.id }));
    } else b.links.push(cleanLink(l));
    changed = true;
  }
  return changed;
}

/** A short, unique-enough id. */
export function newId(prefix = "i"): string {
  return `${prefix}${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
}

/** What an item is called when it has no label. */
export function nameOf(i: Item): string {
  return i.label || (i.kind === "note" || i.kind === "text" ? (i.body ?? "").split("\n")[0].slice(0, 40) : "") || i.kind;
}

/* ------------------------------- defaults ------------------------------- */

/** What a component looks like when it's first made, before anything's said about it. */
export function defaultsFor(kind: ItemKind): Partial<Item> {
  switch (kind) {
    case "note":
      return { body: "New note", color: "gold", size: [0.22, 0.16] };
    case "text":
      return { body: "Text", color: "white" };
    case "frame":
      return { label: "Group", color: "violet", size: [0.8, 0.5] };
    case "ink":
      return { color: "cyan", width: 0.005, points: [] };
    case "holo":
      return { label: "Hologram", color: "cyan", holo: { parts: [{ shape: "icosahedron", radius: 0.12, anim: { spin: [0, 20, 0] } }] } };
    case "database":
      return { label: "Database", color: "teal" };
    case "queue":
      return { label: "Queue", color: "amber" };
    case "cache":
      return { label: "Cache", color: "orange" };
    case "client":
      return { label: "Client", color: "ice" };
    case "user":
      return { label: "User", color: "white" };
    case "api":
      return { label: "API", color: "blue" };
    case "function":
      return { label: "Function", color: "violet" };
    case "storage":
      return { label: "Storage", color: "teal" };
    case "external":
      return { label: "External", color: "magenta" };
    case "cloud":
      return { label: "Cloud", color: "ice" };
    default:
      return { label: "Service", color: "cyan" };
  }
}

/** Roughly how tall an item stands (m, before scale): where a link meets it and a label floats. */
export function heightOf(i: Item): number {
  const s = i.scale ?? 1;
  switch (i.kind) {
    case "note":
      return (i.size?.[1] ?? 0.16) * s;
    case "text":
    case "frame":
    case "ink":
      return 0.02;
    case "holo":
      return 0.35 * s;
    case "user":
      return 0.16 * s;
    default:
      return 0.12 * s;
  }
}

/* ------------------------------- summary -------------------------------- */

/** The board in a few lines of text: what the agent and the voice are told is on it. */
export function describeBoard(b: Board, opts: { max?: number; selected?: string[] } = {}): string {
  const max = opts.max ?? 200;
  const sel = new Set(opts.selected ?? []);
  const lines = [
    `Board "${b.name}" (${b.items.length} items, ${b.links.length} links).${b.parent ? ` It's the inside of "${b.parent.name}" on board ${b.parent.boardId}.` : ""}${b.repo ? ` Linked to the repo ${b.repo.name} (${b.repo.root}): read it with the repo tools.` : ""}`,
  ];
  const name = new Map(b.items.map((i) => [i.id, nameOf(i)]));
  for (const i of b.items.slice(0, max)) {
    const bits = [
      `${i.id}`,
      i.kind,
      JSON.stringify(nameOf(i)),
      `at [${i.pos.map((n) => n.toFixed(2)).join(", ")}]`,
      i.status ? `status ${i.status}` : "",
      i.color ? `color ${i.color}` : "",
      i.scale && i.scale !== 1 ? `scale ${i.scale}` : "",
      i.tags?.length ? `tags ${i.tags.join("/")}` : "",
      i.kind === "holo" ? `${i.holo?.parts?.length ?? 0} parts${i.holo?.script ? " (scripted)" : ""}${i.holo?.error ? ` ERROR: ${i.holo.error}` : ""}` : "",
      i.kind === "frame" && i.size ? `size ${i.size.join("x")}` : "",
      i.attach ? `pinned to ${i.attach}` : "",
      i.sub ? `has an inside board ${i.sub}` : "",
      i.code ? `code: ${[i.code.module ? `module ${i.code.module}` : "", i.code.paths?.length ? i.code.paths.join(", ") : ""].filter(Boolean).join(" · ")}` : "",
      i.flags?.length ? `flags: ${i.flags.map((f) => `${f.level} "${f.text}"`).join("; ")}` : "",
      i.metrics?.length ? `metrics: ${i.metrics.map((m) => `${m.label} ${m.value}${m.unit ?? ""}`).join(", ")}` : "",
      sel.has(i.id) ? "SELECTED" : "",
    ].filter(Boolean);
    lines.push(`- ${bits.join(" · ")}`);
  }
  if (b.items.length > max) lines.push(`… and ${b.items.length - max} more.`);
  for (const l of b.links.slice(0, max)) {
    lines.push(`- link ${l.id}: ${name.get(l.from) ?? l.from} (${l.from}) ${l.both ? "<->" : "->"} ${name.get(l.to) ?? l.to} (${l.to})${l.label ? ` "${l.label}"` : ""}${l.style ? ` [${l.style}]` : ""}`);
  }
  return lines.join("\n");
}

/** What the browser tells the server about what the person is doing on a board. */
export type BoardScreen = {
  boardId?: string;
  selected?: string[];
  tool?: "select" | "connect" | "ink" | "lasso" | "erase";
  mode?: "flat" | "vr" | "ar";
  /** Where they're looking, in board space: the camera's target or the head's gaze on the table. */
  focus?: Vec3;
  /** The Tune knobs they've changed from the defaults. */
  tune?: Record<string, number | boolean | string>;
};

/** Commands the voice or the agent sends to a client's screen (they don't change the board). */
export type BoardCommand =
  | { cmd: "select"; ids: string[] }
  | { cmd: "focus"; ids: string[] }
  | { cmd: "overview" }
  | { cmd: "tool"; tool: "select" | "connect" | "ink" | "lasso" | "erase" }
  | { cmd: "open"; boardId: string }
  /** Turn Tune knobs (a preset is all of them). */
  | { cmd: "tune"; values: Record<string, number | boolean | string> }
  /** The saved presets changed: fetch them again. */
  | { cmd: "presets" }
  /** Play a sequence: a request flowing through the system, or a guided tour. */
  | { cmd: "play"; kind: "flow" | "tour"; title?: string; steps: Step[] }
  | { cmd: "stopPlay" }
  /** What's shown: kinds (or "notes", "ink", …) hidden, and items isolated (everything else dimmed). */
  | { cmd: "layers"; hide?: string[]; isolate?: string[] | null }
  /** Run an action on their screens (shared/boardActions.ts): a mode, a panel, a snapshot. */
  | { cmd: "action"; id: string }
  /** Take their next words as an item's name or text. */
  | { cmd: "dictate"; id?: string }
  /** Show the code behind something in the Code view (shared/project.ts CodeLink). */
  | { cmd: "code"; link: { root?: string; module?: string; paths?: string[]; only?: boolean; label?: string; itemId?: string; ask?: string } };

/** One beat of a flow or a tour: what lights up (items, or a hop from one to another) and what's said. */
export type Step = { ids?: string[]; from?: string; to?: string; say?: string };

/** Someone else on the board, live: a desktop's camera, or a headset's head and hands (board space). */
export type Presence = {
  id: string;
  mode: "flat" | "vr" | "ar";
  head: Vec3;
  /** Where the head (or camera) looks, as a point it's looking at. */
  look: Vec3;
  hands?: { at: Vec3; to?: Vec3 }[];
  at: number;
};
