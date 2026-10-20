import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FileInfo, ImportEdge, RepoGraph, Symbol } from "../shared/types";

/**
 * The static scan: a map of the repository in a few seconds, with no model in
 * the loop. Files, sizes, symbols, and the import graph, resolved to real
 * paths. It is deliberately regex-based rather than a parser per language — it
 * has to work on whatever repo is opened, and a missed import costs an edge,
 * not a crash. The navigator fills in what static analysis can't see.
 */

const run = promisify(execFile);

/** Past this the graph stops being navigable anyway; the rest is counted, not drawn. */
const MAX_FILES = 3500;
const MAX_BYTES = 400_000;

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  scala: "scala", rb: "ruby", php: "php", cs: "csharp", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", hh: "cpp", m: "objective-c",
  vue: "vue", svelte: "svelte", astro: "astro",
  css: "css", scss: "scss", sass: "sass", less: "less",
  html: "html", sql: "sql", graphql: "graphql", gql: "graphql", proto: "proto",
  sh: "bash", bash: "bash", zsh: "bash", lua: "lua", ex: "elixir", exs: "elixir",
  erl: "erlang", hs: "haskell", ml: "ocaml", clj: "clojure", dart: "dart", zig: "zig",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown", mdx: "mdx",
  tf: "hcl", prisma: "prisma",
};

/** Docs and config are on the map, but they don't get to dominate it. */
const QUIET_LANGS = new Set(["json", "yaml", "toml", "markdown", "mdx"]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  "coverage", "target", "vendor", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
  ".pytest_cache", ".turbo", ".cache", ".idea", ".vscode", "bin", "obj", ".gradle",
]);

const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$|\.d\.ts$/;

function langOf(p: string): string | null {
  const base = path.basename(p);
  if (base === "Dockerfile") return "docker";
  if (base === "Makefile") return "make";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? null;
}

async function listFiles(root: string): Promise<string[]> {
  // git knows what is ignored far better than we do; fall back to a walk only
  // when this isn't a repository.
  try {
    const { stdout } = await run("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split("\n").filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (out.length > MAX_FILES * 4) return;
      for (const ent of await readdir(path.join(root, dir), { withFileTypes: true })) {
        if (ent.name.startsWith(".") && ent.name !== ".github") continue;
        const rel = dir ? `${dir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) await walk(rel);
        } else if (ent.isFile()) out.push(rel);
      }
    };
    await walk("");
    return out;
  }
}

async function gitInfo(root: string) {
  try {
    const [b, h] = await Promise.all([
      run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }),
      run("git", ["rev-parse", "HEAD"], { cwd: root }),
    ]);
    return { branch: b.stdout.trim(), head: h.stdout.trim() };
  } catch {
    return {};
  }
}

/* ----------------------------- extraction ----------------------------- */

type Raw = {
  spec: string;
  kind: "rel" | "abs" | "py" | "go" | "rust" | "jvm" | "include";
  /** Go: the name the importer uses for the package, when it renames it (or `_` / `.`). */
  alias?: string;
};

function extractImports(lang: string, text: string): Raw[] {
  const out: Raw[] = [];
  const push = (spec: string, kind: Raw["kind"], alias?: string) => spec && out.push({ spec, kind, alias });

  switch (lang) {
    case "typescript": case "tsx": case "javascript": case "jsx":
    case "vue": case "svelte": case "astro": {
      const re =
        /(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
      for (const m of text.matchAll(re)) {
        const s = m[1] ?? m[2] ?? m[3];
        push(s, s.startsWith(".") ? "rel" : "abs");
      }
      break;
    }
    case "css": case "scss": case "sass": case "less":
      for (const m of text.matchAll(/@(?:import|use|forward)\s+(?:url\()?["']([^"']+)["']/g)) {
        push(m[1], m[1].startsWith(".") ? "rel" : "abs");
      }
      break;
    case "python":
      for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([\w*, ()]+)/gm)) {
        push(m[1], "py");
        // `from pkg import mod` may name submodules; try each as pkg.mod.
        for (const name of m[2].replace(/[()]/g, "").split(",")) {
          const n = name.trim().split(/\s+/)[0];
          if (n && n !== "*") push(`${m[1]}${m[1].endsWith(".") ? "" : "."}${n}`, "py");
        }
      }
      for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
        for (const s of m[1].split(",")) push(s.trim(), "py");
      }
      break;
    case "go": {
      // Keep the alias: `m "x/pkg/models"` means usages read `m.Thing`.
      for (const block of text.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
        for (const m of block[1].matchAll(/^\s*(?:([\w.]+)\s+)?"([^"]+)"/gm)) push(m[2], "go", m[1]);
      }
      for (const m of text.matchAll(/^import\s+(?:([\w.]+)\s+)?"([^"]+)"/gm)) push(m[2], "go", m[1]);
      break;
    }
    case "rust":
      for (const m of text.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) push(`mod:${m[1]}`, "rust");
      for (const m of text.matchAll(/^\s*(?:pub\s+)?use\s+(crate|super|self)::([\w:]+)/gm)) {
        push(`${m[1]}::${m[2]}`, "rust");
      }
      break;
    case "java": case "kotlin": case "scala":
      for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) push(m[1], "jvm");
      break;
    case "ruby":
      for (const m of text.matchAll(/require_relative\s+["']([^"']+)["']/g)) push(`./${m[1]}`, "rel");
      break;
    case "c": case "cpp": case "objective-c":
      for (const m of text.matchAll(/#\s*(?:include|import)\s+"([^"]+)"/g)) push(m[1], "include");
      break;
    case "php":
      for (const m of text.matchAll(/(?:require|include)(?:_once)?\s*\(?\s*__DIR__\s*\.\s*["']([^"']+)["']/g)) {
        push(`.${m[1]}`, "rel");
      }
      break;
  }
  return out;
}

/**
 * Declarations, for the outline, symbol search, and go-to-definition. Each
 * pattern captures [1] the name; members (methods, fields) are attributed to
 * the nearest enclosing declaration with less indentation — the class, impl,
 * or type they belong to. Regexes, not parsers: a declaration missed here
 * costs one jump target, and it works on any repo.
 */
const DECLS: Record<string, { re: RegExp; kind: string; member?: boolean }[]> = {
  ts: [
    { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([\w$]+)/gm, kind: "function" },
    { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/gm, kind: "class" },
    { re: /^(?:export\s+)?(?:declare\s+)?interface\s+([\w$]+)/gm, kind: "interface" },
    { re: /^(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*(?:<[^=]*>)?\s*=/gm, kind: "type" },
    { re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)/gm, kind: "enum" },
    { re: /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\w$]+)\s*[:=]/gm, kind: "const" },
    {
      re: /^[ \t]+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*(#?[\w$]+)\s*(?:<[^>()]*>)?\s*\([^)]*\)\s*(?::\s*[^{=;]+)?\{/gm,
      kind: "method",
      member: true,
    },
  ],
  python: [
    { re: /^(?:async\s+)?def\s+(\w+)/gm, kind: "function" },
    { re: /^class\s+(\w+)/gm, kind: "class" },
    { re: /^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/gm, kind: "const" },
    { re: /^[ \t]+(?:async\s+)?def\s+(\w+)/gm, kind: "method", member: true },
  ],
  go: [
    { re: /^func\s+(\w+)\s*[[(]/gm, kind: "function" },
    // Methods name their receiver type; that is their container.
    { re: /^func\s+\(\s*\w*\s*\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*(\w+)\s*[[(]/gm, kind: "method" },
    { re: /^type\s+(\w+)\b/gm, kind: "type" },
    { re: /^(?:const|var)\s+(\w+)\b/gm, kind: "const" },
  ],
  rust: [
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)/gm, kind: "function" },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+(\w+)/gm, kind: "type" },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)/gm, kind: "type" },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(\w+)/gm, kind: "const" },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/gm, kind: "module" },
    { re: /^impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?(\w+)/gm, kind: "impl" },
    { re: /^[ \t]+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)/gm, kind: "method", member: true },
  ],
  jvm: [
    { re: /^\s*(?:(?:public|private|protected|internal|abstract|final|data|sealed|open|static|inner|enum|annotation)\s+)*(?:class|interface|object|enum|record)\s+(\w+)/gm, kind: "class" },
    { re: /^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open|abstract|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/gm, kind: "function", member: true },
    {
      re: /^[ \t]+(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+[\w<>\[\], ?.]+\s+(\w+)\s*\([^;{]*\)\s*(?:throws\s+[\w., ]+)?\s*\{/gm,
      kind: "method",
      member: true,
    },
  ],
  ruby: [
    { re: /^\s*(?:class|module)\s+([\w:]+)/gm, kind: "class" },
    { re: /^\s*def\s+(?:self\.)?(\w+[?!=]?)/gm, kind: "method", member: true },
  ],
  c: [
    { re: /^(?:typedef\s+)?(?:struct|class|enum|union)\s+(\w+)/gm, kind: "type" },
    { re: /^#define\s+(\w+)/gm, kind: "macro" },
    { re: /^(?:static\s+|inline\s+|extern\s+|virtual\s+)*[\w:*&<>, ]+?[\s*&](\w+)\s*\([^;{]*\)\s*(?:const\s*)?\{/gm, kind: "function" },
  ],
};

const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "else", "do", "try", "new", "with", "super"]);

function symbolFamily(lang: string): string | null {
  if (["typescript", "tsx", "javascript", "jsx", "vue", "svelte", "astro"].includes(lang)) return "ts";
  if (["java", "kotlin", "scala"].includes(lang)) return "jvm";
  if (["c", "cpp", "objective-c"].includes(lang)) return "c";
  return DECLS[lang] ? lang : null;
}

const MAX_SYMBOLS = 300;

export function extractSymbols(lang: string, text: string): Symbol[] {
  const fam = symbolFamily(lang);
  if (!fam || !text) return [];
  // Line starts, for an offset -> line lookup that doesn't rescan the file.
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const indentOf = (line: number) => {
    const s = text.slice(starts[line - 1], starts[line] ?? text.length);
    return s.length - s.trimStart().length;
  };

  type Raw = Symbol & { indent: number; member: boolean };
  const found: Raw[] = [];
  const seen = new Set<string>();
  for (const { re, kind, member } of DECLS[fam]) {
    for (const m of text.matchAll(re)) {
      // Go methods capture (receiver, name); everything else captures name.
      const [name, container] = fam === "go" && kind === "method" ? [m[2], m[1]] : [m[1], undefined];
      if (!name || NOT_NAMES.has(name)) continue;
      const line = lineAt(m.index! + (m[0].length - m[0].trimStart().length));
      const key = `${name}@${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ name, kind, line, container, indent: indentOf(line), member: !!member });
    }
  }
  found.sort((a, b) => a.line - b.line);

  // Grouped Go declarations: `const ( … )`, `var ( … )`, `type ( … )`.
  if (fam === "go") {
    for (const block of text.matchAll(/^(const|var|type)\s*\(([\s\S]*?)^\)/gm)) {
      const base = block.index! + block[0].indexOf("(") + 1;
      for (const line of block[2].matchAll(/^\t(\w+(?:\s*,\s*\w+)*)\b/gm)) {
        for (const n of line[1].split(",")) {
          const name = n.trim();
          const at = lineAt(base + line.index!);
          if (name && name !== "_" && !seen.has(`${name}@${at}`)) {
            seen.add(`${name}@${at}`);
            found.push({ name, kind: block[1] === "type" ? "type" : "const", line: at, indent: 0, member: false });
          }
        }
      }
    }
    found.sort((a, b) => a.line - b.line);
  }

  // Members belong to the nearest preceding declaration that is less indented.
  const out: Symbol[] = [];
  const stack: Raw[] = [];
  for (const s of found) {
    while (stack.length && stack[stack.length - 1].indent >= s.indent) stack.pop();
    if (s.member && !s.container) {
      const parent = stack[stack.length - 1];
      // A "method" with nothing around it is a plain function written indented.
      if (parent && ["class", "interface", "impl", "type", "module"].includes(parent.kind)) s.container = parent.name;
      else if (!parent && s.kind === "method") s.kind = "function";
      else if (parent) continue; // a nested helper inside a function: not navigable on its own
    }
    if (!s.member || s.kind !== "method" || s.container || s.indent === 0) stack.push(s);
    out.push({ name: s.name, kind: s.kind, line: s.line, ...(s.container ? { container: s.container } : {}) });
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

/* ----------------------------- resolution ----------------------------- */

const JS_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".vue", ".svelte", ".css", ".scss"];
const JS_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs"];

type Aliases = { prefix: string; targets: string[] }[];

/**
 * JSONC -> JSON. Has to walk strings: tsconfig is full of globs like "@/*" and
 * "**\/*.ts" that a regex happily reads as the start and end of a comment.
 */
function stripJsonComments(s: string) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && s[i + 1] === "*") {
      i = s.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** tsconfig/jsconfig `paths`, and workspace package names, become aliases. */
async function loadAliases(root: string, files: Set<string>): Promise<Aliases> {
  const aliases: Aliases = [];
  for (const cfg of [...files].filter((f) => /(^|\/)(tsconfig|jsconfig)(\.\w+)?\.json$/.test(f))) {
    try {
      const json = JSON.parse(stripJsonComments(await readFile(path.join(root, cfg), "utf8")));
      const dir = path.posix.dirname(cfg) === "." ? "" : path.posix.dirname(cfg);
      const base = path.posix.join(dir, json.compilerOptions?.baseUrl ?? ".");
      for (const [k, v] of Object.entries<string[]>(json.compilerOptions?.paths ?? {})) {
        aliases.push({
          prefix: k.replace(/\*$/, ""),
          targets: v.map((t) => path.posix.join(base, t.replace(/\*$/, ""))),
        });
      }
    } catch {
      /* unparseable config is just one alias fewer */
    }
  }
  for (const pkg of [...files].filter((f) => f.endsWith("package.json") && f !== "package.json")) {
    try {
      const json = JSON.parse(await readFile(path.join(root, pkg), "utf8"));
      if (json.name) {
        const dir = path.posix.dirname(pkg);
        const entry = (json.source ?? json.module ?? json.main ?? "") as string;
        aliases.push({ prefix: json.name, targets: [entry ? path.posix.join(dir, entry) : dir] });
        aliases.push({ prefix: `${json.name}/`, targets: [`${dir}/src/`, `${dir}/`] });
      }
    } catch {
      /* ditto */
    }
  }
  // The conventional aliases, for repos that configure them in a bundler
  // rather than in tsconfig. Explicit config sorts ahead of these on ties.
  for (const prefix of ["@/", "~/", "#/"]) {
    aliases.push({ prefix, targets: ["src/", "", "app/"] });
  }
  // Longest prefix first, so `@/components/` beats `@/`.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

function tryJs(base: string, files: Set<string>): string | null {
  const clean = path.posix.normalize(base).replace(/^\.\//, "");
  for (const ext of JS_EXTS) if (files.has(clean + ext)) return clean + ext;
  // `./foo.js` written for ESM output often means `./foo.ts` on disk.
  const noExt = clean.replace(/\.(m|c)?js$/, "");
  if (noExt !== clean) for (const ext of JS_EXTS) if (files.has(noExt + ext)) return noExt + ext;
  for (const idx of JS_INDEX) if (files.has(clean + idx)) return clean + idx;
  return null;
}

type Ctx = {
  files: Set<string>;
  aliases: Aliases;
  /** Every go.mod in the repo, longest module path first, so nested modules win. */
  goModules: { name: string; dir: string }[];
  /** Go package directory -> its name, the file that stands for it, and where each exported name is declared. */
  goPackages: Map<string, GoPackage>;
  /** For suffix lookups (python, jvm, includes): path-without-ext -> path. */
  byStem: Map<string, string[]>;
};

type GoPackage = { name: string; rep: string; decls: Map<string, string> };

/** The repo directory a Go import path names, or null for anything outside the repo. */
function goPackageDir(raw: Raw, ctx: Ctx): string | null {
  const mod = ctx.goModules.find((m) => raw.spec === m.name || raw.spec.startsWith(`${m.name}/`));
  if (!mod) return null;
  const dir = path.posix.normalize(path.posix.join(mod.dir, raw.spec.slice(mod.name.length)));
  return dir === "" ? "." : dir;
}

/**
 * Exported package-level names a Go file declares: funcs (not methods —
 * those are reached through their type), types, consts and vars, including
 * inside grouped `const ( … )` / `var ( … )` / `type ( … )` blocks.
 */
function goDecls(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/^func\s+([A-Z]\w*)\s*[[(]/gm)) names.push(m[1]);
  for (const m of text.matchAll(/^(?:type|const|var)\s+([A-Z]\w*)\b/gm)) names.push(m[1]);
  for (const block of text.matchAll(/^(?:type|const|var)\s*\(([\s\S]*?)^\)/gm)) {
    // One declaration per line, at one tab of indent; `A, B = …` declares both.
    for (const line of block[1].matchAll(/^\t([A-Z]\w*(?:\s*,\s*[A-Z]\w*)*)\b/gm)) {
      for (const n of line[1].split(",")) names.push(n.trim());
    }
  }
  return names;
}

/**
 * Which files of a Go package an importer actually uses. A Go import names a
 * whole package, so pointing it at one file made that file a false hub; this
 * follows the importer's `pkg.Name` references to the files that declare them.
 * Blank and dot imports, and packages where nothing resolves, fall back to the
 * package's stand-in file.
 */
function goTargets(raw: Raw, text: string, ctx: Ctx): string[] | null {
  const dir = goPackageDir(raw, ctx);
  if (!dir) return null;
  const pkg = ctx.goPackages.get(dir);
  if (!pkg) return null;
  const alias = raw.alias ?? pkg.name;
  if (alias === "_" || alias === ".") return [pkg.rep];
  const used = new Set<string>();
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of text.matchAll(new RegExp(`\\b${esc}\\.([A-Z]\\w*)`, "g"))) {
    const file = pkg.decls.get(m[1]);
    if (file) used.add(file);
  }
  return used.size ? [...used] : [pkg.rep];
}

function bySuffix(ctx: Ctx, stem: string): string | null {
  const hits = ctx.byStem.get(stem.split("/").pop()!) ?? [];
  const match = hits.filter((h) => h.replace(/\.\w+$/, "").endsWith(stem));
  return match.length === 1 ? match[0] : (match.sort((a, b) => a.length - b.length)[0] ?? null);
}

function resolve(from: string, raw: Raw, ctx: Ctx): string | null {
  const dir = path.posix.dirname(from);
  switch (raw.kind) {
    case "rel":
      return tryJs(path.posix.join(dir, raw.spec), ctx.files);
    case "abs": {
      for (const a of ctx.aliases) {
        if (raw.spec === a.prefix || raw.spec.startsWith(a.prefix)) {
          const rest = raw.spec.slice(a.prefix.length);
          for (const t of a.targets) {
            const hit = tryJs(path.posix.join(t, rest), ctx.files);
            if (hit) return hit;
          }
        }
      }
      return null;
    }
    case "py": {
      let spec = raw.spec;
      let base = "";
      const dots = spec.match(/^\.+/)?.[0].length ?? 0;
      if (dots) {
        base = dir;
        for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
        spec = spec.slice(dots);
      }
      const rel = spec.replace(/\./g, "/");
      const stem = base ? path.posix.join(base, rel) : rel;
      for (const c of [`${stem}.py`, `${stem}/__init__.py`]) if (ctx.files.has(c)) return c;
      if (!base && rel) {
        for (const c of [`src/${rel}.py`, `src/${rel}/__init__.py`]) if (ctx.files.has(c)) return c;
        const hit = bySuffix(ctx, rel);
        return hit?.endsWith(".py") ? hit : null;
      }
      return null;
    }
    case "go": {
      const dir = goPackageDir(raw, ctx);
      return dir ? ctx.goPackages.get(dir)?.rep ?? null : null;
    }
    case "rust": {
      if (raw.spec.startsWith("mod:")) {
        const name = raw.spec.slice(4);
        const here = /(?:^|\/)(?:lib|main|mod)\.rs$/.test(from) ? dir : from.replace(/\.rs$/, "");
        for (const c of [`${here}/${name}.rs`, `${here}/${name}/mod.rs`]) {
          const n = path.posix.normalize(c);
          if (ctx.files.has(n)) return n;
        }
        return null;
      }
      const parts = raw.spec.split("::");
      const segs = parts.slice(1);
      for (let n = segs.length; n > 0; n--) {
        const hit = bySuffix(ctx, segs.slice(0, n).join("/"));
        if (hit?.endsWith(".rs")) return hit;
      }
      return null;
    }
    case "jvm": {
      const hit = bySuffix(ctx, raw.spec.replace(/\./g, "/"));
      return hit && /\.(java|kt|scala)$/.test(hit) ? hit : null;
    }
    case "include": {
      const local = path.posix.normalize(path.posix.join(dir, raw.spec));
      if (ctx.files.has(local)) return local;
      return bySuffix(ctx, raw.spec.replace(/\.\w+$/, ""));
    }
  }
}

/** Collapses a bare import to its package: `@scope/pkg/x` -> `@scope/pkg`. */
function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.includes(":")) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/* -------------------------------- scan -------------------------------- */

export async function scanRepo(
  root: string,
  onProgress?: (done: number, total: number) => void,
): Promise<RepoGraph> {
  const abs = path.resolve(root);
  const info = await stat(abs);
  if (!info.isDirectory()) throw new Error(`${abs} is not a directory`);

  const all = await listFiles(abs);
  // Read before filtering: go.mod isn't a source file, but Go imports can't be
  // resolved without the module path it declares.
  const goModules: Ctx["goModules"] = [];
  for (const f of all.filter((x) => /(^|\/)go\.mod$/.test(x) && !x.split("/").some((seg) => SKIP_DIRS.has(seg)))) {
    try {
      const m = (await readFile(path.join(abs, f), "utf8")).match(/^module\s+(\S+)/m);
      if (m) goModules.push({ name: m[1], dir: path.posix.dirname(f) });
    } catch {
      /* unreadable go.mod: that module's imports stay unresolved */
    }
  }
  goModules.sort((a, b) => b.name.length - a.name.length);

  const listed = all.filter(
    (f) => !SKIP_FILES.test(f) && !f.split("/").some((seg) => SKIP_DIRS.has(seg)) && langOf(f),
  );

  // Source first: if the repo is over budget, it's the docs and config that
  // fall off the map, not the code.
  listed.sort((a, b) => Number(QUIET_LANGS.has(langOf(a)!)) - Number(QUIET_LANGS.has(langOf(b)!)));
  const kept = listed.slice(0, MAX_FILES);
  const skipped = listed.length - kept.length;
  const fileSet = new Set(kept);

  const texts = new Map<string, string>();
  const files: FileInfo[] = [];
  let done = 0;
  const queue = [...kept];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const lang = langOf(f)!;
      let text = "";
      try {
        const s = await stat(path.join(abs, f));
        if (s.size <= MAX_BYTES) text = await readFile(path.join(abs, f), "utf8");
      } catch {
        /* vanished or unreadable — still on the map, just empty */
      }
      if (text.includes("\u0000")) text = "";
      texts.set(f, text);
      files.push({
        path: f,
        top: f.includes("/") ? f.split("/")[0] : ".",
        lang,
        loc: text ? text.split("\n").length : 0,
        symbols: extractSymbols(lang, text),
        externals: [],
      });
      if (++done % 200 === 0) onProgress?.(done, kept.length);
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  files.sort((a, b) => a.path.localeCompare(b.path));

  const byStem = new Map<string, string[]>();
  for (const f of kept) {
    const stem = path.posix.basename(f).replace(/\.\w+$/, "");
    const key = stem === "__init__" || stem === "mod" || stem === "index"
      ? path.posix.basename(path.posix.dirname(f))
      : stem;
    byStem.set(key, [...(byStem.get(key) ?? []), f]);
  }

  // Each Go package: its declared name, the file that stands for it (named
  // after the package, else doc.go, else the biggest), and which file declares
  // each exported name — so imports can be followed to the files really used.
  const goPackages = new Map<string, GoPackage>();
  const byGoDir = new Map<string, FileInfo[]>();
  for (const f of files) {
    if (f.lang !== "go" || f.path.endsWith("_test.go")) continue;
    const d = path.posix.dirname(f.path);
    byGoDir.set(d, [...(byGoDir.get(d) ?? []), f]);
  }
  for (const [d, list] of byGoDir) {
    const name = path.posix.basename(d === "." ? abs : d);
    const pick =
      list.find((f) => path.posix.basename(f.path) === `${name}.go`) ??
      list.find((f) => path.posix.basename(f.path) === "doc.go") ??
      [...list].sort((a, b) => b.loc - a.loc)[0];
    const decls = new Map<string, string>();
    for (const f of list) for (const n of goDecls(texts.get(f.path) ?? "")) if (!decls.has(n)) decls.set(n, f.path);
    const declared = texts.get(pick.path)?.match(/^package\s+(\w+)/m)?.[1] ?? name;
    goPackages.set(d, { name: declared, rep: pick.path, decls });
  }

  const ctx: Ctx = { files: fileSet, aliases: await loadAliases(abs, fileSet), goModules, goPackages, byStem };
  const edges = new Set<string>();
  const imports: ImportEdge[] = [];
  const externalCounts = new Map<string, number>();
  // A name that is also a directory or module here is the repo importing
  // itself (python's `from mypkg.x import Y`), not a dependency.
  const localNames = new Set(
    kept.flatMap((f) => {
      const segs = f.replace(/^src\//, "").split("/");
      return [segs[0].replace(/\.\w+$/, ""), segs[1]?.replace(/\.\w+$/, "")].filter(Boolean);
    }),
  );

  for (const file of files) {
    const text = texts.get(file.path);
    if (!text) continue;
    const ext = new Set<string>();
    for (const raw of extractImports(file.lang, text)) {
      const resolved = raw.kind === "go" ? goTargets(raw, text, ctx) : resolve(file.path, raw, ctx);
      const tos = resolved === null ? [] : Array.isArray(resolved) ? resolved : [resolved];
      for (const to of tos) {
        if (to === file.path) continue;
        const key = `${file.path}>${to}`;
        if (!edges.has(key)) {
          edges.add(key);
          imports.push({ from: file.path, to });
        }
      }
      if (!tos.length && (raw.kind === "abs" || raw.kind === "py" || raw.kind === "go")) {
        const pkg =
          raw.kind === "py" ? raw.spec.split(".")[0]
            // Go: host/owner/repo is the dependency; a dotless first segment is the standard library.
            : raw.kind === "go" ? (raw.spec.split("/")[0].includes(".") ? raw.spec.split("/").slice(0, 3).join("/") : null)
              : packageOf(raw.spec);
        if (pkg && !raw.spec.startsWith(".") && !localNames.has(pkg)) ext.add(pkg);
      }
    }
    file.externals = [...ext].slice(0, 30);
    for (const e of ext) externalCounts.set(e, (externalCounts.get(e) ?? 0) + 1);
  }

  const dirs = new Set<string>();
  for (const f of kept) {
    let d = path.posix.dirname(f);
    while (d !== "." && !dirs.has(d)) {
      dirs.add(d);
      d = path.posix.dirname(d);
    }
  }

  const languages: Record<string, number> = {};
  let loc = 0;
  for (const f of files) {
    languages[f.lang] = (languages[f.lang] ?? 0) + f.loc;
    loc += f.loc;
  }

  return {
    name: path.basename(abs),
    root: abs,
    ...(await gitInfo(abs)),
    files,
    dirs: [...dirs].sort(),
    imports,
    languages,
    totals: { files: files.length, loc },
    skipped,
    externals: [...externalCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([name, count]) => ({ name, count })),
  };
}

/* ------------------------------ queries ------------------------------ */

export type GraphIndex = {
  graph: RepoGraph;
  byPath: Map<string, FileInfo>;
  out: Map<string, string[]>;
  in: Map<string, string[]>;
};

export function indexGraph(graph: RepoGraph): GraphIndex {
  const byPath = new Map(graph.files.map((f) => [f.path, f]));
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const e of graph.imports) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    inn.set(e.to, [...(inn.get(e.to) ?? []), e.from]);
  }
  return { graph, byPath, out, in: inn };
}

/** Breadth-first neighbourhood in either direction, with the hop distance. */
export function neighbourhood(
  idx: GraphIndex,
  start: string,
  direction: "imports" | "importers" | "both",
  depth: number,
): { path: string; hops: number; via: "imports" | "importers" }[] {
  const seen = new Map<string, { hops: number; via: "imports" | "importers" }>();
  let frontier = [start];
  for (let hop = 1; hop <= depth && frontier.length; hop++) {
    const next: string[] = [];
    for (const p of frontier) {
      const steps: ["imports" | "importers", string[]][] = [];
      if (direction !== "importers") steps.push(["imports", idx.out.get(p) ?? []]);
      if (direction !== "imports") steps.push(["importers", idx.in.get(p) ?? []]);
      for (const [via, list] of steps) {
        for (const q of list) {
          if (q === start || seen.has(q)) continue;
          seen.set(q, { hops: hop, via });
          next.push(q);
        }
      }
    }
    frontier = next;
  }
  return [...seen.entries()].map(([path, v]) => ({ path, ...v }));
}

/** Fuzzy path lookup for when a model (or a voice) gets a path nearly right. */
export function findPath(idx: GraphIndex, guess: string): string | null {
  const clean = guess.trim().replace(/^\.?\//, "").replace(/^`|`$/g, "");
  if (idx.byPath.has(clean)) return clean;
  const lower = clean.toLowerCase();
  const all = idx.graph.files.map((f) => f.path);
  const suffix = all.filter((p) => p.toLowerCase().endsWith(lower));
  if (suffix.length) return suffix.sort((a, b) => a.length - b.length)[0];
  const base = lower.split("/").pop()!;
  const byBase = all.filter((p) => p.toLowerCase().split("/").pop()!.startsWith(base));
  if (byBase.length) return byBase.sort((a, b) => a.length - b.length)[0];
  const contains = all.filter((p) => p.toLowerCase().includes(lower));
  return contains.sort((a, b) => a.length - b.length)[0] ?? null;
}

/**
 * The repo as a compact prompt document: tree with sizes, hubs, entry
 * candidates. It is what lets the intro analysis spend its turns reading the
 * files that matter instead of listing directories.
 */
export function digest(idx: GraphIndex): string {
  const g = idx.graph;
  const langs = Object.entries(g.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([l, n]) => `${l} ${n.toLocaleString()} loc`)
    .join(", ");

  const hubs = [...idx.in.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 25)
    .map(([p, list]) => `  ${p}  ← imported by ${list.length}`);

  // Roots of the import graph that are themselves big are usually entry points.
  const roots = g.files
    .filter((f) => !idx.in.has(f.path) && (idx.out.get(f.path)?.length ?? 0) >= 2)
    .sort((a, b) => (idx.out.get(b.path)?.length ?? 0) - (idx.out.get(a.path)?.length ?? 0))
    .slice(0, 20)
    .map((f) => `  ${f.path}  → imports ${idx.out.get(f.path)!.length}`);

  // Tree: directories with file counts and loc; files listed only in small dirs.
  const byDir = new Map<string, { files: string[]; loc: number }>();
  for (const f of g.files) {
    const d = path.posix.dirname(f.path);
    const e = byDir.get(d) ?? { files: [], loc: 0 };
    e.files.push(path.posix.basename(f.path));
    e.loc += f.loc;
    byDir.set(d, e);
  }
  const tree = [...byDir.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 260)
    .map(([d, e]) =>
      e.files.length <= 8
        ? `  ${d}/  ${e.files.join(", ")}`
        : `  ${d}/  (${e.files.length} files, ${e.loc} loc) ${e.files.slice(0, 6).join(", ")}, …`,
    );

  return [
    `Repository: ${g.name}${g.branch ? ` (branch ${g.branch})` : ""}`,
    `${g.totals.files} files, ${g.totals.loc.toLocaleString()} lines${g.skipped ? ` (+${g.skipped} not scanned)` : ""}`,
    `Languages: ${langs}`,
    g.externals.length ? `Top external packages: ${g.externals.map((e) => e.name).join(", ")}` : "",
    `Resolved in-repo imports: ${g.imports.length}`,
    "",
    "Most-imported files (hubs):",
    ...hubs,
    "",
    "Import-graph roots (likely entry points):",
    ...roots,
    "",
    "Tree:",
    ...tree,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
