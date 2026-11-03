import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flatTree, pathTo, type BoardNode, type ProjectSummary } from "../../shared/project";
import { api, goBoard, goCode, nav, navigate, onNav, reloadProject } from "./nav";
import "./shell.css";

/**
 * The project's bar, at the top left of both views: which project, and its
 * two kinds of view — Code (one of its repos) and Boards. The project's name
 * opens the drawer: its repos, its boards as a tree of folders, and the
 * other projects.
 */

/** Re-render on any move around the app (the project reloaded, the route changed). */
export function useNav() {
  return useSyncExternalStore(onNav, () => `${location.pathname}${location.search}|${nav.detail ? JSON.stringify(nav.detail).length : 0}|${nav.detail?.project.updatedAt}|${nav.openRepo?.root}`);
}

export function ProjectBar({ view, boardId, onRepo }: { view: "code" | "board"; boardId?: string; onRepo?: () => void }) {
  useNav();
  const [open, setOpen] = useState(false);
  const d = nav.detail;
  const p = d?.project;
  const repo = p?.repos.find((r) => r.root === p.activeRepo) ?? p?.repos[0];
  const trail = d && boardId ? pathTo(d.tree, boardId) : [];
  return (
    <>
      <div className="pb-bar" data-view={view}>
        <button className="pb-project" onClick={() => setOpen(true)} title="The project: its repos, its boards, other projects">
          <span className="pb-diamond">◆</span>
          <span className="pb-name">{p?.name ?? "…"}</span>
          <span className="pb-caret">▾</span>
        </button>
        <div className="pb-tabs" role="tablist">
          <button role="tab" aria-selected={view === "code"} className="pb-tab" onClick={() => view !== "code" && goCode({}, { transition: "Code" })} title="The Code view: the 3D map of the project's repo">
            <span className="pb-icon">⌥</span> Code{repo ? <span className="pb-sub">{repo.name}</span> : null}
          </button>
          <button role="tab" aria-selected={view === "board"} className="pb-tab" onClick={() => (view !== "board" ? goBoard(undefined, undefined, { transition: "Boards" }) : setOpen(true))} title="The project's boards">
            <span className="pb-icon">▣</span> Boards
            {view === "board" && trail.length > 1 ? <span className="pb-sub">{trail[0].name}</span> : null}
          </button>
        </div>
      </div>
      {open && <ProjectDrawer view={view} boardId={boardId} onClose={() => setOpen(false)} onRepo={onRepo} />}
    </>
  );
}

function ProjectDrawer({ view, boardId, onClose, onRepo }: { view: "code" | "board"; boardId?: string; onClose: () => void; onRepo?: () => void }) {
  useNav();
  const d = nav.detail;
  const p = d?.project;
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [repoInput, setRepoInput] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [library, setLibrary] = useState(false);
  useEffect(() => {
    void api<{ projects: ProjectSummary[] }>("/api/projects").then((r) => setProjects(r.projects)).catch(() => {});
    void api<{ library: boolean }>("/api/repo").then((r) => setLibrary(r.library)).catch(() => {});
    void reloadProject();
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!p || !d) return null;

  const change = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await api("/api/project", { id: p.id, ...body });
      await reloadProject();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  return (
    <div className="pb-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="pb-drawer" aria-label="Project">
        <header className="pb-head">
          <span className="pb-diamond">◆</span>
          {renaming ? (
            <input
              className="pb-input pb-title-input"
              autoFocus
              defaultValue={p.name}
              onBlur={(e) => (setRenaming(false), e.target.value.trim() && e.target.value !== p.name && void change({ action: "rename", name: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button className="pb-title" onClick={() => setRenaming(true)} title="Rename the project">
              {p.name}
            </button>
          )}
          <button className="pb-x" onClick={onClose} title="Close (Esc)">
            ×
          </button>
        </header>

        <section className="pb-section">
          <div className="pb-label">
            Code <span className="pb-hint">one repo at a time</span>
          </div>
          {p.repos.map((r) => {
            const active = r.root === (p.activeRepo ?? p.repos[0]?.root);
            return (
              <div key={r.root} className={`pb-row ${active && view === "code" ? "pb-current" : ""}`}>
                <button
                  className="pb-row-main"
                  title={r.root}
                  onClick={() => {
                    onClose();
                    goCode({ root: r.root }, { transition: r.name });
                  }}
                >
                  <span className="pb-icon">⌥</span>
                  <span className="pb-row-name">{r.github ?? r.name}</span>
                  {active && <span className="pb-dot" title="The repo the Code view shows" />}
                </button>
                <button className="pb-act" title="Unlink from the project (the repo itself stays)" onClick={() => confirm(`Unlink ${r.name} from ${p.name}?`) && void change({ action: "remove-repo", root: r.root })}>
                  ×
                </button>
              </div>
            );
          })}
          <form
            className="pb-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!repoInput.trim()) return;
              void change({ action: "add-repo", repo: repoInput }).then((ok) => ok && setRepoInput(""));
            }}
          >
            <input className="pb-input" value={repoInput} onChange={(e) => setRepoInput(e.target.value)} placeholder={library ? "Link a repo: owner/name or a GitHub link" : "Link a repo: a folder on the server"} />
            <button className="pb-btn" type="submit">
              Link
            </button>
          </form>
          {onRepo && (
            <button className="pb-link" onClick={() => (onClose(), onRepo())}>
              Open another GitHub repo…
            </button>
          )}
        </section>

        <BoardsTree tree={d.tree} current={view === "board" ? boardId : undefined} projectId={p.id} onClose={onClose} setError={setError} />

        {error && <p className="pb-error">{error}</p>}

        <section className="pb-section pb-projects">
          <div className="pb-label">
            Projects
            <button className="pb-link pb-right" onClick={() => (onClose(), navigate("/projects"))}>
              All projects ↗
            </button>
          </div>
          {projects
            .filter((x) => x.id !== p.id)
            .slice(0, 6)
            .map((x) => (
              <button key={x.id} className="pb-row pb-row-main" onClick={() => (onClose(), navigate(`/p/${x.id}`))}>
                <span className="pb-diamond pb-dim">◆</span>
                <span className="pb-row-name">{x.name}</span>
                <span className="pb-count">{x.repos.length} repo{x.repos.length === 1 ? "" : "s"} · {x.boards} board{x.boards === 1 ? "" : "s"}</span>
              </button>
            ))}
        </section>
        <p className="pb-foot">On a board, say or type “show me the code of this”: the Code view opens on it. From the code, “where is this on the board?”</p>
      </aside>
    </div>
  );
}

function BoardsTree({ tree, current, projectId, onClose, setError }: { tree: BoardNode[]; current?: string; projectId: string; onClose: () => void; setError: (e: string | null) => void }) {
  const trail = current ? pathTo(tree, current).map((n) => n.id) : [];
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const create = async (name: string, parent?: string) => {
    try {
      const b = await api<{ id: string }>("/api/boards", { name, project: projectId, ...(parent ? { parent } : {}) });
      await reloadProject();
      onClose();
      goBoard(b.id);
    } catch (e) {
      setError(String(e));
    }
  };
  const move = async (id: string, parent: string | null) => {
    if (id === parent) return;
    await api("/api/board/move", { id, parent }).catch((e) => setError(String(e)));
    await reloadProject();
  };
  const rename = async (id: string, name: string) => {
    await api("/api/board/ops", { id, ops: [{ op: "rename", name }] }).catch((e) => setError(String(e)));
    await reloadProject();
  };
  const remove = async (n: BoardNode) => {
    const nested = flatTree(n.children).length;
    if (!confirm(`Delete "${n.name}"${nested ? ` and the ${nested} board${nested === 1 ? "" : "s"} under it` : ""}? This can't be undone.`)) return;
    await fetch(`/api/boards?id=${encodeURIComponent(n.id)}`, { method: "DELETE" });
    await reloadProject();
    if (n.id === current || flatTree(n.children).some((x) => x.node.id === current)) goBoard(n.parent);
  };

  const row = (n: BoardNode, depth: number): React.ReactNode => {
    const kids = n.children.length > 0;
    const isShut = shut.has(n.id) && !trail.includes(n.id);
    const short = n.name.split("›").pop()!.trim();
    return (
      <div key={n.id}>
        <div
          className={`pb-row pb-tree-row ${n.id === current ? "pb-current" : ""} ${over === n.id ? "pb-over" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={renaming !== n.id}
          onDragStart={(e) => {
            drag.current = n.id;
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (!drag.current || drag.current === n.id) return;
            e.preventDefault();
            setOver(n.id);
          }}
          onDragLeave={() => setOver((o) => (o === n.id ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            if (drag.current) void move(drag.current, n.id);
            drag.current = null;
          }}
        >
          <button className="pb-twisty" onClick={() => setShut((s) => (s.has(n.id) ? (s.delete(n.id), new Set(s)) : new Set(s).add(n.id)))} style={{ visibility: kids ? "visible" : "hidden" }}>
            {isShut ? "▸" : "▾"}
          </button>
          {renaming === n.id ? (
            <input
              className="pb-input"
              autoFocus
              defaultValue={short}
              onBlur={(e) => (setRenaming(null), e.target.value.trim() && e.target.value !== short && void rename(n.id, e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button className="pb-row-main" onClick={() => (onClose(), goBoard(n.id))} title={n.itemId ? "The inside of an item on the board above" : depth ? "A board under the one above" : "A top-level board"}>
              <span className="pb-icon">{n.itemId ? "◈" : depth ? "▣" : "▤"}</span>
              <span className="pb-row-name">{short}</span>
              <span className="pb-count">
                {n.items}
                {n.linked ? <span title={`${n.linked} linked to code`}> · ⌥{n.linked}</span> : null}
              </span>
            </button>
          )}
          <span className="pb-acts">
            <button className="pb-act" title="A board under this one" onClick={() => setAdding(n.id)}>
              +
            </button>
            <button className="pb-act" title="Rename" onClick={() => setRenaming(n.id)}>
              ✎
            </button>
            {depth > 0 && (
              <button className="pb-act" title="Move to the top level" onClick={() => void move(n.id, null)}>
                ⤒
              </button>
            )}
            <button className="pb-act pb-danger" title="Delete" onClick={() => void remove(n)}>
              ×
            </button>
          </span>
        </div>
        {adding === n.id && <NewBoard depth={depth + 1} onDone={(name) => (setAdding(null), name && void create(name, n.id))} />}
        {!isShut && n.children.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  return (
    <section
      className={`pb-section ${over === "top" ? "pb-over" : ""}`}
      onDragOver={(e) => {
        if (drag.current && (e.target as HTMLElement).closest(".pb-label")) {
          e.preventDefault();
          setOver("top");
        }
      }}
      onDrop={(e) => {
        if (over !== "top" || !drag.current) return;
        e.preventDefault();
        setOver(null);
        void move(drag.current, null);
        drag.current = null;
      }}
    >
      <div className="pb-label">
        Boards <span className="pb-hint">drag one onto another to nest it</span>
        <button className="pb-link pb-right" onClick={() => setAdding("top")}>
          + New board
        </button>
      </div>
      {adding === "top" && <NewBoard depth={0} onDone={(name) => (setAdding(null), name && void create(name))} />}
      {tree.length ? tree.map((n) => row(n, 0)) : <p className="pb-empty">No boards yet. Start one for the architecture, the deployments, the roadmap…</p>}
    </section>
  );
}

function NewBoard({ depth, onDone }: { depth: number; onDone: (name: string | null) => void }) {
  return (
    <form
      className="pb-add"
      style={{ paddingLeft: 6 + depth * 14 }}
      onSubmit={(e) => {
        e.preventDefault();
        onDone(((e.currentTarget.elements.namedItem("n") as HTMLInputElement).value || "").trim() || null);
      }}
    >
      <input name="n" className="pb-input" autoFocus placeholder={depth ? "Name (e.g. Payments, Staging)" : "Name (e.g. Architecture, Deployments)"} onKeyDown={(e) => e.key === "Escape" && onDone(null)} onBlur={(e) => !e.target.value && onDone(null)} />
      <button className="pb-btn" type="submit">
        Add
      </button>
    </form>
  );
}
