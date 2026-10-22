import type { Overview, RepoGraph } from "../../shared/types";
import type { Jump } from "./model";

/** What the headset keyboard offers to jump to as you type: modules, files, then symbols. */
export function suggest(graph: RepoGraph | null, overview: Overview | undefined, q: string): Jump[] {
  if (!graph) return [];
  const ql = q.toLowerCase();
  const out: (Jump & { score: number })[] = [];
  for (const m of overview?.modules ?? []) if (m.label.toLowerCase().includes(ql)) out.push({ kind: "module", label: m.label, id: m.id, score: m.label.toLowerCase().startsWith(ql) ? 0 : 1 });
  for (const f of graph.files) {
    const name = f.path.split("/").pop()!;
    if (name.toLowerCase().startsWith(ql)) out.push({ kind: "file", label: name, detail: f.path, path: f.path, score: 0.5 });
    else if (f.path.toLowerCase().includes(ql)) out.push({ kind: "file", label: name, detail: f.path, path: f.path, score: 2 });
    if (out.length > 200) break;
  }
  if (ql.length >= 3) {
    let n = 0;
    outer: for (const f of graph.files) {
      for (const s of f.symbols) {
        if (!s.name.toLowerCase().startsWith(ql)) continue;
        out.push({ kind: "symbol", label: s.name, detail: f.path, path: f.path, line: s.line, score: 1.5 });
        if (++n > 30) break outer;
      }
    }
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 6);
}
