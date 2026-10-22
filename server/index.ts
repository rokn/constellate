import { gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupOverlay, Lens, Note, NoteTarget, ScreenContext, StorySettings, ViewSettings } from "../shared/types";
import { ask, interrupt, runIntro, stopNavigator } from "./navigator";
import { REPOS_DIR, ensureClone, lastOpened, listRepos, markOpened, parseGitHub, removeClone, rootOf } from "./library";
import { loadFile } from "./repo";
import { externalGoFile, goRequest, goStatus, stop as stopGo, type GoQuery } from "./lsp";
import { changesSince, commitMessage, diffFile, graphAt, loadHistory } from "./history";
import {
  addNote,
  addOverlay,
  changeOverlays,
  restoreOverlays,
  dropOverview,
  openRepo,
  resetSession,
  savedHeadline,
  forgetSaved,
  pushActivity,
  pullRemote,
  checkRemote,
  putLens,
  removeLens,
  removeNote,
  removeOverlay,
  rescan,
  restoreNote,
  session,
  setView,
  subscribe,
  updateNote,
  updateOverlay,
  loadStorySettings,
  setStorySettings,
  getStory,
} from "./session";
import { EMPTY_FILTER, applyFilter } from "../shared/filter";
import { attachVoice } from "./voice";
import { AGENTS_ON, discardAgent, getAgent, mergePullRequest, messageAgent, openPullRequest, startAgent, stopAgent, stopAllAgents } from "./agents";
import { cancel as cancelStory, cancelAll as cancelStories, defaultSettings, retryStory, revoiceIfStale, writeBranchStory, writeIntroStories, writeStory } from "./stories";
import { listVoices, previewVoice, readAudio, ttsAvailable } from "./tts";
import { branchDiff, branchFileDiff, fetchRemotes, listBranches } from "./branch";

/**
 * One process: the API, the live stream, the voice bridge and (in dev) Vite.
 * Keeping it one module graph is what lets the voice call the navigator
 * directly instead of round-tripping through HTTP.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 4317);
const httpsPort = Number(process.env.HTTPS_PORT ?? 4443);

/**
 * The certificate for https, if there is one: CODEFLIGHT_TLS_CERT and
 * CODEFLIGHT_TLS_KEY, else .certs/codeflight.pem and .certs/codeflight-key.pem
 * (what mkcert writes — see the README). No certificate, no https.
 */
async function loadTls(): Promise<{ cert: Buffer; key: Buffer } | null> {
  const cert = process.env.CODEFLIGHT_TLS_CERT ?? path.join(ROOT, ".certs", "codeflight.pem");
  const key = process.env.CODEFLIGHT_TLS_KEY ?? path.join(ROOT, ".certs", "codeflight-key.pem");
  try {
    return { cert: await readFile(cert), key: await readFile(key) };
  } catch {
    return null;
  }
}

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
/**
 * CODEFLIGHT_LOCK_REPO=1 pins the server to the repo it started with: in a
 * shared deployment, nobody gets to point it at another path on the box.
 * (CODEFLIGHT_REPOS_DIR opens GitHub repos only, never paths, so it isn't pinned.)
 */
const LOCKED = !REPOS_DIR && /^(1|true|yes)$/i.test(process.env.CODEFLIGHT_LOCK_REPO ?? "");
const resolveRepo = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));

async function open(root: string) {
  if (LOCKED && session.state.repo && resolveRepo(root) !== session.state.repo.root) {
    throw new Error("This server is pinned to one repository.");
  }
  // The language server belongs to the repo it was started on, and so does
  // anything the navigator was in the middle of.
  stopNavigator();
  stopGo();
  cancelStories();
  stopAllAgents();
  try {
    await openRepo(root);
    // A freshly charted repo gets its intro stories written right after.
    // (A repo charted before stories existed can ask for them in Stories.)
    if (session.state.status === "analyzing") {
      const charting = session.state.repo?.root;
      void runIntro().then(() => {
        // Another repo opened mid-chart: the stories would be about the wrong one.
        if (session.state.repo?.root !== charting) return;
        if (session.state.overview && !session.state.stories.some((s) => s.intro)) writeIntroStories();
      });
    }
  } catch (err) {
    session.state.status = "error";
    session.state.error = err instanceof Error ? err.message : String(err);
    console.error("[open]", session.state.error);
  }
}

/** Open a GitHub repo ("owner/name"), cloning it first if it's new here. */
async function openGitHub(id: string) {
  stopNavigator();
  stopGo();
  cancelStories();
  stopAllAgents();
  const root = rootOf(id);
  resetSession(root, id.split("/")[1]);
  try {
    await ensureClone(id, (line) => pushActivity({ kind: "tool", detail: line }));
  } catch (err) {
    session.state.status = "error";
    session.state.error = err instanceof Error ? err.message : String(err);
    session.state.repo = undefined;
    console.error("[open]", session.state.error);
    return;
  }
  await markOpened(id).catch((err) => console.error("[shelf]", err));
  await open(root);
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
    case "GET /healthz":
      json(res, 200, { ok: true, status: session.state.status });
      return true;
    case "POST /api/remote/check":
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      await checkRemote();
      json(res, 200, session.state.remote ?? null);
      return true;
    case "POST /api/remote/pull":
      // Fast-forward to the upstream and rescan. Errors land in state.remote.error.
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      try {
        await pullRemote();
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) }), true;
      }
      json(res, 200, session.state.remote ?? null);
      return true;
    case "GET /api/config":
      json(res, 200, {
        voice: !!process.env.INWORLD_API_KEY,
        tts: ttsAvailable(),
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
    case "GET /api/chart-changes":
      // What changed since the map was charted — shown with "Re-chart".
      if (!session.idx || !session.chartedHead) return json(res, 404, { error: "No charted commit to compare with." }), true;
      try {
        json(res, 200, await changesSince(session.idx.graph.root, session.chartedHead));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
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
    case "POST /api/notes": {
      // Your notes on files and import lines.
      if (!session.state.repo) return json(res, 400, { error: "No repository open." }), true;
      const b = await body<{ action?: string; id?: string; text?: string; target?: NoteTarget; note?: Note }>(req);
      const text = b.text?.trim().slice(0, 4000) ?? "";
      const t = b.target;
      const validTarget = !!t && ((t.kind === "file" && !!t.path) || (t.kind === "link" && !!t.from && !!t.to));
      if (b.action === "add" && text && validTarget) return json(res, 200, { ok: true, note: addNote(text, t!) }), true;
      if (b.action === "update" && b.id && text) return updateNote(b.id, text), json(res, 200, { ok: true }), true;
      if (b.action === "delete" && b.id) {
        const note = removeNote(b.id);
        return json(res, note ? 200 : 404, note ? { ok: true, note } : { error: "No such note." }), true;
      }
      if (b.action === "restore" && b.note?.id && b.note.text && b.note.target) return restoreNote(b.note), json(res, 200, { ok: true }), true;
      return json(res, 400, { error: "Unknown action, or nothing to save." }), true;
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
      // Markers you add yourself: from the focus, the filter, or patterns.
      const b = await body<{
        action?: "add" | "update" | "delete" | "restore";
        id?: string;
        /** update / delete: every marker this answer made. */
        frameId?: string;
        /** restore: markers deleted a moment ago, put back as they were. */
        markers?: GroupOverlay[];
        label?: string;
        summary?: string;
        paths?: string[];
        include?: string[];
        visible?: boolean;
        /** Why these files were grouped, shown on each one's spoke. */
        why?: string;
      }>(req);
      if (!session.idx) return json(res, 400, { error: "No repository open." }), true;
      if (b.action === "restore" && Array.isArray(b.markers)) {
        restoreOverlays(b.markers);
        return json(res, 200, { ok: true }), true;
      }
      if ((b.action === "delete" || b.action === "update") && b.frameId) {
        const ids = session.state.overlays.filter((o) => o.frameId === b.frameId).map((o) => o.id);
        changeOverlays(ids, b.action === "delete" ? "delete" : b.visible ? "show" : "hide");
        return json(res, 200, { ok: true, count: ids.length }), true;
      }
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
      if (!b.label?.trim() || !paths.length) return json(res, 400, { error: "A marker needs a name and at least one file." }), true;
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
    case "GET /api/story-voices":
      try {
        json(res, 200, { available: ttsAvailable(), voices: await listVoices() });
      } catch (err) {
        json(res, 502, { available: ttsAvailable(), voices: [], error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    case "GET /api/story-audio": {
      const audio = await readAudio(url.searchParams.get("key") ?? "");
      if (!audio) return json(res, 404, { error: "No such audio." }), true;
      // Keyed by content, so it never changes.
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "private, max-age=31536000, immutable" });
      res.end(audio);
      return true;
    }
    case "POST /api/stories": {
      const b = await body<{ action?: string; id?: string; request?: string }>(req);
      if (!session.idx) return json(res, 400, { error: "No repository open." }), true;
      if (b.action === "create" && b.request?.trim()) return json(res, 202, { ok: true, id: writeStory(b.request.trim()).id }), true;
      if (b.action === "intro") {
        if (!session.state.overview) return json(res, 400, { error: "The map isn't charted yet." }), true;
        return json(res, 202, { ok: true, ids: writeIntroStories().map((s) => s.id) }), true;
      }
      if (b.action === "delete" && b.id) return json(res, cancelStory(b.id) ? 200 : 404, { ok: true }), true;
      if (b.action === "retry" && b.id) return retryStory(b.id), json(res, 202, { ok: true }), true;
      // Before playing: a story voiced with other settings is voiced again.
      if (b.action === "voice" && b.id) return json(res, 200, { ok: true, revoicing: revoiceIfStale(b.id) }), true;
      return json(res, 400, { error: "Unknown action." }), true;
    }
    case "POST /api/story-voice-preview": {
      // Hear a voice before choosing it.
      if (!ttsAvailable()) return json(res, 400, { error: "INWORLD_API_KEY is not set." }), true;
      const b = await body<{ voiceId?: string; rate?: number }>(req);
      if (!b.voiceId?.trim()) return json(res, 400, { error: "Which voice?" }), true;
      const rate = typeof b.rate === "number" ? Math.max(0.5, Math.min(1.5, b.rate)) : session.state.storySettings.rate;
      try {
        const v = await previewVoice({ ...session.state.storySettings, voiceId: b.voiceId.trim(), rate });
        json(res, 200, { key: v.key });
      } catch (err) {
        json(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    case "GET /api/branches":
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      try {
        json(res, 200, await listBranches(session.idx.graph.root, url.searchParams.get("base") || undefined));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    case "POST /api/branches/fetch":
      // Remote branches as they are now, for explaining someone else's work.
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      try {
        const f = await fetchRemotes(session.idx.graph.root);
        // Some remotes failing still leaves the others fresh: list them, and say which didn't fetch.
        if (!f.fetched.length && f.failed.length) {
          return json(res, 502, { error: f.failed.map((x) => `${x.remote}: ${x.error}`).join("; ") }), true;
        }
        json(res, 200, { ...(await listBranches(session.idx.graph.root)), failed: f.failed });
      } catch (err) {
        json(res, 502, { error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      }
      return true;
    case "GET /api/branch-diff": {
      // A branch against its base: commits and changed files. With `path`, that file's diff.
      if (!session.idx) return json(res, 404, { error: "No repository open." }), true;
      const q = url.searchParams;
      try {
        const root = session.idx.graph.root;
        const d = await branchDiff(root, q.get("branch") ?? "", q.get("base") || undefined);
        const file = q.get("path");
        if (file) {
          const diff = await branchFileDiff(root, d, file);
          return json(res, 200, { diff: diff.length > 400_000 ? `${diff.slice(0, 400_000)}\n… (diff truncated)` : diff }), true;
        }
        const idx = session.idx;
        json(res, 200, {
          ...d,
          files: d.files.map((f) => ({ ...f, lang: idx.byPath.get(f.path)?.lang ?? (path.extname(f.path).slice(1) || "text"), onMap: idx.byPath.has(f.path) })),
        });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    case "GET /api/story": {
      const s = getStory(url.searchParams.get("id") ?? "");
      if (!s) return json(res, 404, { error: "No such story." }), true;
      json(res, 200, s);
      return true;
    }
    case "POST /api/stories/branch": {
      // A story explaining what a branch changes relative to its base (main
      // by default). Made for scripts: it uses the default voice and style
      // unless told otherwise, opens the repo if a path is given, and with
      // `wait` answers only once the story is ready to play.
      const b = await body<{
        branch?: string;
        base?: string;
        repo?: string;
        voiceId?: string;
        style?: string;
        rate?: number;
        /** "mine": the app's current settings instead of the defaults (the panel uses this). */
        settings?: "default" | "mine";
        wait?: boolean | number;
      }>(req);
      if (!b.branch?.trim()) return json(res, 400, { error: "Name a branch." }), true;
      if (b.repo?.trim() && resolveRepo(b.repo.trim()) !== session.state.repo?.root) {
        if (LOCKED) return json(res, 403, { error: "This server is pinned to one repository." }), true;
        await open(b.repo.trim());
      }
      if (!session.idx) return json(res, 400, { error: session.state.error ?? "No repository open." }), true;
      const overrides = Object.fromEntries(
        Object.entries({ voiceId: b.voiceId, style: b.style, rate: b.rate }).filter(([, v]) => v !== undefined),
      );
      const settings = b.settings === "mine" ? undefined : defaultSettings(overrides);
      let story;
      try {
        story = await writeBranchStory(b.branch.trim(), { base: b.base?.trim() || undefined, settings });
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) }), true;
      }
      const link = `http://localhost:${port}/?story=${story.id}`;
      const diffUrl = `http://localhost:${port}/?diff=${encodeURIComponent(story.branch!.name)}&base=${encodeURIComponent(story.branch!.base)}`;
      if (!b.wait) return json(res, 202, { ok: true, id: story.id, state: story.state, url: link, diffUrl, status: `/api/story?id=${story.id}` }), true;
      // Wait (up to `wait` seconds, default ten minutes) for it to be written and voiced.
      const deadline = Date.now() + (typeof b.wait === "number" ? b.wait : 600) * 1000;
      const done = await new Promise<boolean>((resolve) => {
        const check = () => {
          const s = getStory(story.id);
          if (!s || s.state === "ready" || s.state === "error") return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(check, 1000);
        };
        check();
      });
      const s = getStory(story.id);
      json(res, done && s?.state === "ready" ? 200 : done ? 500 : 202, { ok: s?.state === "ready", id: story.id, state: s?.state, error: s?.error, title: s?.title, url: link, diffUrl, story: s });
      return true;
    }
    case "POST /api/story-settings": {
      const b = await body<{ settings?: Partial<StorySettings> }>(req);
      const s = b.settings ?? {};
      const patch: Partial<StorySettings> = {};
      if (typeof s.voiceId === "string" && s.voiceId.trim()) patch.voiceId = s.voiceId.trim();
      if (typeof s.ttsModel === "string" && s.ttsModel.trim()) patch.ttsModel = s.ttsModel.trim();
      if (typeof s.rate === "number" && Number.isFinite(s.rate)) patch.rate = Math.max(0.5, Math.min(1.5, s.rate));
      if (typeof s.style === "string") patch.style = s.style.slice(0, 600);
      await setStorySettings(patch);
      json(res, 200, { ok: true });
      return true;
    }
    case "POST /api/agents": {
      // Coding agents: start one, tell one more, stop one, open a PR for its branch, or throw its work away.
      const b = await body<{ action?: string; id?: string; task?: string; title?: string; text?: string }>(req);
      try {
        switch (b.action) {
          case "start":
            return json(res, 200, { ok: true, agent: await startAgent(b.task ?? "", { title: b.title }) }), true;
          case "message":
            return json(res, 200, { ok: true, status: messageAgent(b.id ?? "", b.text ?? "") }), true;
          case "stop":
            return json(res, 200, { ok: stopAgent(b.id ?? "") }), true;
          case "pr":
            return json(res, 200, { ok: true, pr: await openPullRequest(b.id ?? "") }), true;
          case "merge":
            return json(res, 200, { ok: true, pr: await mergePullRequest(b.id ?? "") }), true;
          case "discard":
            if (!getAgent(b.id ?? "")) return json(res, 404, { error: "No such agent." }), true;
            await discardAgent(b.id!);
            return json(res, 200, { ok: true }), true;
        }
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : String(err) }), true;
      }
      json(res, 400, { error: "Unknown action." });
      return true;
    }
    case "POST /api/interrupt":
      json(res, 200, { ok: interrupt() });
      return true;
    case "POST /api/open": {
      const b = await body<{ path?: string; github?: string }>(req);
      if (REPOS_DIR) {
        const id = parseGitHub(b.github ?? "");
        if (!id) return json(res, 400, { error: "Give a GitHub repo: a link, or owner/name." }), true;
        void openGitHub(id);
        json(res, 202, { ok: true, id });
        return true;
      }
      if (!b.path?.trim()) return json(res, 400, { error: "Give a local path." }), true;
      if (LOCKED) return json(res, 403, { error: "This server is pinned to one repository." }), true;
      void open(b.path.trim());
      json(res, 202, { ok: true });
      return true;
    }
    case "GET /api/repos":
      if (!REPOS_DIR) return json(res, 404, { error: "This server opens local paths." }), true;
      json(res, 200, await listRepos(session.state.repo?.root, savedHeadline));
      return true;
    case "POST /api/repos": {
      // Forget a repo: its clone and everything saved for it.
      const b = await body<{ action?: string; id?: string }>(req);
      const id = parseGitHub(b.id ?? "");
      if (!REPOS_DIR || b.action !== "remove" || !id) return json(res, 400, { error: "Nothing to do." }), true;
      if (session.state.repo?.root === rootOf(id)) return json(res, 409, { error: "That's the repo that's open." }), true;
      await removeClone(id);
      await forgetSaved(rootOf(id));
      json(res, 200, { ok: true });
      return true;
    }
    case "POST /api/reanalyze":
      // Re-charts the overview from the current code. Everything you made —
      // groupings, groups, answers, your view — is kept.
      if (!session.state.repo || !session.idx) return json(res, 400, { error: "No repository open." }), true;
      {
        // Read the files again first: the chart (and the map) are drawn
        // from the code as it is now, not as it was when the server started.
        await rescan();
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
  await loadStorySettings();
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

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    api(req, res, url)
      .then((handled) => {
        if (!handled) assets!(req, res);
      })
      .catch((err) => {
        console.error("[http]", err);
        if (!res.headersSent) json(res, 500, { error: String(err) });
      });
  };
  server.on("request", handle);
  attachVoice(server);

  // HTTPS alongside, when there's a certificate: browsers only allow the
  // microphone, installing the app and the clipboard on a secure origin, and
  // over the LAN that means https. http keeps working on its own port.
  const tls = await loadTls();
  if (tls) {
    const { createServer: createHttps } = await import("node:https");
    const secure = createHttps(tls, handle);
    attachVoice(secure);
    secure.listen(httpsPort, () => console.log(`  🔒 https on https://localhost:${httpsPort} (and your LAN address)\n`));
  }

  server.listen(port, () => {
    console.log(`\n  ✦  Constellate on http://localhost:${port}\n`);
    if (!process.env.INWORLD_API_KEY) console.log("     (INWORLD_API_KEY not set — voice is off; everything else works)\n");
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopGo();
      process.exit(0);
    });
  }

  session.state.locked = LOCKED;
  session.state.agentsOn = AGENTS_ON;
  if (REPOS_DIR) {
    // A shelf of GitHub repos: pick up where the last visit left off.
    session.state.library = true;
    console.log(`     (repos are cloned into ${REPOS_DIR})\n`);
    const last = await lastOpened();
    if (last) void openGitHub(last);
    return;
  }
  const repo = process.argv[2] ?? process.env.CODEFLIGHT_REPO;
  if (LOCKED && !repo) console.log("     (CODEFLIGHT_LOCK_REPO is set but no repo was given — nothing to open)\n");
  if (repo) void open(repo);
}

void main();
