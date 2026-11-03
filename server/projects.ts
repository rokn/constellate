import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId } from "../shared/board";
import { boardTree, type Project, type ProjectDetail, type ProjectRepo, type ProjectSummary } from "../shared/project";
import { assignProject, createBoard, deleteBoard, listBoards } from "./board/store";
import { REPOS_DIR, parseGitHub, rootOf } from "./library";
import { CACHE_DIR, session } from "./session";

/**
 * Projects (shared/project.ts), kept in one file under the cache. The first
 * time it runs, everything there was before projects moves into one: every
 * board, the repos they were drawn from, and the repo open in the code map.
 * A board that turns up without a project later (an old client made it)
 * joins the first one.
 */

const FILE = path.join(CACHE_DIR, "projects.json");
let projects: Project[] | null = null;
let saving: Promise<void> = Promise.resolve();

async function load(): Promise<Project[]> {
  if (projects) return projects;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Project[];
    projects = Array.isArray(raw) ? raw.filter((p) => p?.id && p.name) : [];
  } catch {
    projects = [];
  }
  return projects;
}

function persist() {
  const list = projects ?? [];
  saving = saving.then(async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(list, null, 1));
    await rename(tmp, FILE);
  });
  return saving.catch((e) => console.error("[projects] save failed:", e));
}

/** A repo as a project links it: from a folder on the server. */
export function repoAt(root: string, name?: string): ProjectRepo {
  const r = path.resolve(root);
  if (REPOS_DIR) {
    const rel = path.relative(REPOS_DIR, r).split(path.sep);
    const id = rel.length === 2 && !rel[0].startsWith("..") ? parseGitHub(rel.join("/")) : null;
    if (id) return { root: r, name: name ?? id.split("/")[1], github: id };
  }
  return { root: r, name: name ?? path.basename(r) };
}

/**
 * A repo as they gave it: a GitHub link or owner/name when the server keeps
 * clones, else a path on the server. Null when it can't be one here.
 */
export function repoFrom(input: string): ProjectRepo | null {
  const s = input.trim();
  if (!s) return null;
  if (REPOS_DIR) {
    // A clone it keeps, by its folder; anything else, as GitHub names it.
    if (path.isAbsolute(s)) {
      const r = repoAt(s);
      return r.github ? r : null;
    }
    const id = parseGitHub(s);
    return id ? { root: rootOf(id), name: id.split("/")[1], github: id } : null;
  }
  return repoAt(s.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
}

/** Everything from before projects, moved into the first one; boards without a project, into it. */
async function settle(): Promise<Project[]> {
  const list = await load();
  const boards = await listBoards();
  if (!list.length) {
    const repos = new Map<string, ProjectRepo>();
    const open = session.state.repo;
    if (open) repos.set(path.resolve(open.root), repoAt(open.root, open.name));
    for (const b of boards) if (b.repo && !repos.has(path.resolve(b.repo))) repos.set(path.resolve(b.repo), repoAt(b.repo));
    const now = Date.now();
    const first: Project = {
      id: newId("p"),
      name: open?.name ?? [...repos.values()][0]?.name ?? "My project",
      repos: [...repos.values()],
      activeRepo: open ? path.resolve(open.root) : [...repos.keys()][0],
      createdAt: now,
      updatedAt: now,
    };
    list.push(first);
    await persist();
  }
  const known = new Set(list.map((p) => p.id));
  for (const b of boards) if (!b.projectId || !known.has(b.projectId)) await assignProject(b.id, list[0].id);
  return list;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const list = await settle();
  const boards = await listBoards();
  return list
    .map((p) => ({ id: p.id, name: p.name, description: p.description, repos: p.repos, updatedAt: Math.max(p.updatedAt, ...boards.filter((b) => b.projectId === p.id).map((b) => b.updatedAt)), boards: boards.filter((b) => b.projectId === p.id).length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | null> {
  return (await settle()).find((p) => p.id === id) ?? null;
}

export async function projectDetail(id: string): Promise<ProjectDetail | null> {
  const project = await getProject(id);
  if (!project) return null;
  return { project, tree: boardTree(await listBoards(id)) };
}

/** The project a repo belongs to (the open one, most often): the most recent that links it. */
export async function projectOfRepo(root: string): Promise<Project | null> {
  const r = path.resolve(root);
  const list = await settle();
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt).find((p) => p.repos.some((x) => path.resolve(x.root) === r)) ?? null;
}

/** A new project, with the repos given (and a first board to draw on). */
export async function createProject(name: string, o: { description?: string; repos?: string[] } = {}): Promise<Project> {
  const list = await settle();
  const repos = (o.repos ?? []).map(repoFrom).filter((r): r is ProjectRepo => !!r);
  const now = Date.now();
  const p: Project = { id: newId("p"), name: name.trim().slice(0, 80) || "New project", description: o.description?.trim().slice(0, 400) || undefined, repos, activeRepo: repos[0]?.root, createdAt: now, updatedAt: now };
  list.push(p);
  await persist();
  await createBoard("Architecture", { projectId: p.id, repo: repos[0] ? { root: repos[0].root, name: repos[0].name } : undefined });
  return p;
}

type Change =
  | { action: "rename"; name: string }
  | { action: "describe"; description: string }
  | { action: "add-repo"; repo: string }
  | { action: "remove-repo"; root: string }
  | { action: "activate-repo"; root: string }
  | { action: "delete" };

/** Change a project. Returns it, or an error to show. */
export async function changeProject(id: string, c: Change): Promise<{ project?: Project; error?: string; deleted?: boolean }> {
  const list = await settle();
  const p = list.find((x) => x.id === id);
  if (!p) return { error: "No such project." };
  switch (c.action) {
    case "rename":
      p.name = c.name.trim().slice(0, 80) || p.name;
      break;
    case "describe":
      p.description = c.description.trim().slice(0, 400) || undefined;
      break;
    case "add-repo": {
      const r = repoFrom(c.repo);
      if (!r) return { error: REPOS_DIR ? "Give a GitHub repo: a link, or owner/name." : "Give a folder on the server." };
      if (!p.repos.some((x) => path.resolve(x.root) === r.root)) p.repos.push(r);
      p.activeRepo ??= r.root;
      break;
    }
    case "remove-repo": {
      const r = path.resolve(c.root);
      p.repos = p.repos.filter((x) => path.resolve(x.root) !== r);
      if (p.activeRepo && path.resolve(p.activeRepo) === r) p.activeRepo = p.repos[0]?.root;
      break;
    }
    case "activate-repo": {
      const r = path.resolve(c.root);
      // A repo reached from one of its boards joins it on the way.
      if (!p.repos.some((x) => path.resolve(x.root) === r)) p.repos.push(repoAt(r));
      p.activeRepo = r;
      break;
    }
    case "delete": {
      if (list.length === 1) return { error: "That's the only project." };
      for (const b of await listBoards(id)) if (!b.parent) await deleteBoard(b.id);
      projects = list.filter((x) => x !== p);
      await persist();
      return { deleted: true };
    }
  }
  p.updatedAt = Date.now();
  await persist();
  return { project: p };
}

/** A short account of a project for the voice and the agents: its repos and its boards, nested. */
export async function projectBrief(id: string | undefined, o: { boardId?: string; view?: string } = {}): Promise<string> {
  const d = id ? await projectDetail(id) : null;
  if (!d) return "";
  const lines: string[] = [];
  const walk = (nodes: ProjectDetail["tree"], depth: number) => {
    for (const n of nodes) {
      if (lines.length > 60) return;
      lines.push(`${"  ".repeat(depth + 1)}- "${n.name.split("›").pop()!.trim()}" (${n.items} items${n.itemId ? ", inside an item" : ""}${n.linked ? `, ${n.linked} linked to code` : ""})${n.id === o.boardId ? " ← open" : ""}`);
      walk(n.children, depth + 1);
    }
  };
  walk(d.tree, 0);
  const open = session.state.repo?.root;
  return [
    `Project "${d.project.name}"${d.project.description ? ` — ${d.project.description}` : ""}.`,
    d.project.repos.length
      ? `Its repos (the Code view shows one at a time): ${d.project.repos.map((r) => `${r.name}${open && path.resolve(open) === path.resolve(r.root) ? " (open in the Code view)" : ""}`).join(", ")}.`
      : "It has no repos linked yet.",
    lines.length ? `Its boards, nested like folders:\n${lines.join("\n")}` : "It has no boards yet.",
  ].join("\n");
}
