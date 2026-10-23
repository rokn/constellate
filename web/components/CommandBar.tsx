import { useCallback, useMemo, useRef, useState, type Ref } from "react";
import type { Overview, RepoGraph } from "../../shared/types";

/**
 * One box for every kind of intent. Typing shows places you can jump to —
 * files, symbols, modules, topics, branches — and arrowing into one and pressing Enter
 * flies there instantly. Pressing Enter without picking one asks: a question
 * gets the navigator's answer, and (when agents are on) a change to the code
 * goes to a coding agent, routed the way the voice routes it.
 */

export type Jump =
  | { kind: "file"; path: string }
  | { kind: "symbol"; path: string; line: number; name: string }
  | { kind: "module"; id: string; label: string }
  | { kind: "topic"; id: string; label: string }
  /** A branch, lit on the map against its base. */
  | { kind: "branch"; name: string; base: string };

type Branch = { name: string; current: boolean; remote: boolean; ahead: number };

/** Subsequence match, rewarding contiguous runs and matches in the basename. */
function score(hay: string, needle: string): number {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  const base = h.lastIndexOf("/") + 1;
  let s = 0;
  let run = 0;
  let j = 0;
  for (let i = 0; i < h.length && j < n.length; i++) {
    if (h[i] === n[j]) {
      run++;
      s += 1 + run * 2 + (i >= base ? 3 : 0);
      j++;
    } else run = 0;
  }
  if (j < n.length) return 0;
  if (h.slice(base).startsWith(n)) s += 25;
  return s - h.length * 0.05;
}

export function CommandBar({
  inputRef,
  graph,
  overview,
  busy,
  agentsOn,
  onAsk,
  onJump,
  onStop,
}: {
  inputRef: Ref<HTMLInputElement>;
  graph: RepoGraph | null;
  overview?: Overview;
  busy: boolean;
  /** Asking can hand changes to coding agents. */
  agentsOn?: boolean;
  onAsk: (text: string) => void;
  onJump: (j: Jump) => void;
  onStop: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(-1);
  const [open, setOpen] = useState(false);
  const local = useRef<HTMLInputElement | null>(null);
  // Branches with work of their own, fetched fresh each time the box opens.
  const [branches, setBranches] = useState<{ base: string; branches: Branch[] } | null>(null);
  const loadBranches = useCallback(() => {
    void fetch("/api/branches")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { base: string; branches: Branch[] } | null) => b && setBranches(b))
      .catch(() => undefined);
  }, []);

  const jumps = useMemo(() => {
    const term = q.trim();
    if (term.length < 2 || !graph) return [];
    const out: { j: Jump; s: number; text: string; hint: string; detail?: string }[] = [];
    for (const m of overview?.modules ?? []) {
      const s = score(m.label, term);
      if (s) out.push({ j: { kind: "module", id: m.id, label: m.label }, s: s + 8, text: m.label, hint: "Module" });
    }
    for (const t of overview?.topics ?? []) {
      const s = score(t.title, term);
      if (s) out.push({ j: { kind: "topic", id: t.id, label: t.title }, s: s + 6, text: t.title, hint: "Topic" });
    }
    for (const b of branches?.branches ?? []) {
      if (b.name === branches!.base || b.ahead === 0) continue;
      const s = score(b.name, term);
      if (s) {
        out.push({
          j: { kind: "branch", name: b.name, base: branches!.base },
          s: s + 4,
          text: b.name,
          hint: "Branch",
          detail: `${b.ahead} ahead of ${branches!.base}${b.current ? " · checked out" : ""}`,
        });
      }
    }
    for (const f of graph.files) {
      const s = score(f.path, term);
      if (s) out.push({ j: { kind: "file", path: f.path }, s, text: f.path, hint: "File" });
      for (const sym of f.symbols) {
        if (sym.name.length < 3) continue;
        const ss = score(sym.name, term);
        if (ss > 12) {
          out.push({
            j: { kind: "symbol", path: f.path, line: sym.line, name: sym.name },
            s: ss - 2,
            text: sym.name,
            hint: `${f.path.split("/").pop()}:${sym.line}`,
          });
        }
      }
    }
    return out.sort((a, b) => b.s - a.s).slice(0, 7);
  }, [q, graph, overview, branches]);

  const submit = () => {
    const text = q.trim();
    if (sel >= 0 && jumps[sel]) onJump(jumps[sel].j);
    else if (text) onAsk(text);
    else return;
    setQ("");
    setOpen(false);
    local.current?.blur();
  };

  return (
    <div className="pointer-events-auto relative w-full max-w-[680px]">
      {open && jumps.length > 0 && (
        <ul className="glass absolute bottom-full mb-2 w-full overflow-hidden rounded-lg py-1" role="listbox">
          {jumps.map((x, i) => (
            <li key={`${x.hint}${x.text}`}>
              <button
                role="option"
                aria-selected={i === sel}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onJump(x.j);
                  setQ("");
                  setOpen(false);
                }}
                onMouseEnter={() => setSel(i)}
                className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left ${i === sel ? "bg-course/15" : ""}`}
              >
                <span className={`w-16 shrink-0 font-cond text-[12.5px] ${x.j.kind === "module" ? "text-runtime" : x.j.kind === "topic" || x.j.kind === "branch" ? "text-course" : "text-muted"}`}>
                  {x.hint.includes(":") ? "Symbol" : x.hint}
                </span>
                <span className={`min-w-0 flex-1 truncate text-[13.5px] ${x.j.kind === "file" || x.j.kind === "symbol" || x.j.kind === "branch" ? "font-mono text-[12.5px]" : ""}`}>
                  {x.text}
                </span>
                {x.hint.includes(":") && <span className="shrink-0 font-mono text-[11px] text-muted">{x.hint}</span>}
                {x.detail && <span className="shrink-0 text-[11.5px] text-muted">{x.detail}</span>}
              </button>
            </li>
          ))}
          <li className="border-t border-line px-3 pt-1.5 pb-1 text-[12px] text-muted">
            {sel >= 0 ? "Enter to fly there" : agentsOn ? "Enter asks — questions get answered, changes go to an agent · ↑↓ to pick a place" : "Enter asks the navigator · ↑↓ to pick a place"}
          </li>
        </ul>
      )}

      <div className="glass flex items-center gap-2 rounded-xl px-3 py-2 shadow-[0_10px_40px_-12px_rgba(0,0,0,.8)]">
        <span className={`h-2 w-2 shrink-0 rounded-full ${busy ? "animate-pulse bg-course" : "bg-muted/40"}`} aria-hidden />
        <input
          ref={(el) => {
            local.current = el;
            if (typeof inputRef === "function") inputRef(el);
            else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
          }}
          value={q}
          onChange={(e) => {
            // Reset the pick here, not in an effect on `q`: an effect adds a
            // second synchronous render per keystroke, and fast input (paste
            // bursts, dictation) stacks those past React's update limit.
            setQ(e.target.value);
            setSel(-1);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            loadBranches();
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(jumps.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(-1, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              setQ("");
              local.current?.blur();
            }
          }}
          placeholder={agentsOn ? "Ask about the code, ask for a change, or type a file to fly there" : "Ask the navigator, or type a file to fly there"}
          className="min-w-0 flex-1 bg-transparent py-1 text-[15px] text-text placeholder:text-muted/70 focus:outline-none"
          aria-label={agentsOn ? "Ask a question, ask for a change, or jump to a file" : "Ask the navigator or jump to a file"}
        />
        {busy ? (
          <button onClick={onStop} className="shrink-0 rounded-md px-2 py-1 text-[13px] text-muted hover:bg-white/5 hover:text-text">
            Stop
          </button>
        ) : (
          <kbd className="shrink-0 rounded border border-line px-1.5 font-mono text-[11px] text-muted">/</kbd>
        )}
      </div>
    </div>
  );
}
