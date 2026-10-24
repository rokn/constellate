import type { Lens, LogicalEdge, LogicalModule, RepoGraph } from "./types";

/**
 * The Go view: every executable (a `package main`) is an app, holding the
 * packages only it reaches, and the packages two or more apps reach are the
 * shared libraries between them. Built from the import graph alone, so it's
 * there as soon as the scan is, and rebuilt with every scan.
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
