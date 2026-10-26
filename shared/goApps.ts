import type { Lens, LogicalEdge, LogicalModule, RepoGraph, RuntimeEdgeKind, RuntimeMap, RuntimeService } from "./types";

/**
 * The Go view: every executable (a `package main`) is an app, holding the
 * packages only it reaches, and the packages two or more apps reach are the
 * shared libraries between them. Built from the import graph alone, so it's
 * there as soon as the scan is, and rebuilt with every scan. With traces in
 * (withRuntime), it also says what each app really calls when it runs.
 */

export const GO_APPS = "go-apps";

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (list: string[]) => (list.length <= 4 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`);

export function goApps(graph: RepoGraph): Lens | null {
  // Packages by directory: their files (tests ride along with their package), and which are main.
  const files = new Map<string, string[]>();
  const mains = new Set<string>();
  const pkgOf = new Map<string, string>();
  for (const f of graph.files) {
    // The go tool skips testdata/ and folders starting with _ or ., so they build into nothing.
    if (f.lang !== "go" || /(^|\/)(testdata|[_.][^/]*)\//.test(f.path)) continue;
    const d = dirOf(f.path);
    files.set(d, [...(files.get(d) ?? []), f.path]);
    pkgOf.set(f.path, d);
    if (f.goPkg === "main" && !f.path.endsWith("_test.go")) mains.add(d);
  }
  if (!mains.size) return null;

  // What each package imports, tests left out: a test's helpers aren't what the app runs.
  const deps = new Map<string, Set<string>>();
  for (const e of graph.imports) {
    if (e.from.endsWith("_test.go")) continue;
    const a = pkgOf.get(e.from);
    const b = pkgOf.get(e.to);
    if (!a || !b || a === b) continue;
    if (!deps.has(a)) deps.set(a, new Set());
    deps.get(a)!.add(b);
  }

  // Which apps reach each package, directly or through others.
  const reachedBy = new Map<string, string[]>();
  for (const app of mains) {
    const seen = new Set([app]);
    const stack = [app];
    while (stack.length) for (const d of deps.get(stack.pop()!) ?? []) if (!seen.has(d) && !mains.has(d)) (seen.add(d), stack.push(d));
    for (const d of seen) if (d !== app) reachedBy.set(d, [...(reachedBy.get(d) ?? []), app]);
  }

  // An app is called after its folder (cmd/api → api), its full path when two share a name.
  const base = (d: string) => (d === "." ? graph.name : d.split("/").pop()!);
  const taken = new Map<string, number>();
  for (const d of mains) taken.set(base(d), (taken.get(base(d)) ?? 0) + 1);
  const appName = (d: string) => (taken.get(base(d))! > 1 ? d : base(d));

  // A shared package nested in another shared package is part of that library.
  const shared = [...reachedBy].filter(([, apps]) => apps.length > 1).map(([d]) => d);
  const sharedSet = new Set(shared);
  // (Not into the root package, though, which would swallow them all.)
  const libOf = (d: string) => {
    let lib = d;
    for (let p = dirOf(d); p !== "."; p = dirOf(p)) if (sharedSet.has(p)) lib = p;
    return lib;
  };

  const groupOf = new Map<string, string>();
  for (const d of mains) groupOf.set(d, `app:${d}`);
  for (const [d, apps] of reachedBy) groupOf.set(d, apps.length > 1 ? `lib:${libOf(d)}` : `app:${apps[0]}`);
  for (const d of files.keys()) if (!groupOf.has(d)) groupOf.set(d, "unused");

  const members = new Map<string, string[]>();
  for (const [d, g] of groupOf) members.set(g, [...(members.get(g) ?? []), d]);

  const edges = new Map<string, LogicalEdge>();
  for (const [a, bs] of deps) {
    for (const b of bs) {
      const from = groupOf.get(a)!;
      const to = groupOf.get(b)!;
      if (from === to || from === "unused" || to === "unused") continue;
      edges.set(`${from}>${to}`, { from, to, label: "imports", kind: "calls" });
    }
  }
  const uses = (g: string) => [...edges.values()].filter((e) => e.from === g).length;

  const appsOf = (g: string) => [...new Set((members.get(g) ?? []).flatMap((d) => reachedBy.get(d) ?? []))].map(appName).sort();
  const groups: LogicalModule[] = [];
  for (const d of [...mains].sort()) {
    const g = `app:${d}`;
    const own = members.get(g)!.length - 1;
    groups.push({
      id: g,
      label: appName(d),
      summary: `The executable in ${d === "." ? "the repo's root" : `${d}/`}${own ? `, with ${plural(own, "package")} of its own` : ""}${uses(g) ? `; it uses ${plural(uses(g), "shared library", "shared libraries")} directly` : ""}.`,
      paths: members.get(g)!.flatMap((x) => files.get(x)!),
    });
  }
  for (const g of [...members.keys()].filter((g) => g.startsWith("lib:")).sort()) {
    const apps = appsOf(g);
    groups.push({
      id: g,
      label: `${g.slice(4)}/`,
      summary: `A library ${plural(apps.length, "app")} share: ${names(apps)}.`,
      paths: members.get(g)!.flatMap((x) => files.get(x)!),
    });
  }
  if (members.has("unused")) {
    groups.push({
      id: "unused",
      label: "in no app",
      summary: "Go packages no executable here imports: tools, examples, or code on its way out.",
      paths: members.get("unused")!.flatMap((x) => files.get(x)!),
    });
  }

  const libs = groups.filter((g) => g.id.startsWith("lib:")).length;
  return {
    id: GO_APPS,
    title: "Go apps",
    description: `Each Go executable as an app, with the code only it uses; ${plural(mains.size, "app")} and ${plural(libs, "shared library", "shared libraries")} between them. Built from the imports, and rebuilt with every scan.`,
    groups,
    edges: [...edges.values()],
    createdAt: 0,
    derived: true,
  };
}

/* ------------------------------ at runtime ------------------------------ */

const KIND: Record<RuntimeEdgeKind, LogicalEdge["kind"]> = { call: "calls", http: "http", rpc: "calls", messaging: "event", db: "data", external: "other" };
const WORD: Record<RuntimeEdgeKind, string> = { call: "calls", http: "http", rpc: "rpc", messaging: "messages", db: "db", external: "calls" };
const times = (n: number) => `${n.toLocaleString("en")}×`;

/** Which app a service is: its executable's name, else its own name, else where most of its spans ran. */
function appOfService(svc: RuntimeService, apps: LogicalModule[], groupOfPath: Map<string, string>): string | undefined {
  const dir = (g: LogicalModule) => g.id.slice(4);
  const base = (g: LogicalModule) => dir(g).split("/").pop()!;
  const exe = svc.executable?.replace(/\.exe$/, "");
  const hit =
    (exe && apps.find((g) => base(g) === exe)) ||
    (svc.executablePath && apps.find((g) => svc.executablePath!.replace(/\.exe$/, "").endsWith(`/${base(g)}`))) ||
    apps.find((g) => g.label === svc.name || base(g) === svc.name);
  if (hit) return hit.id;
  const spans = new Map<string, number>();
  for (const f of svc.files) {
    const g = groupOfPath.get(f.path);
    if (g?.startsWith("app:")) spans.set(g, (spans.get(g) ?? 0) + f.spans);
  }
  return [...spans].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The Go apps with what the traces say: each import line is marked as seen
 * running or not, calls no import explains (HTTP between services, an
 * interface, a queue) are drawn as lines of their own, and each app's summary
 * names its service and what it calls, the database and hosts outside the
 * repo among them.
 */
export function withRuntime(lens: Lens, rt: RuntimeMap): Lens {
  if (!rt.edges.length && !rt.services.length) return lens;
  const groupOfPath = new Map<string, string>();
  for (const g of lens.groups) for (const p of g.paths) groupOfPath.set(p, g.id);
  const apps = lens.groups.filter((g) => g.id.startsWith("app:"));
  const label = new Map(lens.groups.map((g) => [g.id, g.label]));
  const serviceApp = new Map<string, string | undefined>();
  for (const svc of rt.services) serviceApp.set(svc.name, appOfService(svc, apps, groupOfPath));
  const externals = new Map(rt.externals.map((x) => [x.id, x.label]));

  const nodeGroup = (id: string, service?: string) =>
    id.startsWith("ext:") ? undefined : id.startsWith("svc:") ? serviceApp.get(id.slice(4)) : groupOfPath.get(id) ?? (service ? serviceApp.get(service) : undefined);

  // Every runtime edge, added up between groups; calls out of the repo, by the app making them.
  type Acc = { count: number; errors: number; kind: RuntimeEdgeKind; labels: Map<string, number> };
  const pairs = new Map<string, Acc>();
  const outside = new Map<string, Map<string, number>>();
  const ran = new Set<string>();
  for (const svc of rt.services) {
    for (const f of svc.files) if (groupOfPath.has(f.path)) ran.add(groupOfPath.get(f.path)!);
    const app = serviceApp.get(svc.name);
    if (app) ran.add(app);
  }
  for (const e of rt.edges) {
    let from = nodeGroup(e.from, e.fromService) ?? serviceApp.get(e.fromService);
    if (!from) continue;
    if (e.to.startsWith("ext:")) {
      const app = serviceApp.get(e.fromService) ?? from;
      const out = outside.get(app) ?? new Map<string, number>();
      const name = externals.get(e.to) ?? e.to.split(":").slice(2).join(":");
      out.set(name, (out.get(name) ?? 0) + e.count);
      outside.set(app, out);
      continue;
    }
    // Between services, the apps are what talk, whichever shared library made the call.
    const across = e.toService && e.toService !== e.fromService;
    const to = across ? serviceApp.get(e.toService!) ?? nodeGroup(e.to) : nodeGroup(e.to, e.toService);
    if (across) from = serviceApp.get(e.fromService) ?? from;
    if (!to || to === from) continue;
    const key = `${from}>${to}`;
    const acc = pairs.get(key) ?? { count: 0, errors: 0, kind: e.kind, labels: new Map() };
    acc.count += e.count;
    acc.errors += e.errors;
    // Crossing services says more than an in-process call between the same two groups.
    if (acc.kind === "call" && e.kind !== "call") acc.kind = e.kind;
    for (const l of e.labels) acc.labels.set(l.label, (acc.labels.get(l.label) ?? 0) + l.count);
    pairs.set(key, acc);
  }

  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  const errs = (n: number) => (n ? `, ${n.toLocaleString("en")} failed` : "");
  const edges: LogicalEdge[] = lens.edges.map((e) => {
    const acc = pairs.get(`${e.from}>${e.to}`);
    if (acc) return { ...e, label: `imports · ran ${times(acc.count)}${errs(acc.errors)}` };
    return ran.has(e.from) ? { ...e, label: "imports · not seen running" } : e;
  });
  const statics = new Set(lens.edges.map((e) => `${e.from}>${e.to}`));
  for (const [key, acc] of pairs) {
    if (statics.has(key)) continue;
    const [from, to] = key.split(">");
    const what = top(acc.labels);
    edges.push({ from, to, kind: KIND[acc.kind], label: `${acc.kind === "call" ? "runtime only" : WORD[acc.kind]} ${times(acc.count)}${errs(acc.errors)}${what ? ` · ${what}` : ""}` });
  }

  const byApp = new Map<string, RuntimeService[]>();
  for (const svc of rt.services) {
    const app = serviceApp.get(svc.name);
    if (app) byApp.set(app, [...(byApp.get(app) ?? []), svc]);
  }
  const groups = lens.groups.map((g) => {
    if (!g.id.startsWith("app:")) return ran.has(g.id) ? g : { ...g, summary: `${g.summary} Not seen running.` };
    const svcs = byApp.get(g.id);
    if (!svcs) return { ...g, summary: `${g.summary} No traces from it yet.` };
    const calls = [
      ...[...pairs].filter(([k]) => k.startsWith(`${g.id}>`)).map(([k, acc]) => [`${label.get(k.split(">")[1])!}${acc.kind === "call" ? "" : ` (${WORD[acc.kind]})`}`, acc.count] as const),
      ...(outside.get(g.id) ?? []),
    ]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, n]) => `${name} ${times(n)}`);
    const spans = svcs.reduce((n, s) => n + s.spans, 0);
    const failed = svcs.reduce((n, s) => n + s.errors, 0);
    return {
      ...g,
      summary: `${g.summary} Runs as ${svcs.map((s) => s.name).join(", ")}: ${spans.toLocaleString("en")} spans${errs(failed)}${calls.length ? `; calls ${calls.join(", ")}` : ""}.`,
    };
  });

  const seen = apps.filter((g) => byApp.has(g.id)).length;
  return {
    ...lens,
    description: `${lens.description} Traces: ${seen} of ${plural(apps.length, "app")} seen running, over ${plural(rt.traces, "trace")}.`,
    groups,
    edges,
  };
}
