import type { IncomingMessage, ServerResponse } from "node:http";
import { changeProject, createProject, listProjects, projectDetail, projectOfRepo } from "./projects";
import { session } from "./session";

/** Projects' API, under /api/project(s). Returns false for anything else. */
export async function projectApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  h: { json: (res: ServerResponse, status: number, body: unknown) => void; body: <T>(req: IncomingMessage) => Promise<T> },
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/project")) return false;
  const { json, body } = h;
  switch (`${req.method} ${url.pathname}`) {
    case "GET /api/projects": {
      const list = await listProjects();
      const open = session.state.repo?.root;
      // Which project the open repo is in: where a fresh visit lands.
      json(res, 200, { projects: list, openRepo: open ?? null, openIn: open ? ((await projectOfRepo(open))?.id ?? null) : null });
      return true;
    }
    case "POST /api/projects": {
      const b = await body<{ name?: string; description?: string; repos?: string[] }>(req);
      json(res, 200, await createProject(b.name ?? "", { description: b.description, repos: Array.isArray(b.repos) ? b.repos.map(String) : [] }));
      return true;
    }
    case "GET /api/project": {
      const d = await projectDetail(url.searchParams.get("id") ?? "");
      if (!d) return json(res, 404, { error: "No such project." }), true;
      json(res, 200, d);
      return true;
    }
    case "POST /api/project": {
      const b = await body<{ id?: string; action?: string; name?: string; description?: string; repo?: string; root?: string }>(req);
      if (!b.id || !b.action) return json(res, 400, { error: "Which project, and what to do?" }), true;
      const c =
        b.action === "rename" ? { action: "rename" as const, name: b.name ?? "" }
        : b.action === "describe" ? { action: "describe" as const, description: b.description ?? "" }
        : b.action === "add-repo" ? { action: "add-repo" as const, repo: b.repo ?? "" }
        : b.action === "remove-repo" ? { action: "remove-repo" as const, root: b.root ?? "" }
        : b.action === "activate-repo" ? { action: "activate-repo" as const, root: b.root ?? "" }
        : b.action === "delete" ? { action: "delete" as const }
        : null;
      if (!c) return json(res, 400, { error: "Unknown action." }), true;
      const r = await changeProject(b.id, c);
      if (r.error) return json(res, 400, { error: r.error }), true;
      json(res, 200, r);
      return true;
    }
  }
  return false;
}
