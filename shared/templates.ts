import { defaultsFor, newId, type Item, type ItemKind, type Link, type LinkStyle, type Vec3 } from "./board";

/**
 * Starting points: a whole board laid out in one go, around a point on the
 * table. Every template is a list of items (by a local name) and the links
 * between them; ids are made fresh each time, so one can be laid out twice.
 */

type T = { name: string; about: string; items: [string, ItemKind, Partial<Item> & { at: [number, number] }][]; links?: [string, string, string?, LinkStyle?][] };

const note = (body: string, color = "gold"): Partial<Item> => ({ body, color, size: [0.2, 0.13] });

const TEMPLATES: T[] = [
  {
    name: "Microservices",
    about: "Clients, a gateway, three services with their own databases, and an event bus",
    items: [
      ["fe", "frame", { label: "Clients", size: [0.9, 0.3], at: [0, -0.75] }],
      ["web", "client", { label: "Web app", at: [-0.22, -0.75] }],
      ["mob", "client", { label: "Mobile app", at: [0.22, -0.75] }],
      ["gw", "api", { label: "API gateway", at: [0, -0.38] }],
      ["fs", "frame", { label: "Services", size: [1.3, 0.75], at: [0, 0.15] }],
      ["a", "service", { label: "Users", at: [-0.42, 0] }],
      ["b", "service", { label: "Orders", at: [0, 0] }],
      ["c", "service", { label: "Billing", at: [0.42, 0] }],
      ["da", "database", { label: "Users DB", at: [-0.42, 0.32] }],
      ["db", "database", { label: "Orders DB", at: [0, 0.32] }],
      ["dc", "database", { label: "Billing DB", at: [0.42, 0.32] }],
      ["bus", "queue", { label: "Event bus", at: [0, 0.68] }],
    ],
    links: [
      ["web", "gw", "HTTPS"],
      ["mob", "gw", "HTTPS"],
      ["gw", "a", "REST"],
      ["gw", "b", "REST"],
      ["gw", "c", "REST"],
      ["a", "da", "SQL", "data"],
      ["b", "db", "SQL", "data"],
      ["c", "dc", "SQL", "data"],
      ["b", "bus", "order.created", "async"],
      ["bus", "c", "order.created", "async"],
    ],
  },
  {
    name: "Event pipeline",
    about: "Sources into a stream, processed into a lake and a warehouse, out to dashboards",
    items: [
      ["s1", "external", { label: "Devices", at: [-0.6, -0.4] }],
      ["s2", "external", { label: "Apps", at: [-0.6, 0] }],
      ["s3", "external", { label: "Partners", at: [-0.6, 0.4] }],
      ["in", "queue", { label: "Ingest stream", at: [-0.25, 0] }],
      ["proc", "function", { label: "Stream processor", at: [0.1, 0] }],
      ["lake", "storage", { label: "Data lake", at: [0.45, -0.3] }],
      ["wh", "database", { label: "Warehouse", at: [0.45, 0.3] }],
      ["dash", "client", { label: "Dashboards", at: [0.8, 0.3] }],
    ],
    links: [
      ["s1", "in", "telemetry", "async"],
      ["s2", "in", "events", "async"],
      ["s3", "in", "webhooks", "async"],
      ["in", "proc", "", "data"],
      ["proc", "lake", "raw", "data"],
      ["proc", "wh", "modelled", "data"],
      ["wh", "dash", "SQL"],
    ],
  },
  {
    name: "Three-tier web app",
    about: "A user, the front end, an API, its service and data",
    items: [
      ["u", "user", { label: "User", at: [0, -0.7] }],
      ["cdn", "cloud", { label: "CDN", at: [0, -0.42] }],
      ["fe", "client", { label: "Front end", at: [0, -0.15] }],
      ["api", "api", { label: "API", at: [0, 0.12] }],
      ["svc", "service", { label: "App server", at: [0, 0.38] }],
      ["db", "database", { label: "Database", at: [-0.25, 0.68] }],
      ["cache", "cache", { label: "Cache", at: [0.25, 0.68] }],
    ],
    links: [
      ["u", "cdn", "HTTPS"],
      ["cdn", "fe"],
      ["fe", "api", "JSON"],
      ["api", "svc"],
      ["svc", "db", "SQL", "data"],
      ["svc", "cache", "get/set"],
    ],
  },
  {
    name: "Roadmap",
    about: "Three phases left to right, a goal and work in each",
    items: [
      ["p1", "frame", { label: "Phase 1 · Foundations", size: [0.75, 1], at: [-0.82, 0] }],
      ["p2", "frame", { label: "Phase 2 · Build", size: [0.75, 1], at: [0, 0] }],
      ["p3", "frame", { label: "Phase 3 · Launch", size: [0.75, 1], at: [0.82, 0] }],
      ["n1", "note", { ...note("Goal: …"), at: [-0.82, -0.25] }],
      ["n2", "note", { ...note("Work: …", "cyan"), at: [-0.82, 0.2] }],
      ["n3", "note", { ...note("Goal: …"), at: [0, -0.25] }],
      ["n4", "note", { ...note("Work: …", "cyan"), at: [0, 0.2] }],
      ["n5", "note", { ...note("Goal: …"), at: [0.82, -0.25] }],
      ["n6", "note", { ...note("Work: …", "cyan"), at: [0.82, 0.2] }],
    ],
    links: [
      ["n1", "n3", "", "depends"],
      ["n3", "n5", "", "depends"],
    ],
  },
  {
    name: "SWOT",
    about: "Strengths, weaknesses, opportunities, threats",
    items: [
      ["s", "frame", { label: "Strengths", color: "green", size: [0.8, 0.6], at: [-0.42, -0.32] }],
      ["w", "frame", { label: "Weaknesses", color: "amber", size: [0.8, 0.6], at: [0.42, -0.32] }],
      ["o", "frame", { label: "Opportunities", color: "cyan", size: [0.8, 0.6], at: [-0.42, 0.32] }],
      ["t", "frame", { label: "Threats", color: "red", size: [0.8, 0.6], at: [0.42, 0.32] }],
      ["sn", "note", { ...note("…", "green"), at: [-0.42, -0.3] }],
      ["wn", "note", { ...note("…", "amber"), at: [0.42, -0.3] }],
      ["on", "note", { ...note("…", "cyan"), at: [-0.42, 0.34] }],
      ["tn", "note", { ...note("…", "red"), at: [0.42, 0.34] }],
    ],
  },
  {
    name: "Kanban",
    about: "To do, doing, done",
    items: [
      ["a", "frame", { label: "To do", size: [0.6, 1.1], at: [-0.66, 0] }],
      ["b", "frame", { label: "Doing", color: "amber", size: [0.6, 1.1], at: [0, 0] }],
      ["c", "frame", { label: "Done", color: "green", size: [0.6, 1.1], at: [0.66, 0] }],
      ["a1", "note", { ...note("First task"), at: [-0.66, -0.3] }],
      ["a2", "note", { ...note("Second task"), at: [-0.66, 0.05] }],
      ["b1", "note", { ...note("In progress", "amber"), at: [0, -0.3] }],
      ["c1", "note", { ...note("Shipped", "green"), at: [0.66, -0.3] }],
    ],
  },
];

export const TEMPLATE_NAMES = TEMPLATES.map((t) => ({ name: t.name, about: t.about }));

/** Lay out a template around `center` (board space): fresh items and links, ready to add. */
export function layTemplate(name: string, center: Vec3 = [0, 0, 0]): { items: Item[]; links: Link[] } | null {
  const n = name.trim().toLowerCase();
  const t = TEMPLATES.find((x) => x.name.toLowerCase() === n) ?? TEMPLATES.find((x) => x.name.toLowerCase().includes(n));
  if (!t) return null;
  const ids = new Map<string, string>();
  const items: Item[] = t.items.map(([ref, kind, { at, ...rest }]) => {
    const id = newId();
    ids.set(ref, id);
    return { ...defaultsFor(kind), ...rest, id, kind, pos: [round(center[0] + at[0]), 0, round(center[2] + at[1])] } as Item;
  });
  const links: Link[] = (t.links ?? []).map(([from, to, label, style]) => ({ id: newId("l"), from: ids.get(from)!, to: ids.get(to)!, ...(label ? { label } : {}), ...(style ? { style } : {}) }));
  return { items, links };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
