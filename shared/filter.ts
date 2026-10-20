import type { FileInfo, MapFilter } from "./types";

/**
 * What's on the map. One implementation, used by the browser to draw and by
 * the navigator and the voice to report how many files a filter leaves — so
 * "showing 40 files" is the same 40 everywhere.
 */

export const EMPTY_FILTER: MapFilter = {
  include: [],
  exclude: [],
  hideTests: false,
  hideDocs: false,
  langs: [],
  tops: [],
};

const TEST = /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|testdata|fixtures?)\/|[._-](test|spec)\.[a-z0-9]+$|_test\.go$|(^|\/)test_[^/]*\.py$|Tests?\.(java|kt|cs)$/i;
const DOC_LANGS = new Set(["markdown", "mdx", "json", "yaml", "toml", "docker", "make", "hcl"]);

export const isTest = (path: string) => TEST.test(path);
export const isDoc = (f: Pick<FileInfo, "lang">) => DOC_LANGS.has(f.lang);

/**
 * Globs as people type them: `internal/**`, `*.go`, `src/api/*`. A pattern
 * with no glob characters is a plain substring, so "auth" finds every path
 * mentioning auth.
 */
export function matcher(pattern: string): (path: string) => boolean {
  const p = pattern.trim().replace(/^\.?\//, "");
  if (!p) return () => false;
  if (!/[*?]/.test(p)) {
    const needle = p.toLowerCase();
    return (path) => path.toLowerCase().includes(needle);
  }
  const re = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  // A pattern without a slash matches a basename anywhere (`*.go`); one with
  // a slash is anchored at the repo root (`internal/**`).
  const rx = new RegExp(p.includes("/") ? `^${re}$` : `(^|/)${re}$`, "i");
  return (path) => rx.test(path);
}

export function isActive(f: MapFilter): boolean {
  return !!(f.include.length || f.exclude.length || f.hideTests || f.hideDocs || f.langs.length || f.tops.length || f.paths || f.hidden?.length || f.isolate?.length);
}

/** The files a filter keeps, or null when the filter keeps everything. */
export function applyFilter(files: FileInfo[], f: MapFilter): Set<string> | null {
  if (!isActive(f)) return null;
  const inc = f.include.map(matcher);
  const exc = f.exclude.map(matcher);
  const langs = new Set(f.langs);
  const tops = new Set(f.tops);
  const only = f.paths ? new Set(f.paths) : null;
  const hidden = new Set(f.hidden ?? []);
  // Isolated modules and folders: the map shows only those in, minus those out.
  // "." is the files at the root itself, not everything under it.
  const inDir = (p: string, d: string) => (d === "." ? !p.includes("/") : p.startsWith(`${d}/`));
  const holds = (items: NonNullable<MapFilter["isolate"]>) => {
    const files = new Set(items.flatMap((i) => (i.kind === "module" ? (i.paths ?? []) : [])));
    const dirs = items.filter((i) => i.kind === "dir").map((i) => i.id);
    return (p: string) => files.has(p) || dirs.some((d) => inDir(p, d));
  };
  const ins = (f.isolate ?? []).filter((i) => !i.exclude);
  const outs = (f.isolate ?? []).filter((i) => i.exclude);
  const isIn = ins.length ? holds(ins) : null;
  const isOut = outs.length ? holds(outs) : null;
  const out = new Set<string>();
  for (const file of files) {
    if (isIn && !isIn(file.path)) continue;
    if (isOut?.(file.path)) continue;
    if (only && !only.has(file.path)) continue;
    if (hidden.has(file.path)) continue;
    if (langs.size && !langs.has(file.lang)) continue;
    if (tops.size && !tops.has(file.top)) continue;
    if (f.hideTests && isTest(file.path)) continue;
    if (f.hideDocs && isDoc(file)) continue;
    if (inc.length && !inc.some((m) => m(file.path))) continue;
    if (exc.some((m) => m(file.path))) continue;
    out.add(file.path);
  }
  return out;
}

/** A short human description, for chips and for the voice. */
export function describe(f: MapFilter): string {
  const ins = (f.isolate ?? []).filter((i) => !i.exclude);
  const outs = (f.isolate ?? []).filter((i) => i.exclude);
  const only = [ins.length ? `only ${ins.map((i) => i.label).join(", ")}` : "", outs.length ? `not ${outs.map((i) => i.label).join(", ")}` : ""]
    .filter(Boolean)
    .join(" · ");
  if (f.label) return [only, f.label, f.hidden?.length ? `${f.hidden.length} hidden` : ""].filter(Boolean).join(" · ");
  const bits = [
    only,
    f.include.length ? `only ${f.include.join(", ")}` : "",
    f.exclude.length ? `without ${f.exclude.join(", ")}` : "",
    f.langs.length ? f.langs.join("/") : "",
    f.tops.length ? `in ${f.tops.join(", ")}` : "",
    f.hideTests ? "no tests" : "",
    f.hideDocs ? "no docs/config" : "",
    f.paths ? `${f.paths.length} chosen files` : "",
    f.hidden?.length ? `${f.hidden.length} hidden` : "",
  ].filter(Boolean);
  return bits.join(" · ") || "everything";
}
