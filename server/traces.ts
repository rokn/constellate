import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  RuntimeEdge,
  RuntimeEdgeKind,
  RuntimeExternal,
  RuntimeMap,
  RuntimeService,
  RuntimeStatus,
  SpanLocation,
  Symbol,
  TraceSourceStatus,
  TraceSpan,
  TraceSummary,
} from "../shared/types";
import { parseJaeger, parseOtlpJson } from "./otlp";
import type { GraphIndex } from "./scan";
import { GO_APPS } from "../shared/goApps";
import { CACHE_DIR, cacheFile, emitLive, refreshGoApps, session } from "./session";

/**
 * The runtime layer: what the code really calls when it runs, from
 * OpenTelemetry traces.
 *
 * Spans come in pushed over OTLP (POST /v1/traces, see index.ts) or pulled
 * from Tempo or Jaeger. Each is pinned to the file it ran in (its code.*
 * attributes, its function's qualified name, its tracer's package, or its
 * name as a symbol), and every parent-to-child step between two places adds
 * to a runtime edge: file to file inside a service, service to service over
 * HTTP, RPC or a queue, and out to databases and hosts. File-to-file edges
 * get a verdict against the static imports.
 *
 * Recent traces are held whole in memory, so a trace can be looked at span
 * by span; older ones are folded into running totals, which are kept on disk
 * beside the repo's session. Nothing here is the open repo's session state:
 * the stream only carries a RuntimeStatus to say when to refetch.
 */

const SPAN_LIMIT = Math.max(1000, Number(process.env.CONSTELLATE_TRACE_SPANS ?? 20_000));
/** A runaway trace (a batch job's million spans) keeps only its first ones. */
const SPANS_PER_TRACE = 5_000;
const MAX_LABELS = 40;
const MAX_CALLS = 40;
const MAX_UNMAPPED = 400;
const TRACES_PER_EDGE = 5;

/* --------------------------------- totals --------------------------------- */

type EdgeAcc = Omit<RuntimeEdge, "labels" | "calls" | "verdict"> & {
  labels: Record<string, number>;
  /** "from\0to" symbol pairs. */
  calls: Record<string, number>;
};
type ServiceAcc = Omit<RuntimeService, "files" | "entries"> & { files: Record<string, number>; entries: Record<string, number> };

/** Running totals: plain objects, so they save as JSON and add together. */
type Totals = {
  spans: number;
  mapped: number;
  traces: number;
  firstSeen?: number;
  lastSeen?: number;
  edges: Record<string, EdgeAcc>;
  services: Record<string, ServiceAcc>;
  externals: Record<string, RuntimeExternal>;
  unmapped: Record<string, { service: string; name: string; scope?: string; count: number }>;
};

const emptyTotals = (): Totals => ({ spans: 0, mapped: 0, traces: 0, edges: {}, services: {}, externals: {}, unmapped: {} });

const min = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
const max = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));

/** Add counts into a capped table: a new key past the cap is dropped, known ones keep counting. */
function bump(table: Record<string, number>, key: string, by: number, cap: number) {
  if (key in table) table[key] += by;
  else if (Object.keys(table).length < cap) table[key] = by;
}

function addTotals(into: Totals, from: Totals) {
  into.spans += from.spans;
  into.mapped += from.mapped;
  into.traces += from.traces;
  into.firstSeen = min(into.firstSeen, from.firstSeen);
  into.lastSeen = max(into.lastSeen, from.lastSeen);
  for (const [k, e] of Object.entries(from.edges)) {
    const t = into.edges[k];
    if (!t) {
      into.edges[k] = { ...e, labels: { ...e.labels }, calls: { ...e.calls }, traces: [...e.traces] };
      continue;
    }
    t.count += e.count;
    t.errors += e.errors;
    t.totalMs += e.totalMs;
    t.maxMs = Math.max(t.maxMs, e.maxMs);
    t.firstSeen = Math.min(t.firstSeen, e.firstSeen);
    t.lastSeen = Math.max(t.lastSeen, e.lastSeen);
    for (const [l, n] of Object.entries(e.labels)) bump(t.labels, l, n, MAX_LABELS);
    for (const [c, n] of Object.entries(e.calls)) bump(t.calls, c, n, MAX_CALLS);
    t.traces = [...new Set([...e.traces, ...t.traces])].slice(0, TRACES_PER_EDGE);
  }
  for (const [k, s] of Object.entries(from.services)) {
    const t = into.services[k];
    if (!t) {
      into.services[k] = { ...s, files: { ...s.files }, entries: { ...s.entries } };
      continue;
    }
    t.spans += s.spans;
    t.errors += s.errors;
    t.firstSeen = Math.min(t.firstSeen, s.firstSeen);
    t.lastSeen = Math.max(t.lastSeen, s.lastSeen);
    t.executable ??= s.executable;
    t.executablePath ??= s.executablePath;
    t.language ??= s.language;
    t.namespace ??= s.namespace;
    for (const [p, n] of Object.entries(s.files)) t.files[p] = (t.files[p] ?? 0) + n;
    for (const [p, n] of Object.entries(s.entries)) t.entries[p] = (t.entries[p] ?? 0) + n;
  }
  Object.assign(into.externals, from.externals);
  for (const [k, u] of Object.entries(from.unmapped)) {
    if (into.unmapped[k]) into.unmapped[k].count += u.count;
    else if (Object.keys(into.unmapped).length < MAX_UNMAPPED) into.unmapped[k] = { ...u };
  }
}

/* ------------------------------ where it ran ------------------------------ */

type Resolver = { graph: GraphIndex["graph"]; locate: (s: TraceSpan) => SpanLocation | undefined };

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

/** Which languages' files a span can be in, by its SDK's telemetry.sdk.language. */
const SDK_LANGS: Record<string, string[]> = {
  go: ["go"],
  python: ["python"],
  nodejs: ["typescript", "tsx", "javascript", "jsx"],
  webjs: ["typescript", "tsx", "javascript", "jsx"],
  java: ["java", "kotlin", "scala"],
  dotnet: ["csharp"],
  ruby: ["ruby"],
  rust: ["rust"],
  php: ["php"],
  cpp: ["cpp", "c"],
};

/**
 * A Go function as runtime.FuncForPC names it (and as code.function.name
 * carries it): "github.com/me/app/internal/store.(*Store).Get",
 * "…/store.Store.Get", "main.main", "…/store.New.func1".
 */
function parseGoFunc(q: string): { pkg: string; name: string; container?: string } | null {
  const slash = q.lastIndexOf("/");
  const dot = q.indexOf(".", slash + 1);
  if (dot < 0) return null;
  const pkg = q.slice(0, dot);
  const parts = q
    .slice(dot + 1)
    .replace(/\[[^\]]*\]/g, "")
    .split(".")
    .map((p) => p.replace(/^\(\*?|\)$/g, ""))
    .filter((p) => p && !/^(func|gowrap)\d+$/.test(p) && !/^\d+$/.test(p));
  if (!parts.length) return null;
  return parts.length >= 2 ? { pkg, container: parts[0], name: parts[1] } : { pkg, name: parts[0] };
}

const resolvers = new WeakMap<GraphIndex["graph"], Promise<Resolver>>();

function resolverFor(idx: GraphIndex): Promise<Resolver> {
  let r = resolvers.get(idx.graph);
  if (!r) {
    r = buildResolver(idx);
    resolvers.set(idx.graph, r);
  }
  return r;
}

async function buildResolver(idx: GraphIndex): Promise<Resolver> {
  const { graph } = idx;
  const byBase = new Map<string, string[]>();
  const byDir = new Map<string, string[]>();
  const bySymbol = new Map<string, { path: string; sym: Symbol }[]>();
  const byStem = new Map<string, string>();
  for (const f of graph.files) {
    const base = f.path.split("/").pop()!;
    byBase.set(base, [...(byBase.get(base) ?? []), f.path]);
    const dir = path.posix.dirname(f.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), f.path]);
    byStem.set(f.path.replace(/\.[^./]+$/, ""), f.path);
    for (const sym of f.symbols) bySymbol.set(sym.name, [...(bySymbol.get(sym.name) ?? []), { path: f.path, sym }]);
  }

  // Go module paths, to turn a package's import path into its directory here.
  const goDirs = [...byDir.keys()].filter((d) => byDir.get(d)!.some((p) => p.endsWith(".go")));
  const candidates = new Set<string>(["."]);
  for (const d of goDirs) for (let x = d; x !== "."; x = path.posix.dirname(x)) candidates.add(x);
  const modules: { name: string; dir: string }[] = [];
  await Promise.all(
    [...candidates].map(async (dir) => {
      try {
        const text = await readFile(path.join(graph.root, dir, "go.mod"), "utf8");
        const m = text.match(/^module\s+(\S+)/m);
        if (m) modules.push({ name: m[1].replace(/^"|"$/g, ""), dir });
      } catch {
        /* no go.mod here */
      }
    }),
  );
  modules.sort((a, b) => b.name.length - a.name.length);
  const goPkgDirs = new Set(goDirs);

  const goDir = (pkg: string): string | null => {
    const mod = modules.find((m) => pkg === m.name || pkg.startsWith(`${m.name}/`));
    if (mod) {
      const dir = path.posix.normalize(path.posix.join(mod.dir, pkg.slice(mod.name.length)));
      return goPkgDirs.has(dir) ? dir : null;
    }
    // No go.mod read (vendored, or a module outside the scan): the longest directory the path ends with.
    let best: string | null = null;
    for (const d of goPkgDirs) if (d !== "." && (pkg === d || pkg.endsWith(`/${d}`)) && (!best || d.length > best.length)) best = d;
    return best;
  };

  /** A path from another machine (/app/internal/x.go, C:\src\…) as the repo path it ends with. */
  const matchPath = (file: string): string | null => {
    const norm = file.replace(/\\/g, "/").replace(/^file:\/\//, "");
    if (idx.byPath.has(norm)) return norm;
    const cands = byBase.get(norm.split("/").pop()!) ?? [];
    let best: string | null = null;
    for (const p of cands) if ((norm === p || norm.endsWith(`/${p}`)) && (!best || p.length > best.length)) best = p;
    return best;
  };

  const langOf = (p: string) => idx.byPath.get(p)?.lang ?? "";
  const symbolAt = (p: string, line: number) => {
    let best: Symbol | undefined;
    // The function or type the line is in, not a variable declared above it.
    for (const s of idx.byPath.get(p)?.symbols ?? []) if (/function|method|class/.test(s.kind) && s.line <= line && (!best || s.line > best.line)) best = s;
    return best;
  };
  const symName = (s: Symbol) => (s.container ? `${s.container}.${s.name}` : s.name);

  /** The symbol `name` (on `container`, if given) among these files. */
  const findSymbol = (files: string[], name: string, container?: string) => {
    const set = new Set(files);
    const hits = (bySymbol.get(name) ?? []).filter((h) => set.has(h.path));
    return (container && hits.find((h) => h.sym.container === container)) || hits.find((h) => !h.sym.container) || hits[0];
  };

  /** The file that stands for a package directory: named for it, else the one declaring the most. */
  const repOf = (dir: string) => {
    const files = (byDir.get(dir) ?? []).filter((p) => p.endsWith(".go") && !p.endsWith("_test.go"));
    const base = dir.split("/").pop();
    return (
      files.find((p) => p.endsWith(`/${base}.go`) || p === `${base}.go`) ??
      files.sort((a, b) => (idx.byPath.get(b)?.symbols.length ?? 0) - (idx.byPath.get(a)?.symbols.length ?? 0))[0]
    );
  };

  /** Span names like "Store.Get", "(*Store).Get", "store.Get", "GetUser", "POST /users". */
  const nameTokens = (name: string) => {
    const t = name.split(/[\s/:#()*]+/).filter(Boolean);
    const last = t[t.length - 1] ?? "";
    const dotted = last.split(".").filter(Boolean);
    return dotted.length >= 2 ? { name: dotted[dotted.length - 1], container: dotted[dotted.length - 2] } : { name: last };
  };

  const cache = new Map<string, SpanLocation | undefined>();

  const locate = (s: TraceSpan): SpanLocation | undefined => {
    const a = s.attrs;
    const file = str(a["code.file.path"]) ?? str(a["code.filepath"]);
    const line = num(a["code.line.number"]) ?? num(a["code.lineno"]);
    const fn = str(a["code.function.name"]) ?? str(a["code.function"]);
    const ns = str(a["code.namespace"]);
    const sdk = str(a["resource.telemetry.sdk.language"]);
    const key = [s.service, s.scope, s.name, file, line, fn, ns, sdk].join("\0");
    if (cache.has(key)) return cache.get(key);
    const loc = find();
    if (cache.size > 50_000) cache.clear();
    cache.set(key, loc);
    return loc;

    function find(): SpanLocation | undefined {
      // 1. Its code.* attributes name the file.
      if (file) {
        const p = matchPath(file);
        if (p) {
          const sym = line ? symbolAt(p, line) : undefined;
          return { path: p, line, symbol: fn?.split(/[./]/).pop() ?? (sym && symName(sym)), via: "code" };
        }
      }
      // 2. Its function's qualified name: a Go package path, or a dotted namespace.
      const qual = fn && ns && !fn.startsWith(ns) ? `${ns}.${fn}` : fn;
      if (qual) {
        const g = qual.includes("/") || sdk === "go" ? parseGoFunc(qual) : null;
        const dir = g ? goDir(g.pkg) : null;
        if (g && dir) {
          const hit = findSymbol(byDir.get(dir) ?? [], g.name, g.container);
          const p = hit?.path ?? repOf(dir);
          if (p) return { path: p, line: hit?.sym.line, symbol: g.container ? `${g.container}.${g.name}` : g.name, via: "function" };
        }
        // com.example.Billing.charge, app.services.user.get_user: the longest prefix that is a file.
        const parts = qual.split(/[.:/\\]+/).filter(Boolean);
        for (let n = parts.length - 1; n >= 1; n--) {
          const stem = parts.slice(0, n).join("/");
          const p = byStem.get(stem) ?? [...byStem.entries()].find(([k]) => k.endsWith(`/${stem}`))?.[1];
          if (p) {
            const name = parts[n];
            const sym = name ? findSymbol([p], name, parts[n - 1]) : undefined;
            return { path: p, line: sym?.sym.line, symbol: parts.slice(n).join(".") || undefined, via: "function" };
          }
        }
      }
      // 3. Its tracer is named for a package of the repo, as Go tracers often are.
      const scopeDir = s.scope && s.scope.includes("/") ? goDir(s.scope) : null;
      if (scopeDir) {
        const t = nameTokens(s.name);
        const hit = t.name ? findSymbol(byDir.get(scopeDir) ?? [], t.name, t.container) : undefined;
        const p = hit?.path ?? repOf(scopeDir);
        if (p) return { path: p, line: hit?.sym.line, symbol: hit && symName(hit.sym), via: "scope" };
      }
      // 4. Its name is a symbol here, and only one: "Store.Get", or a long enough camelCase or snake_case name.
      const t = nameTokens(s.name);
      if (t.name && (t.container || (t.name.length >= 6 && /[a-z][A-Z]|_/.test(t.name)))) {
        const langs = sdk ? SDK_LANGS[sdk] : undefined;
        let hits = (bySymbol.get(t.name) ?? []).filter((h) => !langs || langs.includes(langOf(h.path)));
        if (t.container) hits = hits.filter((h) => h.sym.container === t.container || h.path.replace(/\.[^./]+$/, "").endsWith(t.container!));
        if (hits.length === 1) return { path: hits[0].path, line: hits[0].sym.line, symbol: symName(hits[0].sym), via: "name" };
      }
      return undefined;
    }
  };

  return { graph, locate };
}

/* ------------------------------ edges of a trace ------------------------------ */

/** Ids in names (/users/123, a UUID) would make every request its own label. */
const normalize = (s: string) =>
  s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\b[0-9a-f]{24,}\b/gi, ":id")
    .replace(/(?<=[/=])\d+\b/g, ":id")
    .slice(0, 120);

const isOut = (s: TraceSpan) => s.kind === "client" || s.kind === "producer";

function hostOf(s: TraceSpan): string | undefined {
  const a = s.attrs;
  const h = str(a["server.address"]) ?? str(a["net.peer.name"]) ?? str(a["http.host"]) ?? str(a["net.host.name"]);
  if (h) return h;
  const u = str(a["url.full"]) ?? str(a["http.url"]);
  if (u) {
    try {
      return new URL(u).host;
    } catch {
      /* not a URL */
    }
  }
  return undefined;
}

function pathOf(u?: string) {
  try {
    return u ? new URL(u).pathname : undefined;
  } catch {
    return undefined;
  }
}

/** What a span is a call of, by its semantic-convention attributes. */
function callKind(s: TraceSpan): RuntimeEdgeKind | undefined {
  const a = s.attrs;
  if (a["db.system"] !== undefined || a["db.system.name"] !== undefined) return "db";
  if (a["messaging.system"] !== undefined) return "messaging";
  if (a["rpc.system"] !== undefined) return "rpc";
  if (a["http.request.method"] !== undefined || a["http.method"] !== undefined || a["url.full"] !== undefined || a["http.url"] !== undefined) return "http";
  return undefined;
}

function labelOf(s: TraceSpan): string {
  const a = s.attrs;
  switch (callKind(s)) {
    case "http": {
      const method = str(a["http.request.method"]) ?? str(a["http.method"]);
      const route = str(a["http.route"]) ?? str(a["url.path"]) ?? str(a["http.target"]) ?? pathOf(str(a["url.full"]) ?? str(a["http.url"]));
      return normalize(method && route ? `${method} ${route}` : s.name);
    }
    case "rpc":
      return normalize([str(a["rpc.service"]), str(a["rpc.method"])].filter(Boolean).join("/") || s.name);
    case "messaging":
      return normalize(str(a["messaging.destination.name"]) ?? str(a["messaging.destination"]) ?? s.name);
    case "db": {
      const op = str(a["db.operation.name"]) ?? str(a["db.operation"]);
      const table = str(a["db.collection.name"]) ?? str(a["db.sql.table"]) ?? str(a["db.mongodb.collection"]);
      return normalize(op ? [op, table].filter(Boolean).join(" ") : s.name);
    }
    default:
      return normalize(s.name);
  }
}

/** The thing outside the repo a leaf client span talks to. */
function externalOf(s: TraceSpan): RuntimeExternal | undefined {
  const a = s.attrs;
  const db = str(a["db.system.name"]) ?? str(a["db.system"]);
  if (db) {
    const name = str(a["db.namespace"]) ?? str(a["db.name"]);
    return { id: `ext:db:${db}${name ? `/${name}` : ""}`, kind: "db", label: name ? `${db} ${name}` : db, system: db };
  }
  const mq = str(a["messaging.system"]);
  if (mq) {
    const dest = str(a["messaging.destination.name"]) ?? str(a["messaging.destination"]);
    return { id: `ext:messaging:${mq}${dest ? `/${normalize(dest)}` : ""}`, kind: "messaging", label: dest ? `${mq} ${dest}` : mq, system: mq };
  }
  const peer = str(a["peer.service"]);
  if (peer) return { id: `ext:service:${peer}`, kind: "service", label: peer };
  const rpc = str(a["rpc.service"]);
  if (rpc) return { id: `ext:rpc:${rpc}`, kind: "rpc", label: rpc, system: str(a["rpc.system"]) };
  const host = hostOf(s);
  if (host) return { id: `ext:http:${host}`, kind: "http", label: host };
  return undefined;
}

/**
 * A place a span runs in while walking a trace: a file, or a service whose
 * code hasn't been seen yet (its first mapped span settles it, and gets the
 * edge that was waiting on it).
 */
type Place = { service: string; node?: string; symbol?: string; waiting?: () => void };

function addTrace(t: Totals, spans: TraceSpan[], locate: Resolver["locate"]) {
  if (!spans.length) return;
  t.traces++;
  const ids = new Map(spans.map((s) => [s.spanId, s]));
  const kids = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const s of spans) {
    if (s.parentId && ids.has(s.parentId) && s.parentId !== s.spanId) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
    else roots.push(s);
  }
  for (const list of kids.values()) list.sort((a, b) => a.start - b.start);
  const traceId = spans[0].traceId;

  const edge = (from: string, to: string, kind: RuntimeEdgeKind, at: TraceSpan, o: { fromService: string; toService?: string; label: string; fromSym?: string; toSym?: string }) => {
    if (from === to) return;
    const key = [from, to, kind, o.fromService, o.toService ?? ""].join("\0");
    const e = (t.edges[key] ??= {
      from,
      to,
      kind,
      fromService: o.fromService,
      toService: o.toService,
      labels: {},
      calls: {},
      count: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      firstSeen: at.start,
      lastSeen: at.start,
      traces: [],
    });
    e.count++;
    if (at.error) e.errors++;
    e.totalMs += at.ms;
    e.maxMs = Math.max(e.maxMs, at.ms);
    e.firstSeen = Math.min(e.firstSeen, at.start);
    e.lastSeen = Math.max(e.lastSeen, at.start);
    bump(e.labels, o.label, 1, MAX_LABELS);
    if (o.fromSym || o.toSym) bump(e.calls, `${o.fromSym ?? ""}\0${o.toSym ?? ""}`, 1, MAX_CALLS);
    if (!e.traces.includes(traceId)) e.traces = [traceId, ...e.traces].slice(0, TRACES_PER_EDGE);
  };

  const serviceOf = (s: TraceSpan) => {
    const a = s.attrs;
    return (t.services[s.service] ??= {
      name: s.service,
      executable: str(a["resource.process.executable.name"]),
      executablePath: str(a["resource.process.executable.path"]),
      language: str(a["resource.telemetry.sdk.language"]),
      namespace: str(a["resource.service.namespace"]),
      spans: 0,
      errors: 0,
      firstSeen: s.start,
      lastSeen: s.start,
      files: {},
      entries: {},
    });
  };

  const nodeOf = (p: Place) => p.node ?? `svc:${p.service}`;

  // Depth first, iteratively: a deep trace mustn't run out of stack.
  const stack: [TraceSpan, Place | null, TraceSpan | undefined][] = roots
    .sort((a, b) => b.start - a.start)
    .map((r) => [r, null, undefined]);
  const finish: (() => void)[] = [];
  while (stack.length) {
    const [s, at, via] = stack.pop()!;
    const loc = locate(s);
    const svc = serviceOf(s);
    t.spans++;
    svc.spans++;
    if (s.error) svc.errors++;
    svc.firstSeen = Math.min(svc.firstSeen, s.start);
    svc.lastSeen = Math.max(svc.lastSeen, s.start);
    t.firstSeen = min(t.firstSeen, s.start);
    t.lastSeen = max(t.lastSeen, s.start);
    if (loc) {
      t.mapped++;
      svc.files[loc.path] = (svc.files[loc.path] ?? 0) + 1;
    } else {
      const k = [s.service, normalize(s.name), s.scope ?? ""].join("\0");
      if (t.unmapped[k]) t.unmapped[k].count++;
      else if (Object.keys(t.unmapped).length < MAX_UNMAPPED) t.unmapped[k] = { service: s.service, name: normalize(s.name), scope: s.scope, count: 1 };
    }

    let here: Place;
    if (!at || at.service !== s.service) {
      // A request entering a service: a root, or a call over from another one.
      here = { service: s.service, node: loc?.path, symbol: loc?.symbol };
      if (loc) svc.entries[loc.path] = (svc.entries[loc.path] ?? 0) + 1;
      if (at) {
        const caller = { node: nodeOf(at), sym: at.symbol, service: at.service };
        const kind = (via && callKind(via)) ?? callKind(s) ?? "rpc";
        const label = labelOf(callKind(s) ? s : (via ?? s));
        const draw = (to: string, toSym?: string) =>
          edge(caller.node, to, kind === "db" ? "rpc" : kind, s, { fromService: caller.service, toService: s.service, label, fromSym: caller.sym, toSym });
        if (loc) draw(loc.path, loc.symbol);
        else {
          // Its code isn't known yet: the first of its spans that is settles where the call landed.
          let done = false;
          here.waiting = () => {
            if (done) return;
            done = true;
            draw(nodeOf(here), here.symbol);
          };
          finish.push(here.waiting);
        }
      }
    } else if (loc) {
      if (!at.node) {
        // The first of this service's code in a request it took: that's where it came in.
        at.node = loc.path;
        at.symbol = loc.symbol;
        svc.entries[loc.path] = (svc.entries[loc.path] ?? 0) + 1;
        at.waiting?.();
        here = at;
      } else {
        const kind = (via && callKind(via)) ?? "call";
        edge(at.node, loc.path, kind === "db" ? "call" : kind, s, { fromService: s.service, label: labelOf(via ?? s), fromSym: at.symbol, toSym: loc.symbol });
        here = { service: s.service, node: loc.path, symbol: loc.symbol };
      }
    } else {
      here = at;
    }

    const children = kids.get(s.spanId) ?? [];
    // A call out that nothing on the other side answered: a database, a host, a service that doesn't trace.
    if (isOut(s) && !children.some((c) => c.service !== s.service)) {
      const ext = externalOf(s);
      if (ext) {
        t.externals[ext.id] = ext;
        const kind: RuntimeEdgeKind = ext.kind === "service" ? "rpc" : ext.kind === "db" || ext.kind === "messaging" || ext.kind === "rpc" || ext.kind === "http" ? ext.kind : "external";
        edge(nodeOf(here), ext.id, kind, s, { fromService: s.service, label: labelOf(s), fromSym: loc?.symbol ?? here.symbol });
      }
    }
    const nextVia = isOut(s) ? s : at && at.service === s.service && !loc ? via : undefined;
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], here, nextVia]);
  }
  for (const f of finish) f();
}

/* --------------------------------- the store --------------------------------- */

type Store = {
  root: string;
  /** Recent traces, whole, oldest first. */
  traces: Map<string, TraceSpan[]>;
  spanCount: number;
  /** Everything older, added up. */
  settled: Totals;
  version: number;
  sources: Map<string, TraceSourceStatus>;
  built?: { version: number; graph: GraphIndex["graph"]; totals: Totals };
};

let store: Store | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
/** Where spans come from, for every repo: set at boot. */
const sources = new Map<string, TraceSourceStatus>();

/** The open repo's store, loaded from disk the first time. */
async function current(): Promise<Store | null> {
  const root = session.state.repo?.root;
  if (!root || !session.idx) return null;
  if (store?.root === root) return store;
  if (store) await save(store);
  const next: Store = { root, traces: new Map(), spanCount: 0, settled: emptyTotals(), version: 0, sources };
  try {
    const saved = JSON.parse(await readFile(cacheFile(root, ".runtime"), "utf8")) as Totals;
    if (saved && typeof saved === "object" && saved.edges) next.settled = { ...emptyTotals(), ...saved };
  } catch {
    /* nothing kept yet */
  }
  // Another repo may have opened while that was read.
  if (session.state.repo?.root !== root) return null;
  store = next;
  return store;
}

/** Everything: the settled totals and the traces held whole. Rebuilt only when something changed. */
async function totals(s: Store): Promise<Totals> {
  const idx = session.idx!;
  if (s.built && s.built.version === s.version && s.built.graph === idx.graph) return s.built.totals;
  const { locate } = await resolverFor(idx);
  const t = emptyTotals();
  addTotals(t, s.settled);
  for (const spans of s.traces.values()) addTrace(t, spans, locate);
  s.built = { version: s.version, graph: idx.graph, totals: t };
  return t;
}

async function save(s: Store) {
  try {
    const t = await totals(s).catch(() => s.settled);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile(s.root, ".runtime"), JSON.stringify(t));
  } catch (err) {
    console.error("[traces] could not save:", err);
  }
}

function status(s: Store | null): RuntimeStatus {
  const services = new Set<string>(Object.keys(s?.settled.services ?? {}));
  let live = 0;
  for (const spans of s?.traces.values() ?? []) {
    live += spans.length;
    for (const sp of spans) services.add(sp.service);
  }
  return {
    version: s?.version ?? 0,
    spans: (s?.settled.spans ?? 0) + live,
    traces: (s?.settled.traces ?? 0) + (s?.traces.size ?? 0),
    services: [...services].sort(),
    lastAt: max(s?.settled.lastSeen, [...sources.values()].reduce<number | undefined>((m, x) => max(m, x.lastAt), undefined)),
    sources: [...sources.values()],
  };
}

/** Say on the stream that the runtime layer moved, at most every second or so. */
function announce() {
  statusTimer ??= setTimeout(() => {
    statusTimer = undefined;
    if (!session.state.repo) return;
    session.state.runtime = status(store?.root === session.state.repo.root ? store : null);
    void goAppsRuntime().finally(emitLive);
  }, 1000);
}

/** The Go apps grouping, redrawn with what the traces say now. */
async function goAppsRuntime() {
  const graph = session.idx?.graph;
  if (!graph || !session.state.lenses.some((l) => l.id === GO_APPS)) return;
  const map = await runtimeMap().catch(() => null);
  if (session.idx?.graph === graph) refreshGoApps(graph, map);
}

/** Called when a repo opens: its runtime layer, from disk. */
export async function openTraces() {
  const s = await current();
  if (session.state.repo) session.state.runtime = status(s);
  await goAppsRuntime();
  emitLive();
  pullNow?.();
}

export class NoRepoError extends Error {}

/** Take spans in for the open repo. Returns how many were kept. */
export async function ingest(spans: TraceSpan[], from: TraceSourceStatus["kind"], url?: string): Promise<number> {
  // Pushed spans are one source, whichever port they came in on.
  const key = from === "otlp" ? "otlp" : from + (url ?? "");
  const src = sources.get(key) ?? { kind: from, url, ok: true, spans: 0 };
  sources.set(key, src);
  const s = await current();
  if (!s) throw new NoRepoError("No repository open.");
  let kept = 0;
  for (const sp of spans) {
    const list = s.traces.get(sp.traceId);
    if (list) {
      if (list.length >= SPANS_PER_TRACE || list.some((x) => x.spanId === sp.spanId)) continue;
      list.push(sp);
      // Still arriving: keep it among the newest.
      s.traces.delete(sp.traceId);
      s.traces.set(sp.traceId, list);
    } else s.traces.set(sp.traceId, [sp]);
    s.spanCount++;
    kept++;
  }
  // Fold the oldest traces into the totals once there are too many spans to hold.
  if (s.spanCount > SPAN_LIMIT) {
    const { locate } = await resolverFor(session.idx!);
    for (const [id, list] of s.traces) {
      if (s.spanCount <= SPAN_LIMIT * 0.9) break;
      addTrace(s.settled, list, locate);
      s.traces.delete(id);
      s.spanCount -= list.length;
    }
  }
  if (kept) {
    s.version++;
    src.spans += kept;
    src.lastAt = Date.now();
  }
  src.ok = true;
  src.error = undefined;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(s), 10_000);
  announce();
  return kept;
}

/** Forget every trace taken in for the open repo. */
export async function clearTraces() {
  const s = await current();
  if (!s) return;
  s.traces.clear();
  s.spanCount = 0;
  s.settled = emptyTotals();
  s.version++;
  s.built = undefined;
  await rm(cacheFile(s.root, ".runtime"), { force: true });
  announce();
}

/* ---------------------------------- reading ---------------------------------- */

const sortedCounts = (table: Record<string, number>) => Object.entries(table).sort((a, b) => b[1] - a[1]);

/**
 * The runtime map. `services` keeps the edges that leave or enter those
 * services; `path` the edges that touch that file.
 */
export async function runtimeMap(filter: { services?: string[]; path?: string } = {}): Promise<RuntimeMap | null> {
  const s = await current();
  if (!s) return null;
  const idx = session.idx!;
  const t = await totals(s);
  const imports = new Set(idx.graph.imports.map((e) => `${e.from}\0${e.to}`));
  const dirOf = (p: string) => path.posix.dirname(p);
  const verdict = (e: EdgeAcc): RuntimeEdge["verdict"] => {
    if (!idx.byPath.has(e.from) || !idx.byPath.has(e.to)) return undefined;
    if (imports.has(`${e.from}\0${e.to}`)) return "confirmed";
    if (e.from.endsWith(".go") && e.to.endsWith(".go") && dirOf(e.from) === dirOf(e.to)) return "package";
    return "runtime-only";
  };
  const wanted = filter.services?.length ? new Set(filter.services) : null;
  const edges: RuntimeEdge[] = Object.values(t.edges)
    .filter((e) => !wanted || wanted.has(e.fromService) || (e.toService && wanted.has(e.toService)))
    .filter((e) => !filter.path || e.from === filter.path || e.to === filter.path)
    .map((e) => ({
      ...e,
      labels: sortedCounts(e.labels).map(([label, count]) => ({ label, count })),
      calls: sortedCounts(e.calls).map(([k, count]) => {
        const [from, to] = k.split("\0");
        return { from: from || undefined, to: to || undefined, count };
      }),
      verdict: verdict(e),
    }))
    .sort((a, b) => b.count - a.count);

  const services: RuntimeService[] = Object.values(t.services)
    .filter((x) => !wanted || wanted.has(x.name))
    .map((x) => ({
      ...x,
      files: sortedCounts(x.files).map(([path, spans]) => ({ path, spans })),
      entries: sortedCounts(x.entries).map(([path, count]) => ({ path, count })),
    }))
    .sort((a, b) => b.spans - a.spans);

  // Imports between files that both ran, never seen used.
  const ran = new Set(services.flatMap((x) => x.files.map((f) => f.path)));
  const used = new Set(edges.map((e) => `${e.from}\0${e.to}`));
  const dormant = filter.path
    ? []
    : idx.graph.imports.filter((e) => ran.has(e.from) && ran.has(e.to) && !used.has(`${e.from}\0${e.to}`)).slice(0, 500).map((e) => ({ from: e.from, to: e.to }));

  const named = new Set(edges.map((e) => e.to));
  return {
    spans: t.spans,
    mapped: t.mapped,
    traces: t.traces,
    firstSeen: t.firstSeen,
    lastSeen: t.lastSeen,
    services,
    externals: Object.values(t.externals).filter((x) => !wanted || named.has(x.id)),
    edges,
    dormant,
    unmapped: Object.values(t.unmapped)
      .filter((u) => !wanted || wanted.has(u.service))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100),
  };
}

/** The traces held whole, newest first. */
export async function listTraces(opts: { service?: string; limit?: number } = {}): Promise<TraceSummary[] | null> {
  const s = await current();
  if (!s) return null;
  const { locate } = await resolverFor(session.idx!);
  const out: TraceSummary[] = [];
  for (const [traceId, spans] of [...s.traces].reverse()) {
    if (opts.service && !spans.some((x) => x.service === opts.service)) continue;
    const ids = new Set(spans.map((x) => x.spanId));
    const root = spans.find((x) => !x.parentId) ?? spans.find((x) => !ids.has(x.parentId!)) ?? spans[0];
    const start = Math.min(...spans.map((x) => x.start));
    const end = Math.max(...spans.map((x) => x.start + x.ms));
    out.push({
      traceId,
      root: root.name,
      services: [...new Set(spans.map((x) => x.service))],
      start,
      ms: end - start,
      spans: spans.length,
      errors: spans.filter((x) => x.error).length,
      mapped: spans.filter((x) => locate(x)).length,
    });
    if (out.length >= (opts.limit ?? 50)) break;
  }
  return out;
}

/** One trace, span by span, each pinned to where it ran. */
export async function getTrace(traceId: string): Promise<TraceSpan[] | null> {
  const s = await current();
  const spans = s?.traces.get(traceId.toLowerCase());
  if (!spans) return null;
  const { locate } = await resolverFor(session.idx!);
  return [...spans].sort((a, b) => a.start - b.start).map((x) => ({ ...x, loc: locate(x) }));
}

/* ------------------------------ pulled sources ------------------------------ */

const POLL_SECONDS = Number(process.env.CONSTELLATE_TRACE_POLL_SECONDS ?? 30);
const PULL_SERVICES = (process.env.CONSTELLATE_TRACE_SERVICES ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
/** Poll the pulled sources now, as when a repo has just opened (set while there are any). */
let pullNow: (() => void) | undefined;
/** Per poll, so a first look at a busy backend doesn't fetch it all. */
const PULL_TRACES = 40;

function pullHeaders(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { Accept: "application/json", ...extra };
  if (process.env.CONSTELLATE_TRACE_AUTH) h.Authorization = process.env.CONSTELLATE_TRACE_AUTH;
  return h;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).pathname}`);
  return res.json();
}

/** One puller: what it has fetched already, and from when to look next. */
type Puller = { kind: "tempo" | "jaeger"; url: string; seen: Set<string>; since: number; started?: boolean; fetch: (p: Puller, end: number) => Promise<string[] | void> };

async function pullTempo(p: Puller, end: number) {
  const headers = pullHeaders(process.env.CONSTELLATE_TEMPO_TENANT ? { "X-Scope-OrgID": process.env.CONSTELLATE_TEMPO_TENANT } : {});
  const ids: string[] = [];
  for (const svc of PULL_SERVICES.length ? PULL_SERVICES : [undefined]) {
    const q = new URLSearchParams({ start: String(Math.floor(p.since / 1000)), end: String(Math.ceil(end / 1000)), limit: String(PULL_TRACES) });
    if (svc) q.set("tags", `service.name=${svc}`);
    const found = (await getJson(`${p.url}/api/search?${q}`, headers)) as { traces?: { traceID: string }[] };
    for (const tr of found.traces ?? []) if (!p.seen.has(tr.traceID)) ids.push(tr.traceID);
  }
  for (const id of ids.slice(0, PULL_TRACES)) {
    const doc = await getJson(`${p.url}/api/traces/${id}`, headers);
    p.seen.add(id);
    await ingest(parseOtlpJson(doc), "tempo", p.url);
  }
}

async function pullJaeger(p: Puller, end: number) {
  const headers = pullHeaders();
  let services = PULL_SERVICES;
  if (!services.length) {
    const list = (await getJson(`${p.url}/api/services`, headers)) as { data?: string[] };
    // Jaeger traces itself; that's not what's being mapped.
    services = (list.data ?? []).filter((x) => !/^jaeger(-all-in-one|-query|-collector)?$/.test(x));
  }
  for (const svc of services) {
    const q = new URLSearchParams({ service: svc, start: String(p.since * 1000), end: String(end * 1000), limit: String(PULL_TRACES) });
    const found = (await getJson(`${p.url}/api/traces?${q}`, headers)) as { data?: { traceID: string }[] };
    for (const tr of found.data ?? []) {
      if (p.seen.has(tr.traceID)) continue;
      p.seen.add(tr.traceID);
      await ingest(parseJaeger(tr), "jaeger", p.url);
    }
  }
}

/**
 * Pull from Tempo (CONSTELLATE_TEMPO_URL) and Jaeger (CONSTELLATE_JAEGER_URL)
 * every CONSTELLATE_TRACE_POLL_SECONDS, into whichever repo is open.
 */
export function startPulling() {
  const pullers: Puller[] = [];
  const back = Date.now() - 15 * 60_000;
  const tempo = process.env.CONSTELLATE_TEMPO_URL?.replace(/\/+$/, "");
  const jaeger = process.env.CONSTELLATE_JAEGER_URL?.replace(/\/+$/, "");
  if (tempo) pullers.push({ kind: "tempo", url: tempo, seen: new Set(), since: back, fetch: pullTempo });
  if (jaeger) pullers.push({ kind: "jaeger", url: jaeger, seen: new Set(), since: back, fetch: pullJaeger });
  if (!pullers.length || POLL_SECONDS <= 0) return;
  for (const p of pullers) sources.set(p.kind + p.url, { kind: p.kind, url: p.url, ok: true, spans: 0 });
  const tick = async () => {
    for (const p of pullers) {
      const src = sources.get(p.kind + p.url)!;
      const store = await current();
      if (!store) continue;
      // After a restart, from where the saved totals end: what's in them was pulled already.
      if (!p.started) {
        p.since = Math.max(p.since, (store.settled.lastSeen ?? 0) + 1);
        p.started = true;
      }
      const end = Date.now();
      try {
        await p.fetch(p, end);
        // Look back a little each time: a trace's spans land in the backend a while after it starts.
        p.since = end - 2 * 60_000;
        if (p.seen.size > 20_000) p.seen = new Set([...p.seen].slice(-10_000));
        src.ok = true;
        src.error = undefined;
      } catch (err) {
        if (err instanceof NoRepoError) continue;
        src.ok = false;
        src.error = err instanceof Error ? err.message : String(err);
        console.error(`[traces] ${p.kind}:`, src.error);
      }
      announce();
    }
  };
  let running = false;
  pullNow = () => {
    if (running) return;
    running = true;
    void tick().finally(() => (running = false));
  };
  setInterval(pullNow, POLL_SECONDS * 1000);
  console.log(`     (pulling traces from ${pullers.map((p) => `${p.kind} at ${p.url}`).join(" and ")})\n`);
}

/** Say where pushed spans go, for the status line. */
export function noteOtlp(url: string) {
  const src = sources.get("otlp") ?? { kind: "otlp", ok: true, spans: 0 };
  src.url = url;
  sources.set("otlp", src);
}
