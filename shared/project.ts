import type { BoardSummary } from "./board";

/**
 * Projects: one hat over the code map and the workshop. A project links any
 * number of repos (the Code view shows one of them at a time) and holds a
 * tree of boards, like folders: the top level for the big subjects
 * (architecture, deployments, the roadmap…), and under each the boards
 * nested in it, whether drawn inside one of its items or filed under it.
 */

/** A repo linked to a project: its folder on the server, and how it's known. */
export type ProjectRepo = {
  root: string;
  name: string;
  /** "owner/name", when the server keeps GitHub clones (CODEFLIGHT_REPOS_DIR). */
  github?: string;
};

export type Project = {
  id: string;
  name: string;
  description?: string;
  repos: ProjectRepo[];
  /** The repo the Code view shows (a root of one of `repos`). */
  activeRepo?: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectSummary = Pick<Project, "id" | "name" | "description" | "repos" | "updatedAt"> & { boards: number };

/** A board in a project's tree, with the boards nested under it. */
export type BoardNode = BoardSummary & { children: BoardNode[] };

/** A project with its boards as a tree (top level first, most recent first). */
export type ProjectDetail = { project: Project; tree: BoardNode[] };

/** The tree of a project's boards from their summaries: a board whose parent isn't there stands at the top. */
export function boardTree(list: BoardSummary[]): BoardNode[] {
  const nodes = new Map<string, BoardNode>(list.map((b) => [b.id, { ...b, children: [] }]));
  const top: BoardNode[] = [];
  for (const n of nodes.values()) {
    const p = n.parent ? nodes.get(n.parent) : undefined;
    if (p && p !== n) p.children.push(n);
    else top.push(n);
  }
  const order = (a: BoardNode[]) => {
    // Top-level boards keep the order they were made in (they're the folders); nested ones too.
    a.sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0) || x.name.localeCompare(y.name));
    for (const n of a) order(n.children);
  };
  order(top);
  return top;
}

/** Every board in a tree, depth first, with its depth. */
export function flatTree(tree: BoardNode[], depth = 0, out: { node: BoardNode; depth: number }[] = []) {
  for (const n of tree) {
    out.push({ node: n, depth });
    flatTree(n.children, depth + 1, out);
  }
  return out;
}

/** A board's path from the top of the tree: [top, …, it]. */
export function pathTo(tree: BoardNode[], id: string): BoardNode[] {
  for (const n of tree) {
    if (n.id === id) return [n];
    const sub = pathTo(n.children, id);
    if (sub.length) return [n, ...sub];
  }
  return [];
}

/** A board found by name as said: exact, then starting with it, then containing it. */
export function findBoardByName(tree: BoardNode[], said: string): BoardNode | undefined {
  const all = flatTree(tree).map((x) => x.node);
  const n = said.trim().toLowerCase();
  if (!n) return undefined;
  return all.find((b) => b.name.toLowerCase() === n) ?? all.find((b) => lastPart(b.name) === n) ?? all.find((b) => b.name.toLowerCase().startsWith(n)) ?? all.find((b) => b.name.toLowerCase().includes(n));
}
const lastPart = (name: string) => name.split("›").pop()!.trim().toLowerCase();

/* ------------------------------- addresses ------------------------------ */

/** Where a code link leads: a repo (root), a module or paths in it, and whether to show only that code. */
export type CodeLink = {
  root?: string;
  module?: string;
  paths?: string[];
  /** Show only this code on the map (a filter), not just fly to it. */
  only?: boolean;
  /** What it's called on the board: the filter's name. */
  label?: string;
  /** The board item it came from, for the way back. */
  from?: { boardId: string; itemId?: string };
  /** No code link to follow: ask the navigator this instead (it finds the code and shows it). */
  ask?: string;
};

export const projectHome = (pid: string) => `/p/${pid}`;
export const boardUrl = (pid: string, boardId: string, itemId?: string) => `/p/${pid}/board/${boardId}${itemId ? `?item=${encodeURIComponent(itemId)}` : ""}`;

export function codeUrl(pid: string, l: CodeLink = {}) {
  const q = new URLSearchParams();
  if (l.root) q.set("root", l.root);
  if (l.module) q.set("module", l.module);
  if (l.paths?.length) q.set("paths", l.paths.join(","));
  if (l.only) q.set("only", "1");
  if (l.label) q.set("label", l.label);
  if (l.ask) q.set("ask", l.ask);
  if (l.from) q.set("from", `${l.from.boardId}${l.from.itemId ? `:${l.from.itemId}` : ""}`);
  const s = q.toString();
  return `/p/${pid}/code${s ? `?${s}` : ""}`;
}

/** The app's address, read: which project, and which view. */
export type Route =
  | { kind: "projects" }
  | { kind: "home" }
  | { kind: "project"; pid: string }
  | { kind: "code"; pid: string }
  | { kind: "board"; pid: string; boardId?: string }
  /** An address from before projects: a board by id, or the code map. */
  | { kind: "legacy-board"; boardId?: string }
  | { kind: "legacy-code" };

export function parseRoute(pathname: string, search = ""): Route {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/projects") return { kind: "projects" };
  let m = /^\/p\/([\w-]+)\/code$/.exec(p);
  if (m) return { kind: "code", pid: m[1] };
  m = /^\/p\/([\w-]+)\/board(?:\/([\w-]+))?$/.exec(p);
  if (m) return { kind: "board", pid: m[1], boardId: m[2] };
  m = /^\/p\/([\w-]+)$/.exec(p);
  if (m) return { kind: "project", pid: m[1] };
  m = /^\/board(?:\/([\w-]+))?$/.exec(p);
  if (m) return { kind: "legacy-board", boardId: m[1] };
  if (p === "/" && search && search !== "?") return { kind: "legacy-code" };
  return { kind: "home" };
}
