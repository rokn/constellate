import { defaultsFor, nameOf, newId, type Board, type Item, type ItemKind, type Link, type LinkStyle, type Vec3 } from "./board";
import { arrange } from "./boardLayout";

/**
 * A board in and out of other formats: Mermaid (both ways), a Markdown
 * design doc (out), and the workshop's own JSON (both ways, for copying
 * between boards).
 */

/* -------------------------------- mermaid -------------------------------- */

const SHAPE_OUT: Partial<Record<ItemKind, [string, string]>> = {
  database: ["[(", ")]"],
  storage: ["[(", ")]"],
  queue: ["[[", "]]"],
  user: ["((", "))"],
  api: ["{{", "}}"],
  client: ["[/", "/]"],
  external: [">", "]"],
  cloud: ["((", "))"],
  cache: ["[(", ")]"],
  function: ["([", "])"],
};

const safe = (s: string) => s.replace(/["[\]{}()|<>]/g, " ").trim() || " ";
const mid = (id: string) => `n_${id.replace(/[^a-zA-Z0-9]/g, "")}`;

/** The items inside a frame (by where they stand). */
function inFrame(f: Item, items: Item[]) {
  const [w, d] = f.size ?? [0.8, 0.5];
  return items.filter((i) => i.id !== f.id && i.kind !== "frame" && i.kind !== "ink" && Math.abs(i.pos[0] - f.pos[0]) <= w / 2 && Math.abs(i.pos[2] - f.pos[2]) <= d / 2);
}

export function toMermaid(b: Board): string {
  const nodes = b.items.filter((i) => i.kind !== "frame" && i.kind !== "ink" && i.kind !== "text");
  const frames = b.items.filter((i) => i.kind === "frame");
  const placed = new Set<string>();
  const node = (i: Item) => {
    const [o, c] = SHAPE_OUT[i.kind] ?? ["[", "]"];
    return `${mid(i.id)}${o}"${safe(nameOf(i))}"${c}`;
  };
  const lines = ["flowchart TB"];
  for (const f of frames) {
    const inside = inFrame(f, nodes).filter((i) => !placed.has(i.id));
    if (!inside.length) continue;
    lines.push(`  subgraph ${mid(f.id)}["${safe(f.label ?? "Group")}"]`);
    for (const i of inside) {
      lines.push(`    ${node(i)}`);
      placed.add(i.id);
    }
    lines.push("  end");
  }
  for (const i of nodes) if (!placed.has(i.id)) lines.push(`  ${node(i)}`);
  const ids = new Set(nodes.map((n) => n.id));
  for (const l of b.links) {
    if (!ids.has(l.from) || !ids.has(l.to)) continue;
    const arrow = l.style === "async" ? "-.->" : l.style === "data" ? "==>" : l.style === "depends" ? "---" : l.both ? "<-->" : "-->";
    lines.push(`  ${mid(l.from)} ${arrow}${l.label ? `|"${safe(l.label)}"|` : ""} ${mid(l.to)}`);
  }
  return lines.join("\n");
}

const SHAPE_IN: [RegExp, ItemKind][] = [
  [/^\[\((.*)\)\]$/, "database"],
  [/^\[\[(.*)\]\]$/, "queue"],
  [/^\(\((.*)\)\)$/, "user"],
  [/^\{\{(.*)\}\}$/, "api"],
  [/^\[\/(.*)\/\]$/, "client"],
  [/^\(\[(.*)\]\)$/, "function"],
  [/^>(.*)\]$/, "external"],
  [/^\{(.*)\}$/, "api"],
  [/^\((.*)\)$/, "service"],
  [/^\[(.*)\]$/, "service"],
];

/** A kind guessed from a node's words when its shape says nothing: "Postgres" is a database. */
function guess(label: string, kind: ItemKind): ItemKind {
  if (kind !== "service") return kind;
  const l = label.toLowerCase();
  if (/\b(db|database|postgres|mysql|mongo|dynamo|sql|warehouse)\b/.test(l)) return "database";
  if (/\b(queue|kafka|bus|sqs|rabbit|stream|topic|pubsub)\b/.test(l)) return "queue";
  if (/\b(cache|redis|memcache)\b/.test(l)) return "cache";
  if (/\b(user|customer|admin|actor)\b/.test(l)) return "user";
  if (/\b(web|mobile|app|browser|client|ui|frontend)\b/.test(l)) return "client";
  if (/\b(gateway|api)\b/.test(l)) return "api";
  if (/\b(s3|bucket|storage|blob|lake)\b/.test(l)) return "storage";
  if (/\b(lambda|function|worker|job|cron)\b/.test(l)) return "function";
  return kind;
}

/**
 * A Mermaid flowchart as items and links, laid out by its links around
 * `center`. Subgraphs become frames round what's in them.
 */
export function fromMermaid(text: string, center: Vec3 = [0, 0, 0]): { items: Item[]; links: Link[] } {
  const nodes = new Map<string, { label: string; kind: ItemKind }>();
  const edges: { from: string; to: string; label?: string; style?: LinkStyle; both?: boolean }[] = [];
  const groups: { label: string; members: string[] }[] = [];
  let group: { label: string; members: string[] } | null = null;
  const NODE = /([A-Za-z_][\w-]*)\s*((?:\[\(|\[\[|\(\(|\{\{|\[\/|\(\[|>|\[|\(|\{)[^]*?(?:\)\]|\]\]|\)\)|\}\}|\/\]|\]\)|\]|\)|\}))?/y;

  const readNode = (s: string, at: number): { id: string; end: number } | null => {
    NODE.lastIndex = at;
    const m = NODE.exec(s);
    if (!m) return null;
    const id = m[1];
    if (m[2]) {
      for (const [re, kind] of SHAPE_IN) {
        const mm = m[2].match(re);
        if (mm) {
          const label = mm[1].replace(/^"|"$/g, "").trim();
          nodes.set(id, { label, kind: guess(label, kind) });
          break;
        }
      }
    } else if (!nodes.has(id)) nodes.set(id, { label: id, kind: guess(id, "service") });
    group?.members.push(id);
    return { id, end: NODE.lastIndex };
  };

  for (const raw of text.split(/\n|;/)) {
    const line = raw.trim();
    if (!line || /^(flowchart|graph)\b/i.test(line) || line.startsWith("%%") || /^(classDef|class|style|linkStyle|click)\b/.test(line)) continue;
    const sg = line.match(/^subgraph\s+(?:([\w-]+)\s*\[\s*"?([^\]"]*)"?\s*\]|"?([^"]+)"?)/);
    if (sg) {
      group = { label: (sg[2] ?? sg[3] ?? sg[1] ?? "Group").trim(), members: [] };
      groups.push(group);
      continue;
    }
    if (line === "end") {
      group = null;
      continue;
    }
    // A chain: node (arrow node)*
    let at = 0;
    let prev = readNode(line, 0);
    if (!prev) continue;
    at = prev.end;
    for (;;) {
      const rest = line.slice(at);
      const arrow = rest.match(/^\s*(<)?(-->|==>|-\.->|---|-\.-|===|--\s*([^-|>]+?)\s*-->)(?:\|"?([^|"]*)"?\|)?\s*/);
      if (!arrow) break;
      const next = readNode(line, at + arrow[0].length);
      if (!next) break;
      const op = arrow[2];
      edges.push({
        from: prev.id,
        to: next.id,
        label: (arrow[4] ?? arrow[3] ?? "").trim() || undefined,
        style: op.startsWith("-.") ? "async" : op.startsWith("==") ? "data" : op === "---" ? "depends" : undefined,
        both: !!arrow[1],
      });
      prev = next;
      at = next.end;
    }
  }

  const ids = new Map<string, string>();
  const items: Item[] = [...nodes].map(([k, n]) => {
    const id = newId();
    ids.set(k, id);
    return { ...defaultsFor(n.kind), id, kind: n.kind, label: n.label, pos: [0, 0, 0] } as Item;
  });
  const links: Link[] = edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ id: newId("l"), from: ids.get(e.from)!, to: ids.get(e.to)!, ...(e.label ? { label: e.label } : {}), ...(e.style ? { style: e.style } : {}), ...(e.both ? { both: true } : {}) }));
  const tmp: Board = { id: "tmp", name: "", items, links, createdAt: 0, updatedAt: 0, rev: 0 };
  for (const [id, pos] of arrange(tmp, items.map((i) => i.id), "flow", { center })) {
    const it = items.find((i) => i.id === id);
    if (it) it.pos = pos;
  }
  // Frames round each subgraph's members, as they landed.
  for (const g of groups) {
    const members = g.members.map((m) => items.find((i) => i.id === ids.get(m))).filter((i): i is Item => !!i);
    if (!members.length) continue;
    const xs = members.map((m) => m.pos[0]);
    const zs = members.map((m) => m.pos[2]);
    const pad = 0.14;
    items.push({
      ...defaultsFor("frame"),
      id: newId(),
      kind: "frame",
      label: g.label,
      size: [Math.max(0.3, Math.max(...xs) - Math.min(...xs) + pad * 2), Math.max(0.3, Math.max(...zs) - Math.min(...zs) + pad * 2)],
      pos: [(Math.max(...xs) + Math.min(...xs)) / 2, 0, (Math.max(...zs) + Math.min(...zs)) / 2],
    } as Item);
  }
  return { items, links };
}

/* -------------------------------- markdown ------------------------------- */

/** The board as a design doc: components by group, how they connect, the decisions, the open issues. */
export function toMarkdown(b: Board): string {
  const byId = new Map(b.items.map((i) => [i.id, i]));
  const blocks = b.items.filter((i) => !["note", "text", "frame", "ink"].includes(i.kind));
  const frames = b.items.filter((i) => i.kind === "frame");
  const notes = b.items.filter((i) => i.kind === "note");
  const out: string[] = [`# ${b.name}`, "", `_${blocks.length} components, ${b.links.length} connections · exported from the workshop ${new Date().toISOString().slice(0, 10)}_`, ""];
  const row = (i: Item) => {
    const pinned = notes.filter((n) => n.attach === i.id).map((n) => (n.body ?? "").replace(/\n/g, " "));
    return `| ${nameOf(i)} | ${i.kind} | ${i.status ?? ""} | ${(i.tags ?? []).join(", ")} | ${(i.metrics ?? []).map((m) => `${m.label} ${m.value}${m.unit ?? ""}`).join(", ")} | ${pinned.join(" · ")} |`;
  };
  const table = (list: Item[]) => ["| Component | Kind | Status | Tags | Metrics | Notes |", "| --- | --- | --- | --- | --- | --- |", ...list.map(row), ""];
  const placed = new Set<string>();
  if (frames.length) {
    out.push("## Components", "");
    for (const f of frames) {
      const inside = inFrame(f, blocks).filter((i) => !placed.has(i.id));
      if (!inside.length) continue;
      inside.forEach((i) => placed.add(i.id));
      out.push(`### ${f.label ?? "Group"}`, "", ...table(inside));
    }
    const rest = blocks.filter((i) => !placed.has(i.id));
    if (rest.length) out.push("### Other", "", ...table(rest));
  } else if (blocks.length) out.push("## Components", "", ...table(blocks));
  if (b.links.length) {
    out.push("## Connections", "");
    for (const l of b.links) {
      const a = byId.get(l.from);
      const c = byId.get(l.to);
      if (a && c) out.push(`- **${nameOf(a)}** ${l.both ? "↔" : "→"} **${nameOf(c)}**${l.label ? ` — ${l.label}` : ""}${l.style && l.style !== "sync" ? ` _(${l.style})_` : ""}`);
    }
    out.push("");
  }
  const loose = notes.filter((n) => !n.attach);
  if (loose.length) {
    out.push("## Notes and decisions", "");
    for (const n of loose) out.push(`- ${n.label ? `**${n.label}**: ` : ""}${(n.body ?? "").replace(/\n/g, " ")}`);
    out.push("");
  }
  const flagged = b.items.filter((i) => i.flags?.length);
  if (flagged.length) {
    out.push("## Review findings", "");
    for (const i of flagged) for (const f of i.flags!) out.push(`- ${f.level === "risk" ? "🔴" : f.level === "warn" ? "🟠" : "🔵"} **${nameOf(i)}**: ${f.text}`);
    out.push("");
  }
  out.push("## Diagram", "", "```mermaid", toMermaid(b), "```", "");
  return out.join("\n");
}

/* ---------------------------------- json --------------------------------- */

/** Items and the links among them, as a clipboard or a file carries them. */
export function toClip(b: Board, ids?: string[]): string {
  const set = new Set(ids ?? b.items.map((i) => i.id));
  return JSON.stringify({ workshop: 1, items: b.items.filter((i) => set.has(i.id)), links: b.links.filter((l) => set.has(l.from) && set.has(l.to)) });
}

/** Back from a clipboard or file: fresh ids, moved so they centre on `center`. Null if it isn't one. */
export function fromClip(text: string, center: Vec3 | null): { items: Item[]; links: Link[] } | null {
  let j: { workshop?: number; items?: Item[]; links?: Link[] };
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.items)) return null;
  const ids = new Map<string, string>();
  for (const i of j.items) ids.set(i.id, newId());
  const xs = j.items.map((i) => i.pos?.[0] ?? 0);
  const zs = j.items.map((i) => i.pos?.[2] ?? 0);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const dx = center ? center[0] - cx : 0.12;
  const dz = center ? center[2] - cz : 0.06;
  const items = j.items.map((i) => ({ ...i, id: ids.get(i.id)!, pos: [r(i.pos[0] + dx), i.pos[1], r(i.pos[2] + dz)] as Vec3, attach: i.attach && ids.has(i.attach) ? ids.get(i.attach) : undefined, sub: undefined }));
  const links = (j.links ?? []).filter((l) => ids.has(l.from) && ids.has(l.to)).map((l) => ({ ...l, id: newId("l"), from: ids.get(l.from)!, to: ids.get(l.to)! }));
  return { items, links };
}

const r = (n: number) => Math.round(n * 1000) / 1000;
