import { useEffect, useState } from "react";
import type { Project, ProjectSummary } from "../../shared/project";
import { api, navigate } from "./nav";

/** Every project: open one, or start one with its repos. */
export function ProjectsPage() {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [library, setLibrary] = useState(false);
  const [name, setName] = useState("");
  const [repos, setRepos] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => void api<{ projects: ProjectSummary[] }>("/api/projects").then((r) => setList(r.projects)).catch((e) => setError(String(e)));
  useEffect(() => {
    load();
    void api<{ library: boolean }>("/api/repo").then((r) => setLibrary(r.library)).catch(() => {});
  }, []);

  const create = async () => {
    setError(null);
    try {
      const p = await api<Project>("/api/projects", { name, repos: repos.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) });
      navigate(`/p/${p.id}/board`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async (p: ProjectSummary) => {
    if (!confirm(`Delete the project "${p.name}" and its ${p.boards} board${p.boards === 1 ? "" : "s"}? Its repos stay where they are.`)) return;
    await api("/api/project", { id: p.id, action: "delete" }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    load();
  };

  return (
    <div className="shell-page">
      <div className="shell-wrap">
        <p className="pb-label" style={{ marginBottom: 10 }}>
          <span className="pb-diamond">◆</span> Constellate
        </p>
        <h1 className="shell-h1">Projects</h1>
        <p className="shell-lede">A project holds your repos and your boards. The Code view flies through one repo at a time; the boards — architecture, deployments, plans, nested like folders — can point into its code, and expand into it.</p>
        {error && <p className="pb-error">{error}</p>}
        <div className="shell-grid">
          <form
            className="shell-card"
            style={{ borderStyle: "dashed" }}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <span className="shell-card-title">New project</span>
            <input className="pb-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            <textarea
              className="pb-input"
              style={{ height: 64, paddingTop: 6, resize: "vertical" }}
              value={repos}
              onChange={(e) => setRepos(e.target.value)}
              placeholder={library ? "Repos, one per line: owner/name or GitHub links" : "Repos, one per line: folders on the server"}
            />
            <button className="pb-btn pb-btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>
              Create
            </button>
          </form>
          {list?.map((p) => (
            <div key={p.id} className="shell-card" role="link" tabIndex={0} onClick={() => navigate(`/p/${p.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/p/${p.id}`)} style={{ cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="pb-diamond">◆</span>
                <span className="shell-card-title" style={{ flex: 1 }}>
                  {p.name}
                </span>
                {list.length > 1 && (
                  <button
                    className="pb-act pb-danger"
                    title="Delete the project"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(p);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              {p.description && <p className="shell-meta">{p.description}</p>}
              <div className="shell-chips">
                {p.repos.length ? p.repos.map((r) => <span key={r.root} className="shell-chip">⌥ {r.github ?? r.name}</span>) : <span className="shell-meta">No repos yet</span>}
              </div>
              <p className="shell-meta">
                {p.boards} board{p.boards === 1 ? "" : "s"} · {new Date(p.updatedAt).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
