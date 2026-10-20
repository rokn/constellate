import { gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Lens, ScreenContext, ViewSettings } from "../shared/types";
import { ask, interrupt, runIntro } from "./navigator";
import { loadFile } from "./repo";
import { externalGoFile, goRequest, goStatus, stop as stopGo, type GoQuery } from "./lsp";
import { commitMessage, diffFile, graphAt, loadHistory } from "./history";
import { addOverlay, dropOverview, openRepo, putLens, removeLens, removeOverlay, session, setView, subscribe, updateOverlay } from "./session";
import { EMPTY_FILTER, applyFilter } from "../shared/filter";
import { attachVoice } from "./voice";

/**
 * One process: the API, the live stream, the voice bridge and (in dev) Vite.
 * Keeping it one module graph is what lets the voice call the navigator
 * directly instead of round-tripping through HTTP.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 4317);

async function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    try {
      for (const line of (await readFile(path.join(ROOT, name), "utf8")).split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      /* optional */
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}") as T;
  } catch {
    return {} as T;
  }
}

/** Open a repo and, unless the cache already knew it, run the intro analysis. */
async function open(root: string) {
  // The language server belongs to the repo it was started on.
  stopGo();
  try {
    await openRepo(root);
    if (session.state.status === "analyzing") void runIntro();
  } catch (err) {
    session.state.status = "error";
    session.state.error = err instanceof Error ? err.message : String(err);
    console.error("[open]", session.state.error);
  }
}

/* -------------------------------- routes -------------------------------- */

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/events": {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      // Coalesce: the navigator can emit dozens of times a second while it
      // streams, and the browser only needs the latest state.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        res.write(`data: ${JSON.stringify(session.state)}\n\n`);
      };
      flush();
      const off = subscribe(() => {
        timer ??= setTimeout(flush, 60);
      });
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        off();
        clearTimeout(timer);
        clearInterval(ping);
      });
      return true;
    }
    case "GET /api/config":
      json(res, 200, {
        voice: !!process.env.INWORLD_API_KEY,
        model: process.env.CODEFLIGHT_MODEL ?? "claude-opus-5-5",
      });
      return true;
    case "GET /api/graph":
      if (!session.idx) json(res, 404, { error: "No repository scanned yet." });
      else json(res, 200, session.idx.graph);
      return true;
    case "GET /api/file": {
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      const file = await loadFile(session.idx, url.searchParams.get("path") ?? "");
      if (!file) return json(res, 404, { error: "Not found." }), true;
      const info = session.idx.byPath.get(file.path);
      json(res, 200, {
        path: file.path,
        lang: info?.lang ?? "text",
        text: file.text,
        symbols: info?.symbols ?? [],
        externals: info?.externals ?? [],
        imports: session.idx.out.get(file.path) ?? [],
        importers: session.idx.in.get(file.path) ?? [],
        // The same links with what travels them, for the panel's hover tags.
        importLinks: session.idx.graph.imports.filter((e) => e.from === file.path).map((e) => ({ path: e.to, names: e.names ?? [], line: e.line })),
        importerLinks: session.idx.graph.imports.filter((e) => e.to === file.path).map((e) => ({ path: e.from, names: e.names ?? [], line: e.line })),
      });
      return true;
    }
    case "GET /api/lsp/status":
      json(res, 200, { go: await goStatus(session.idx?.graph.root) });
      return true;
    case "POST /api/lsp/go": {
      // Go intelligence from gopls: definition, references, implementation, hover.
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      const q = await body<Partial<GoQuery>>(req);
      if (!q.path || !q.line || !q.column || !["definition", "references", "implementation", "hover"].includes(q.method ?? "")) {
        return json(res, 400, { error: "Need method, path, line and column." }), true;
      }
      try {
        json(res, 200, await goRequest(session.idx.graph.root, q as GoQuery));
      } catch (err) {
        json(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    case "GET /api/lsp/external": {
      try {
        json(res, 200, { text: await externalGoFile(url.searchParams.get("path") ?? "") });
      } catch (err) {
        json(res, 403, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    case "GET /api/history":
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      json(res, 200, await loadHistory(session.idx.graph.root));
      return true;
    case "GET /api/graph-at": {
      // The map as it was at a commit, from git's objects (see history.ts).
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      try {
        const g = await graphAt(session.idx.graph.root, url.searchParams.get("sha") ?? "");
        const body = Buffer.from(JSON.stringify(g));
        // A map is a megabyte of JSON that squeezes tenfold; it matters over the LAN.
        if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
          res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "cache-control": "private, max-age=86400" });
          res.end(gzipSync(body, { level: 4 }));
        } else {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "private, max-age=86400" });
          res.end(body);
        }
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    case "GET /api/diff": {
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      const q = url.searchParams;
      try {
        const diff = await diffFile(session.idx.graph.root, q.get("path") ?? "", q.get("from") ?? "", q.get("to") ?? "");
        json(res, 200, { diff });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    case "GET /api/commit": {
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      try {
        json(res, 200, { message: await commitMessage(session.idx.graph.root, url.searchParams.get("sha") ?? "") });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    case "POST /api/ask": {
      const b = await body<{ request?: string; topicId?: string; screen?: ScreenContext }>(req);
      if (!b.request?.trim() && !b.topicId) return json(res, 400, { error: "Ask something." }), true;
      // Not awaited: the answer streams into its frame, and the page is
      // already watching the stream.
      const done = ask(b.request?.trim() ?? "", { topicId: b.topicId, screen: b.screen });
      void done.catch((err) => console.error("[ask]", err));
      json(res, 202, { ok: true });
      return true;
    }
    case "POST /api/lenses": {
      // Delete a grouping, or put a deleted one back (undo).
      const b = await body<{ action?: string; id?: string; lens?: Lens }>(req);
      if (b.action === "delete" && b.id) {
        const lens = removeLens(b.id);
        return json(res, lens ? 200 : 404, lens ? { ok: true, lens } : { error: "No such grouping." }), true;
      }
      if (b.action === "restore" && b.lens?.id && Array.isArray(b.lens.groups)) {
        putLens(b.lens);
        return json(res, 200, { ok: true }), true;
      }
      return json(res, 400, { error: "Unknown action." }), true;
    }
    case "POST /api/overlays": {
      // Groups you mark yourself: from the focus, the filter, or patterns.
      const b = await body<{
        action?: "add" | "update" | "delete";
        id?: string;
        label?: string;
        summary?: string;
        paths?: string[];
        include?: string[];
        visible?: boolean;
        /** Why these files were grouped, shown on each one's spoke. */
        why?: string;
      }>(req);
      if (!session.idx) return json(res, 400, { error: "No repository open." }), true;
      if (b.action === "delete" && b.id) {
        removeOverlay(b.id);
        return json(res, 200, { ok: true }), true;
      }
      if (b.action === "update" && b.id) {
        updateOverlay(b.id, { visible: b.visible, label: b.label?.trim() || undefined });
        return json(res, 200, { ok: true }), true;
      }
      const known = new Set(session.idx.graph.files.map((f) => f.path));
      const paths = b.paths?.filter((p) => known.has(p)) ??
        [...(applyFilter(session.idx.graph.files, { ...EMPTY_FILTER, include: b.include ?? [] }) ?? [])];
      if (!b.label?.trim() || !paths.length) return json(res, 400, { error: "A group needs a name and at least one file." }), true;
      const why = b.why?.trim() || (b.include?.length ? `matches ${b.include.join(", ")}` : "");
      const o = addOverlay({
        label: b.label.trim(),
        summary: b.summary ?? "",
        paths,
        reasons: why ? Object.fromEntries(paths.map((p) => [p, why])) : undefined,
        createdBy: "you",
      });
      json(res, 200, { ok: true, id: o.id, count: paths.length });
      return true;
    }
    case "POST /api/interrupt":
      json(res, 200, { ok: interrupt() });
      return true;
    case "POST /api/open": {
      const b = await body<{ path?: string }>(req);
      if (!b.path?.trim()) return json(res, 400, { error: "Give a local path." }), true;
      void open(b.path.trim());
      json(res, 202, { ok: true });
      return true;
    }
    case "POST /api/reanalyze":
      // Re-charts the overview from the current code. Everything you made —
      // groupings, groups, answers, your view — is kept.
      if (!session.state.repo || !session.idx) return json(res, 400, { error: "No repository open." }), true;
      {
        // The chart being replaced goes to the navigator, to update rather than redraw.
        const previous = session.state.overview;
        const since = session.chartedHead;
        dropOverview();
        void runIntro(previous ? { previous, since } : undefined);
      }
      json(res, 202, { ok: true });
      return true;
    case "POST /api/view": {
      const b = await body<{ view?: ViewSettings }>(req);
      if (!session.state.repo || !b.view) return json(res, 400, { error: "Nothing to save." }), true;
      setView(b.view);
      json(res, 200, { ok: true });
      return true;
    }
  }
  if (url.pathname.startsWith("/api/")) {
    json(res, 404, { error: "Unknown route." });
    return true;
  }
  return false;
}

/* --------------------------------- boot --------------------------------- */

async function main() {
  await loadEnv();
  const server = createServer();

  let assets: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  if (dev) {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({
      configFile: path.join(ROOT, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    assets = (req, res) => vite.middlewares(req, res);
  } else {
    const dist = path.join(ROOT, "dist");
    assets = async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let file = path.join(dist, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
      try {
        if (!(await stat(file)).isFile()) throw new Error();
      } catch {
        file = path.join(dist, "index.html");
      }
      const type: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
        ".png": "image/png",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".ttf": "font/ttf",
        ".woff2": "font/woff2",
      };
      res.writeHead(200, { "Content-Type": type[path.extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    };
  }

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    api(req, res, url)
      .then((handled) => {
        if (!handled) assets!(req, res);
      })
      .catch((err) => {
        console.error("[http]", err);
        if (!res.headersSent) json(res, 500, { error: String(err) });
      });
  });
  attachVoice(server);

  server.listen(port, () => {
    console.log(`\n  ✈  Codeflight on http://localhost:${port}\n`);
    if (!process.env.INWORLD_API_KEY) console.log("     (INWORLD_API_KEY not set — voice is off; everything else works)\n");
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopGo();
      process.exit(0);
    });
  }

  const repo = process.argv[2] ?? process.env.CODEFLIGHT_REPO;
  if (repo) void open(repo);
}

void main();
