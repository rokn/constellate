import { boardUrl, codeUrl, type CodeLink, type ProjectDetail } from "../../shared/project";

/**
 * Moving around the app without reloading it: the views call these, the
 * shell listens. Kept outside React so the code map and the workshop (which
 * hold most of their state in refs) can call them from anywhere.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

export const nav = {
  /** The project on screen (the shell sets it). */
  projectId: undefined as string | undefined,
  detail: null as ProjectDetail | null,
  /** A short scene change while the page switches views ("Expanding Payments into code"). */
  transition: null as { text: string; at: number } | null,
  /** The tab opened a repo itself (Switch repo, the start page): it joins the project when it opens. */
  expectRepoUntil: 0,
  openRepo: null as { root: string; name: string } | null,
};

export function onNav(f: Listener) {
  listeners.add(f);
  return () => listeners.delete(f);
}
export const notify = () => listeners.forEach((f) => f());

export function navigate(url: string, o: { replace?: boolean; transition?: string } = {}) {
  if (o.transition) nav.transition = { text: o.transition, at: Date.now() };
  if (url !== location.pathname + location.search) {
    if (o.replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }
  notify();
}

/** The Code view, on the code behind something (a board item's code link), or as it was. */
export function goCode(link: CodeLink = {}, o: { transition?: string } = {}) {
  if (!nav.projectId) return;
  navigate(codeUrl(nav.projectId, link), { transition: o.transition ?? (link.label ? `Expanding ${link.label} into code` : undefined) });
}

/** A board of the project (the last one open, when none is named), with an item on it in view. */
export function goBoard(boardId?: string, itemId?: string, o: { transition?: string } = {}) {
  if (!nav.projectId) return;
  const id = boardId ?? lastBoard(nav.projectId) ?? nav.detail?.tree[0]?.id;
  navigate(id ? boardUrl(nav.projectId, id, itemId) : `/p/${nav.projectId}/board`, o);
}

/** The repo the code map has open now (it reports it): the Code view keeps the project in step. */
export function reportRepo(root: string, name: string) {
  if (nav.openRepo?.root === root) return;
  nav.openRepo = { root, name };
  notify();
}

/** They're opening a repo from this tab: when it opens, it joins the project. */
export function expectRepo() {
  nav.expectRepoUntil = Date.now() + 5 * 60_000;
}

/* --------------------------- remembered places --------------------------- */

const LAST = "constellate.last";
type Last = { project?: string; boards?: Record<string, string>; views?: Record<string, "code" | "board"> };
function readLast(): Last {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? "{}") as Last;
  } catch {
    return {};
  }
}
function writeLast(f: (l: Last) => void) {
  try {
    const l = readLast();
    f(l);
    localStorage.setItem(LAST, JSON.stringify(l));
  } catch {
    /* private window: nothing remembered */
  }
}
export const lastProject = () => readLast().project;
export const lastBoard = (pid: string) => readLast().boards?.[pid];
export const lastView = (pid: string) => readLast().views?.[pid];
export function remember(pid: string, view: "code" | "board", boardId?: string) {
  writeLast((l) => {
    l.project = pid;
    l.views = { ...l.views, [pid]: view };
    if (boardId) l.boards = { ...l.boards, [pid]: boardId };
  });
}

export async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

/** The project on screen, fetched again (after a board was made, renamed, moved…). */
export async function reloadProject() {
  if (!nav.projectId) return;
  try {
    nav.detail = await api<ProjectDetail>(`/api/project?id=${encodeURIComponent(nav.projectId)}`);
    notify();
  } catch {
    /* it stays as it was */
  }
}
