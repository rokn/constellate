import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { digest, indexGraph, scanRepo } from "../scan";
import { session } from "../session";

/**
 * A repo, told to the workshop's assistant so it can draw the architecture:
 * Constellate's own reading of it (the overview's modules and how they talk,
 * the stack, the entry points) when it's the repo open in the code map, the
 * import graph's digest, and the files that say how it runs — compose files,
 * Kubernetes manifests, Dockerfiles, package manifests, Terraform.
 */

const SKIP = new Set(["node_modules", ".git", "dist", "build", "vendor", ".next", "target", ".venv", "venv", "__pycache__", ".cache", "coverage"]);
const INFRA = [
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/i,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)(k8s|kube|kubernetes|deploy|manifests|helm|charts)\/.*\.ya?ml$/i,
  /(^|\/)(package\.json|go\.mod|pyproject\.toml|requirements\.txt|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?)$/,
  /(^|\/)(Procfile|serverless\.ya?ml|fly\.toml|render\.yaml|app\.yaml|vercel\.json|netlify\.toml)$/,
  /\.tf$/,
];

async function walk(root: string, rel = "", depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 5 || out.length > 4000) return out;
  let list: string[] = [];
  try {
    list = await readdir(path.join(root, rel));
  } catch {
    return out;
  }
  for (const name of list) {
    if (SKIP.has(name) || name.startsWith(".") && name !== ".github") continue;
    const r = rel ? `${rel}/${name}` : name;
    try {
      const s = await stat(path.join(root, r));
      if (s.isDirectory()) await walk(root, r, depth + 1, out);
      else out.push(r);
    } catch {
      /* gone */
    }
  }
  return out;
}

/** What the repo says about how it's built and run: the infrastructure files, trimmed. */
async function infraFiles(root: string): Promise<string> {
  const files = (await walk(root)).filter((f) => INFRA.some((re) => re.test(f)));
  // Shallow ones first: the root compose file says more than a fixture's.
  files.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const parts: string[] = [];
  let budget = 24_000;
  for (const f of files.slice(0, 24)) {
    if (budget <= 0) break;
    try {
      let text = await readFile(path.join(root, f), "utf8");
      if (f.endsWith("package.json")) {
        const j = JSON.parse(text) as { name?: string; dependencies?: Record<string, string>; scripts?: Record<string, string> };
        text = JSON.stringify({ name: j.name, dependencies: Object.keys(j.dependencies ?? {}), scripts: j.scripts }, null, 1);
      }
      const cut = text.slice(0, Math.min(3000, budget));
      budget -= cut.length;
      parts.push(`--- ${f}\n${cut}`);
    } catch {
      /* unreadable */
    }
  }
  return parts.length ? `Infrastructure and manifests:\n${parts.join("\n")}` : "No compose files, manifests or Dockerfiles found.";
}

/** Everything worth knowing to draw a repo's architecture: the open repo, or one at `dir`. */
export async function repoBrief(dir?: string): Promise<string> {
  const open = session.state.repo;
  if (!dir && !open) return "No repo is open in the code map. Ask them which folder (give its path), or open one in Constellate first.";
  if (dir && (!open || path.resolve(dir) !== path.resolve(open.root))) {
    const g = await scanRepo(dir);
    return [digest(indexGraph(g)), "", await infraFiles(path.resolve(dir))].join("\n");
  }
  const root = open!.root;
  const o = session.state.overview;
  const lines = [`Repo: ${open!.name}${open!.branch ? ` (branch ${open!.branch})` : ""}`];
  if (o) {
    lines.push(
      `What it is: ${o.headline}`,
      o.summary,
      `Stack: ${o.stack.join(", ")}`,
      `Entry points: ${o.entryPoints.join(", ")}`,
      "",
      "Modules (as Constellate's navigator charted them):",
      ...o.modules.map((m) => `- ${m.id} "${m.label}": ${m.summary} [${m.paths.slice(0, 4).join(", ")}${m.paths.length > 4 ? ", …" : ""}]`),
      "",
      "How they talk:",
      ...o.edges.map((e) => `- ${e.from} → ${e.to} (${e.kind}) ${e.label}`),
    );
  }
  if (session.idx) lines.push("", digest(session.idx).slice(0, 12_000));
  lines.push("", await infraFiles(root));
  return lines.join("\n");
}
