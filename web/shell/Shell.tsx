import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { App } from "../App";
import { boardUrl, codeUrl, flatTree, keepViews, parseRoute, type KeptViews, type ProjectDetail, type ProjectSummary } from "../../shared/project";
import type { Board } from "../../shared/board";
import { api, goBoard, goCode, lastBoard, lastProject, lastView, nav, navigate, notify, remember, reloadProject } from "./nav";
import { ProjectBar, useNav } from "./ProjectBar";
import { ProjectsPage } from "./ProjectsPage";
import { setViewSwitcher, setVoiceProject, useVoiceApi, VoiceEngine } from "./voice";
import { LOG_KEY, setActiveView, useLogOpen, useViewActive, ViewActive, type ViewKind } from "./view";
import { TranscriptLog } from "../components/TranscriptLog";
import "./shell.css";

// Boards are their own bundle, loaded on the first visit to one.
const BoardApp = lazy(() => import("../board/BoardApp").then((m) => ({ default: m.BoardApp })));

/**
 * The app: projects, each with a Code view (the map of one of its repos)
 * and its boards. The address says where you are (/p/<project>/code,
 * /p/<project>/board/<board>); addresses from before projects (/, /board/…)
 * find their project and move there.
 *
 * The two views are one app, not two pages: once opened, a view stays
 * mounted, and switching shows the other one as it was left (web/shell/view.ts).
 * One voice and one transcript run above both.
 */
export function Shell() {
  useNav();
  useEffect(() => {
    const pop = () => notify();
    window.addEventListener("popstate", pop);
    // The voice (or the navigator) asked for the other view.
    setViewSwitcher((c) => (c.view === "board" ? goBoard(c.boardId, c.itemId, { transition: "Boards" }) : goCode(c.link ?? {}, { transition: c.link?.label ? undefined : "Code" })));
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const route = parseRoute(location.pathname, location.search);
  const pid = route.kind === "code" || route.kind === "board" || route.kind === "project" ? route.pid : undefined;

  // The project on screen: fetched when it changes.
  useEffect(() => {
    nav.projectId = pid;
    setVoiceProject(pid);
    if (!pid) return;
    if (nav.detail?.project.id !== pid) nav.detail = null;
    void reloadProject().then(() => {
      if (nav.projectId === pid && !nav.detail) navigate("/projects", { replace: true });
    });
  }, [pid]);

  // Addresses that need working out: home, a project, and the ones from before projects.
  useEffect(() => {
    let off = false;
    const go = (url: string) => !off && navigate(url, { replace: true });
    const pick = async (root?: string | null) => {
      const r = await api<{ projects: ProjectSummary[]; openIn: string | null }>("/api/projects");
      const byRoot = root ? r.projects.find((p) => p.repos.some((x) => x.root === root)) : undefined;
      const last = lastProject();
      return byRoot?.id ?? (last && r.projects.some((p) => p.id === last) ? last : undefined) ?? r.openIn ?? r.projects[0]?.id;
    };
    const home = (p: string) => (lastView(p) === "board" ? `/p/${p}/board` : `/p/${p}/code`);
    if (route.kind === "home") void pick().then((p) => go(p ? home(p) : "/projects"));
    else if (route.kind === "project") go(home(route.pid));
    else if (route.kind === "legacy-code") {
      // An old code map link (?root=…&module=…, ?story=…): the same, in the project that has its repo.
      const q = new URLSearchParams(location.search);
      void pick(q.get("root")).then((p) => go(p ? `/p/${p}/code${location.search}` : "/projects"));
    } else if (route.kind === "legacy-board") {
      void (async () => {
        await api("/api/projects"); // boards from before projects join one
        const b = route.boardId ? await api<Board>(`/api/board?id=${encodeURIComponent(route.boardId)}`).catch(() => null) : null;
        const p = b?.projectId ?? (await pick());
        go(p ? (b ? `/p/${p}/board/${b.id}${location.search}` : `/p/${p}/board`) : "/projects");
      })();
    }
    return () => {
      off = true;
    };
  }, [route.kind, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  // A board address without a board (or one that's gone): the last one, else the first, else a new one.
  const boardId = route.kind === "board" ? route.boardId : undefined;
  const detail = nav.detail?.project.id === pid ? nav.detail : null;
  useEffect(() => {
    if (route.kind !== "board" || !detail) return;
    const all = flatTree(detail.tree).map((x) => x.node.id);
    if (boardId && all.includes(boardId)) return;
    void (async () => {
      // A board opened from a link may be newer than the tree: check it's really gone.
      if (boardId && (await api<Board>(`/api/board?id=${encodeURIComponent(boardId)}`).catch(() => null))) return void reloadProject();
      const remembered = nav.projectId && lastBoard(nav.projectId);
      const id = (remembered && all.includes(remembered) ? remembered : undefined) ?? detail.tree[0]?.id ?? (await api<{ id: string }>("/api/boards", { name: "Architecture", project: detail.project.id })).id;
      await reloadProject();
      navigate(boardUrl(detail.project.id, id) + location.search, { replace: true });
    })();
  }, [route.kind, boardId, detail]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pid && (route.kind === "code" || (route.kind === "board" && boardId))) remember(pid, route.kind, boardId);
  }, [pid, route.kind, boardId]);

  // Which view is on screen, and which have been opened: those stay, as they were left.
  const boards = detail ? flatTree(detail.tree).map((x) => x.node.id) : undefined;
  const view: ViewKind | null = route.kind === "code" && detail ? "code" : route.kind === "board" && boardId && boards?.includes(boardId) ? "board" : null;
  const keptRef = useRef<KeptViews>({ code: false });
  const kept = (keptRef.current = keepViews(keptRef.current, { pid, view, boardId, boards }));
  setActiveView(view);

  return (
    <>
      {pid && detail && kept.code && (
        <View kind="code" on={view === "code"}>
          <CodeView key={`code:${pid}`} detail={detail} />
        </View>
      )}
      {pid && detail && kept.boardId && (
        <View kind="board" on={view === "board"}>
          <Suspense fallback={<Loading text="Powering up the board" />}>
            <BoardApp key={`board:${pid}`} projectId={pid} boardId={kept.boardId} />
          </Suspense>
        </View>
      )}
      {!view && (route.kind === "projects" ? <ProjectsPage /> : <Loading text="" />)}
      <VoiceEngine />
      {view && <Transcript />}
      <Warp />
    </>
  );
}

/** One of the project's views. Off screen it stays as it is: not drawn, not reachable, not listening. */
function View({ kind, on, children }: { kind: ViewKind; on: boolean; children: React.ReactNode }) {
  return (
    <div id={`view-${kind}`} className="shell-view" data-off={on ? undefined : ""} inert={!on} aria-hidden={!on}>
      <ViewActive.Provider value={on}>{children}</ViewActive.Provider>
    </div>
  );
}

/** The voice's transcript, over whichever view is on screen. */
function Transcript() {
  const [open, setOpen] = useLogOpen();
  const voice = useVoiceApi();
  if (!open || !voice) return null;
  return <TranscriptLog log={voice.log} heard={voice.heard} caption={voice.caption} onClear={voice.clearLog} onClose={() => setOpen(false)} storageKey={LOG_KEY} />;
}

function Loading({ text }: { text: string }) {
  return (
    <div className="shell-page">
      <div className="shell-center">{text && <p className="shell-meta"><span className="shell-spin" />{text}…</p>}</div>
    </div>
  );
}

/** A short scene change while the view switches: "Expanding Payments into code". */
function Warp() {
  useNav();
  const t = nav.transition;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => {
      if (nav.transition === t) nav.transition = null;
      tick((n) => n + 1);
    }, 1150);
    return () => clearTimeout(h);
  }, [t]);
  if (!t || Date.now() - t.at > 1150) return null;
  return (
    <div className="shell-warp" key={t.at}>
      <div className="shell-warp-ring" />
      <div className="shell-warp-text">{t.text}</div>
    </div>
  );
}

/* -------------------------------- code view ------------------------------- */

type RepoStatus = { root: string | null; name: string | null; status: string; error: string | null; library: boolean; locked: boolean };

/**
 * The Code view: the code map, on the project's repo. If the server has
 * another repo open, it opens this one first (and waits for it); a repo
 * opened from here (Switch repo, the start page) joins the project.
 */
function CodeView({ detail }: { detail: ProjectDetail }) {
  useNav();
  const p = detail.project;
  // The repo asked for: a link's (?root=), else the project's active one.
  const [want] = useState(() => new URLSearchParams(location.search).get("root") ?? p.activeRepo ?? p.repos[0]?.root ?? null);
  const [server, setServer] = useState<RepoStatus | null>(null);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!server && (!want || server.root === want);

  useEffect(() => {
    let off = false;
    const poll = async () => {
      const s = await api<RepoStatus>("/api/repo").catch(() => null);
      if (off) return;
      if (s) setServer(s);
      if (!s || (want && s.root !== want)) setTimeout(poll, 700);
    };
    void poll();
    return () => {
      off = true;
    };
  }, [want]);

  // Open the project's repo when another is open.
  useEffect(() => {
    if (!server || !want || server.root === want || asked) return;
    setAsked(true);
    if (p.activeRepo !== want) void api("/api/project", { id: p.id, action: "activate-repo", root: want }).then(reloadProject).catch(() => {});
    api("/api/open-root", { root: want }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [server, want, asked, p]);

  // The map opened another repo (Switch repo, the start page): it joins the project, and becomes the one shown.
  const open = nav.openRepo;
  useEffect(() => {
    if (!open || !ready) return;
    const linked = p.repos.some((r) => r.root === open.root);
    if (linked && p.activeRepo === open.root) return;
    if (!linked && Date.now() > nav.expectRepoUntil) return;
    nav.expectRepoUntil = 0;
    void api("/api/project", { id: p.id, action: "activate-repo", root: open.root })
      .then(reloadProject)
      .then(() => history.replaceState(history.state, "", codeUrl(p.id)))
      .catch(() => {});
  }, [open?.root, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back on screen: if the server has moved on to a repo that isn't this project's (another tab, another project), bring ours back.
  const active = useViewActive();
  const up = useRef(false);
  useEffect(() => {
    if (!active || !up.current || new URLSearchParams(location.search).get("root")) return;
    void api<RepoStatus>("/api/repo")
      .then((s) => {
        const ours = p.activeRepo ?? p.repos[0]?.root;
        if (ours && s.root && !p.repos.some((r) => r.root === s.root)) return api("/api/open-root", { root: ours });
      })
      .catch(() => {});
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!want) return <NoRepo detail={detail} server={server} />;
  // Once the map is up it stays: it follows the server to other repos itself.
  if (ready) up.current = true;
  if (up.current) return <App />;
  if (error)
    return (
      <Center>
        <p className="shell-card-title">Couldn't open {p.repos.find((r) => r.root === want)?.name ?? want}</p>
        <p className="shell-meta mt-2">{error}</p>
      </Center>
    );
  const name = p.repos.find((r) => r.root === want)?.name ?? want.split("/").pop();
  return (
    <Center>
      <p className="shell-meta">
        <span className="shell-spin" />
        Opening {name}…{server?.status === "error" && server.error ? ` (${server.error})` : ""}
      </p>
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell-page relative">
      <div className="absolute left-4 top-4 z-10">
        <ProjectBar view="code" />
      </div>
      <div className="shell-center">
        <div className="shell-panel">{children}</div>
      </div>
    </div>
  );
}

/** A project with no repo yet: link one (or the one the server has open). */
function NoRepo({ detail, server }: { detail: ProjectDetail; server: RepoStatus | null }) {
  const p = detail.project;
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const link = async (repo: string) => {
    setError(null);
    try {
      await api("/api/project", { id: p.id, action: "add-repo", repo });
      await reloadProject();
      location.replace(codeUrl(p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Center>
      <p className="shell-card-title">Link a repo to {p.name}</p>
      <p className="shell-meta mt-1">The Code view flies through one of the project's repos at a time; its boards can point into them.</p>
      <form
        className="pb-add mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) void link(input.trim());
        }}
      >
        <input className="pb-input" autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder={server?.library ? "owner/name, or a GitHub link" : "A folder on the server, e.g. ~/code/app"} />
        <button className="pb-btn pb-btn-primary" type="submit">
          Link
        </button>
      </form>
      {server?.root && (
        <button className="pb-link mt-2" onClick={() => void link(server.root!)}>
          Or link {server.name}, open in the code map now
        </button>
      )}
      {error && <p className="pb-error">{error}</p>}
    </Center>
  );
}
