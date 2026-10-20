import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";

/**
 * Go code intelligence from gopls — the same language server VS Code uses — so
 * go-to-definition, references and hover are the compiler's answers, not
 * pattern matches. One gopls per open repo, started on first use. Files are
 * opened in it on demand with their on-disk text (the editor is read-only, so
 * disk is always the truth).
 */

const run = promisify(execFile);

export type Loc = {
  /** Repo-relative for files in the repo; absolute for the standard library and module cache. */
  path: string;
  external: boolean;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };

let server: {
  root: string;
  proc: ChildProcess;
  conn: MessageConnection;
  ready: Promise<void>;
  open: Map<string, number>;
  error?: string;
} | null = null;

let goEnv: { gopls: string | null; goroot: string; modcache: string } | null = null;

async function locateGo() {
  if (goEnv) return goEnv;
  const which = async (bin: string) => (await run("which", [bin]).then((r) => r.stdout.trim()).catch(() => "")) || null;
  let gopls = process.env.GOPLS ?? (await which("gopls"));
  let goroot = "";
  let modcache = "";
  try {
    const { stdout } = await run("go", ["env", "GOPATH", "GOROOT", "GOMODCACHE"]);
    const [gopath, root, cache] = stdout.trim().split("\n");
    goroot = root;
    modcache = cache;
    if (!gopls) gopls = path.join(gopath, "bin", "gopls");
    await readFile(gopls).catch(() => (gopls = null));
  } catch {
    /* no go toolchain: gopls alone may still work, without stdlib browsing */
  }
  goEnv = { gopls, goroot, modcache };
  return goEnv;
}

/** Every go.mod directory, so a multi-module repo opens as one workspace. */
async function moduleDirs(root: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["ls-files", "--", "go.mod", "**/go.mod"], { cwd: root });
    const dirs = stdout.split("\n").filter(Boolean).map((f) => path.join(root, path.dirname(f)));
    return dirs.length ? dirs : [root];
  } catch {
    return [root];
  }
}

async function start(root: string) {
  const env = await locateGo();
  if (!env.gopls) throw new Error("gopls isn't installed. Install it with: go install golang.org/x/tools/gopls@latest");

  const proc = spawn(env.gopls, ["serve"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  const conn = createMessageConnection(new StreamMessageReader(proc.stdout!), new StreamMessageWriter(proc.stdin!));
  // gopls asks its client things; answer the ones it waits on.
  conn.onRequest((method: string, params: unknown) => {
    if (method === "workspace/configuration") return ((params as { items: unknown[] }).items ?? []).map(() => ({}));
    return null;
  });
  conn.onNotification(() => {});
  proc.stderr?.on("data", () => {});
  conn.listen();

  const state = { root, proc, conn, open: new Map<string, number>(), ready: Promise.resolve() as Promise<void>, error: undefined as string | undefined };
  proc.on("exit", (code) => {
    state.error = `gopls exited (${code ?? "signal"})`;
    if (server === state) server = null;
  });

  const folders = (await moduleDirs(root)).map((d) => ({ uri: pathToFileURL(d).href, name: path.basename(d) }));
  state.ready = (async () => {
    await conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: folders,
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          implementation: { linkSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { workspaceFolders: true, configuration: true },
      },
    });
    await conn.sendNotification("initialized", {});
  })();
  server = state;
  return state;
}

async function ensure(root: string) {
  if (server && server.root !== root) stop();
  const s = server ?? (await start(root));
  await s.ready;
  return s;
}

export function stop() {
  if (!server) return;
  try {
    server.conn.dispose();
    server.proc.kill();
  } catch {
    /* already gone */
  }
  server = null;
}

/** Opens a repo file in gopls with its current text (once; reopened if it changed on disk). */
async function openDoc(s: NonNullable<typeof server>, abs: string) {
  const text = await readFile(abs, "utf8");
  const uri = pathToFileURL(abs).href;
  const version = s.open.get(uri);
  if (version !== undefined) {
    await s.conn.sendNotification("textDocument/didChange", { textDocument: { uri, version: version + 1 }, contentChanges: [{ text }] });
    s.open.set(uri, version + 1);
  } else {
    await s.conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "go", version: 1, text } });
    s.open.set(uri, 1);
  }
  return uri;
}

function toLoc(root: string, uri: string, range: LspRange): Loc {
  const abs = fileURLToPath(uri);
  const rel = path.relative(root, abs);
  const external = rel.startsWith("..") || path.isAbsolute(rel);
  return {
    path: external ? abs : rel.split(path.sep).join("/"),
    external,
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

type LocationLike = { uri: string; range: LspRange } | { targetUri: string; targetSelectionRange?: LspRange; targetRange: LspRange };

function toLocs(root: string, result: LocationLike | LocationLike[] | null): Loc[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((l) => ("targetUri" in l ? toLoc(root, l.targetUri, l.targetSelectionRange ?? l.targetRange) : toLoc(root, l.uri, l.range)));
}

export type GoQuery = { method: "definition" | "references" | "implementation" | "hover"; path: string; line: number; column: number };

/** One request to gopls at a 1-based line/column in a repo file. */
export async function goRequest(root: string, q: GoQuery): Promise<{ locations?: Loc[]; hover?: string }> {
  const s = await ensure(root);
  const abs = path.join(root, q.path);
  if (!path.resolve(abs).startsWith(root + path.sep)) throw new Error("Outside the repository.");
  const uri = await openDoc(s, abs);
  const position = { line: q.line - 1, character: q.column - 1 };
  const textDocument = { uri };
  const timeout = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("gopls took too long (still loading the workspace?)")), 45_000))]);

  if (q.method === "hover") {
    const r = await timeout(s.conn.sendRequest<{ contents: unknown } | null>("textDocument/hover", { textDocument, position }));
    const c = r?.contents as { value?: string } | string | ({ value: string } | string)[] | undefined;
    const text = !c ? "" : typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x.value)).join("\n\n") : (c.value ?? "");
    return { hover: text };
  }
  const method = q.method === "references" ? "textDocument/references" : q.method === "implementation" ? "textDocument/implementation" : "textDocument/definition";
  const params = q.method === "references" ? { textDocument, position, context: { includeDeclaration: true } } : { textDocument, position };
  const r = await timeout(s.conn.sendRequest<LocationLike | LocationLike[] | null>(method, params));
  return { locations: toLocs(root, r) };
}

/**
 * Text of a file outside the repo that a definition pointed into — the Go
 * standard library or the module cache, and nowhere else.
 */
export async function externalGoFile(p: string): Promise<string> {
  const env = await locateGo();
  const abs = path.resolve(p);
  const allowed = [env.goroot, env.modcache].filter(Boolean).some((dir) => abs.startsWith(dir + path.sep));
  if (!allowed || !abs.endsWith(".go")) throw new Error("Only Go files from the standard library or module cache can be opened.");
  return readFile(abs, "utf8");
}

export async function goStatus(root?: string) {
  const env = await locateGo();
  return {
    available: !!env.gopls,
    running: !!server && server.root === root,
    error: server?.error,
    install: env.gopls ? undefined : "go install golang.org/x/tools/gopls@latest",
  };
}
