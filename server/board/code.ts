import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Reading a board's repo, for Jarvis: list files, read one, grep. Scoped to
 * the repo's root — nothing outside it, nothing in .git or node_modules —
 * and capped, so an answer about the code costs a few kilobytes, not the
 * whole tree.
 */

const SKIP = new Set(["node_modules", ".git", "dist", "build", "vendor", ".next", "target", ".venv", "venv", "__pycache__", ".cache", "coverage", ".turbo"]);
const MAX_FILES = 6000;

/** A path inside the root, or null if it would leave it. */
export function inside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel.replace(/^\/+/, ""));
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep) ? abs : null;
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let names: string[];
  try {
    names = await readdir(path.join(root, rel));
  } catch {
    return;
  }
  names.sort();
  for (const n of names) {
    if (out.length >= MAX_FILES) return;
    if (SKIP.has(n) || (n.startsWith(".") && n !== ".github")) continue;
    const r = rel ? `${rel}/${n}` : n;
    try {
      const s = await stat(path.join(root, r));
      if (s.isDirectory()) await walk(root, r, out);
      else if (s.size < 2_000_000) out.push(r);
    } catch {
      /* gone */
    }
  }
}

/** A glob like "src/**\/*.ts" or "*.go", as a regex over repo-relative paths. */
function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A bare name or pattern matches at any depth.
  return new RegExp(glob.includes("/") ? `^${re}$` : `(^|/)${re}$`);
}

/** Files under the root (or a folder of it), matching a glob if given. */
export async function listFiles(root: string, o: { dir?: string; glob?: string; max?: number } = {}): Promise<string> {
  const base = o.dir ? inside(root, o.dir) : path.resolve(root);
  if (!base) return "That folder is outside the repo.";
  const rel = path.relative(root, base).split(path.sep).join("/");
  const all: string[] = [];
  await walk(root, rel, all);
  const re = o.glob ? globRe(o.glob) : null;
  const hits = re ? all.filter((f) => re.test(f)) : all;
  const max = Math.min(400, o.max ?? 200);
  return hits.length ? `${hits.slice(0, max).join("\n")}${hits.length > max ? `\n… and ${hits.length - max} more (narrow it with dir or glob)` : ""}` : "No files match.";
}

/** One file, or a stretch of its lines. */
export async function readCode(root: string, file: string, from = 1, lines = 250): Promise<string> {
  const abs = inside(root, file);
  if (!abs) return "That file is outside the repo.";
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    return `No such file: ${file}`;
  }
  const all = text.split("\n");
  const start = Math.max(1, Math.floor(from));
  const n = Math.max(1, Math.min(600, Math.floor(lines)));
  const part = all.slice(start - 1, start - 1 + n).map((l, i) => `${String(start + i).padStart(5)}  ${l.slice(0, 400)}`);
  const more = start - 1 + n < all.length ? `\n… ${all.length - (start - 1 + n)} more lines (from ${start + n})` : "";
  return `${file} (${all.length} lines)\n${part.join("\n")}${more}`;
}

/** Lines matching a regex (case-insensitive), across files matching a glob. */
export async function grepCode(root: string, pattern: string, o: { glob?: string; dir?: string; max?: number } = {}): Promise<string> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const base = o.dir ? inside(root, o.dir) : path.resolve(root);
  if (!base) return "That folder is outside the repo.";
  const all: string[] = [];
  await walk(root, path.relative(root, base).split(path.sep).join("/"), all);
  const g = o.glob ? globRe(o.glob) : null;
  const max = Math.min(300, o.max ?? 120);
  const out: string[] = [];
  for (const f of all) {
    if (g && !g.test(f)) continue;
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp[34]|lock)$/i.test(f)) continue;
    let text: string;
    try {
      text = await readFile(path.join(root, f), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((l, i) => {
      if (out.length < max && re.test(l)) {
        out.push(`${f}:${i + 1}: ${l.trim().slice(0, 240)}`);
      }
    });
    if (out.length >= max) break;
  }
  return out.length ? `${out.join("\n")}${out.length >= max ? "\n… (stopped at the limit; narrow it)" : ""}` : "No matches.";
}
