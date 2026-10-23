import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DiffStat, DiffView } from "./DiffView";

type ChangedFile = { path: string; status: string; add: number; del: number; lang: string; onMap: boolean };
type Summary = {
  branch: string;
  base: string;
  mergeBase: string;
  head: string;
  checkedOut: boolean;
  /** A coding agent's branch, read from where it started; `live`: the tip holds work it hasn't committed yet. */
  agent?: { id: string; title: string; live: boolean };
  commits: { sha: string; subject: string; author: string; at: number }[];
  files: ChangedFile[];
};

/** What a branch is compared with: its base, or for an agent, the commit it started on. */
function Against({ sum, base, className }: { sum: Summary | null; base?: string; className: string }) {
  if (sum?.agent) {
    return (
      <>
        <span className="mx-2 text-muted">since it started at</span>
        <span className={`font-mono ${className}`}>{sum.mergeBase.slice(0, 7)}</span>
      </>
    );
  }
  return (
    <>
      <span className="mx-2 text-muted">vs</span>
      <span className={`font-mono ${className}`}>{sum?.base ?? base ?? "…"}</span>
    </>
  );
}

const STATUS: Record<string, { label: string; tone: string }> = {
  A: { label: "A", tone: "text-good" },
  D: { label: "D", tone: "text-bad" },
  M: { label: "M", tone: "text-runtime" },
};

const ago = (at: number) => {
  const d = (Date.now() - at) / 86_400_000;
  return d < 1 ? "today" : d < 2 ? "yesterday" : `${Math.round(d)} days ago`;
};

/**
 * Everything a branch changes relative to its base, as git sees it (merge base
 * → tip): the changed files down the side, the selected file's diff beside
 * them, the branch's commits a click away. ↑ / ↓ step through the files, Esc
 * closes. From here the changes can be lit on the map or told as a story.
 */
export function BranchDiff({
  branch,
  base,
  agent,
  onLight,
  onExplain,
  onClose,
}: {
  branch: string;
  base?: string;
  /** An agent's branch: compared with where it started, uncommitted work included. */
  agent?: string;
  /** Light the changed files that are on the map. */
  onLight: (paths: string[], label: string) => void;
  /** Ask for a story of this branch. */
  onExplain: (branch: string, base: string) => void;
  onClose: () => void;
}) {
  const [sum, setSum] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [showCommits, setShowCommits] = useState(false);
  const [filter, setFilter] = useState("");
  const list = useRef<HTMLUListElement>(null);

  const q = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ ...(agent ? { agent } : { branch, ...(base ? { base } : {}) }), ...extra }).toString();

  useEffect(() => {
    setSum(null);
    setError("");
    void fetch(`/api/branch-diff?${q()}`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.error);
        return b as Summary;
      })
      .then((s) => {
        setSum(s);
        setSel(s.files[0]?.path ?? null);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, base, agent]);

  // Each file's diff is fetched once, when it's first looked at.
  useEffect(() => {
    if (!sel || diffs[sel] !== undefined) return;
    void fetch(`/api/branch-diff?${q({ path: sel })}`)
      .then((r) => r.json())
      .then((b: { diff?: string; error?: string }) => setDiffs((d) => ({ ...d, [sel]: b.diff ?? `(${b.error ?? "no diff"})` })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const shown = useMemo(() => (sum?.files ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())), [sum, filter]);
  const file = sum?.files.find((f) => f.path === sel);
  const totals = useMemo(() => (sum?.files ?? []).reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 }), [sum]);

  const keys = useRef({ shown, sel, onClose });
  keys.current = { shown, sel, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      const typing = e.target instanceof HTMLInputElement && e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape";
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") k.onClose();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const i = k.shown.findIndex((f) => f.path === k.sel);
        const next = k.shown[Math.max(0, Math.min(k.shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) {
          setSel(next.path);
          list.current?.querySelector(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: "nearest" });
        }
      } else return;
      // Captured first: the map's own Esc and arrows (history) mustn't also fire.
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-night/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${branch} compared with ${sum?.base ?? base ?? "main"}`}>
      <div className="glass rise flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
          <h2 className="min-w-0 font-cond text-[19px] font-semibold">
            <span className="font-mono text-[15px] text-course">{branch}</span>
            <Against sum={sum} base={base} className="text-[15px]" />
          </h2>
          {sum && (
            <span className="text-[12.5px] text-muted">
              {sum.commits.length} commit{sum.commits.length === 1 ? "" : "s"} · {sum.files.length} file{sum.files.length === 1 ? "" : "s"} ·{" "}
              <span className="text-good">+{totals.add}</span> <span className="text-bad">−{totals.del}</span>
              {sum.agent ? (
                sum.agent.live ? " · with what it hasn't committed yet" : ""
              ) : (
                <>
                  {" "}
                  · forked at <span className="font-mono">{sum.mergeBase.slice(0, 7)}</span>
                </>
              )}
              {sum.checkedOut ? " · checked out" : ""}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5 text-[13px]">
            {sum && (
              <>
                <button onClick={() => setShowCommits((s) => !s)} aria-expanded={showCommits} className={`rounded px-2 py-0.5 hover:bg-white/5 ${showCommits ? "text-text" : "text-muted hover:text-text"}`}>
                  Commits
                </button>
                <button
                  onClick={() => onLight(sum.files.filter((f) => f.onMap).map((f) => f.path), `${branch} vs ${sum.base}`)}
                  disabled={!sum.files.some((f) => f.onMap)}
                  className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text disabled:opacity-40"
                  title="Light the changed files on the map (files only on the branch aren't on it)"
                >
                  Light on map
                </button>
                <button onClick={() => onExplain(sum.branch, sum.base)} className="rounded-md bg-course px-2.5 py-0.5 font-cond text-[14.5px] font-semibold text-night hover:brightness-110">
                  Explain as a story
                </button>
              </>
            )}
            <button onClick={onClose} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text">
              Close
            </button>
          </div>
        </header>

        {error ? (
          <p className="p-4 text-[14px] text-bad">{error}</p>
        ) : !sum ? (
          <div className="working-bar h-px bg-line" />
        ) : !sum.files.length ? (
          <p className="p-4 text-[14px] text-muted">
            {branch} has no changes {sum.agent ? "since it started" : `relative to ${sum.base}`}.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-[min(360px,38%)] shrink-0 flex-col border-r border-line">
              {showCommits && (
                <ul className="max-h-[40%] overflow-y-auto border-b border-line px-2 py-2">
                  {sum.commits.map((c) => (
                    <li key={c.sha} className="flex gap-2 px-1.5 py-0.5 text-[12.5px]">
                      <span className="shrink-0 font-mono text-muted">{c.sha.slice(0, 7)}</span>
                      <span className="min-w-0 flex-1 truncate" title={c.subject}>
                        {c.subject}
                      </span>
                      <span className="shrink-0 text-muted/70">{ago(c.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {sum.files.length > 8 && (
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter files"
                  className="m-2 rounded-md border border-line bg-panelsolid/60 px-2 py-1 text-[13px] focus:border-course/60 focus:outline-none"
                  aria-label="Filter changed files"
                />
              )}
              <ul ref={list} className="min-h-0 flex-1 overflow-y-auto py-1">
                {shown.map((f) => {
                  const st = STATUS[f.status[0]] ?? { label: f.status[0], tone: "text-muted" };
                  const slash = f.path.lastIndexOf("/");
                  return (
                    <li key={f.path}>
                      <button
                        data-path={f.path}
                        onClick={() => setSel(f.path)}
                        className={`flex w-full items-baseline gap-2 px-3 py-1 text-left ${f.path === sel ? "bg-course/15" : "hover:bg-white/[0.04]"}`}
                        title={f.path}
                      >
                        <span className={`w-3 shrink-0 font-mono text-[11.5px] font-semibold ${st.tone}`}>{st.label}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                          <span className="text-muted/70">{f.path.slice(0, slash + 1)}</span>
                          <span className="text-text">{f.path.slice(slash + 1)}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums">
                          <span className="text-good">+{f.add}</span> <span className="text-bad">−{f.del}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="border-t border-line px-3 py-1.5 text-[11.5px] text-muted/70">↑ ↓ files · Esc closes</p>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              {file && (
                <div className="flex items-baseline gap-3 border-b border-line/70 px-4 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{file.path}</span>
                  <DiffStat add={file.add} del={file.del} />
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                {sel && diffs[sel] !== undefined ? (
                  diffs[sel].trim() ? (
                    <DiffView diff={diffs[sel]} lang={file?.lang ?? "text"} />
                  ) : (
                    <p className="p-4 text-[13.5px] text-muted">No textual change (binary, or a mode change).</p>
                  )
                ) : (
                  <div className="working-bar h-px bg-line" />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export type BranchSummary = Summary;

/**
 * A branch on the map, the way History shows a commit: the map is the code as
 * it is on the branch, compared with where it forked. This bar says what's
 * lit — the branch, its size, the files it touched (click one to fly there) —
 * and leads on to the code diff or a story.
 */
export function BranchMapBar({
  sum,
  error,
  loading,
  working,
  onMapPaths,
  onFly,
  onCodeDiff,
  onExplain,
  onClose,
  changedOnly,
  onChangedOnly,
}: {
  sum: Summary | null;
  error: string;
  /** The maps at the tip and the fork are still being built. */
  loading: boolean;
  /** An agent's branch, and the agent is still at it: the map follows its edits. */
  working?: boolean;
  onMapPaths: Set<string>;
  onFly: (path: string) => void;
  onCodeDiff: () => void;
  onExplain: () => void;
  onClose: () => void;
  /** The map shows only the files the branch changed. */
  changedOnly: boolean;
  onChangedOnly: (on: boolean) => void;
}) {
  const [showCommits, setShowCommits] = useState(false);
  // The file chips sit over the map; on a tablet or a narrow window they start folded away.
  const [showFiles, setShowFiles] = useState(() => matchMedia("(min-width: 1024px) and (pointer: fine)").matches);
  const totals = (sum?.files ?? []).reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });
  const files = [...(sum?.files ?? [])].sort((a, b) => b.add + b.del - (a.add + a.del));
  return (
    <div className="glass rise pointer-events-auto w-full max-w-[980px] rounded-xl px-3 py-2 sm:px-4 sm:py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="rounded border border-course/50 px-1.5 font-cond text-[11.5px] font-medium tracking-wide text-course">{sum?.agent ? "Agent" : "Branch"}</span>
        <h2 className="min-w-0 font-cond text-[18px] font-semibold">
          {sum?.agent && <span className="mr-2">{sum.agent.title}</span>}
          <span className="font-mono text-[14.5px] text-course">{sum?.branch ?? "…"}</span>
          {!sum?.agent && <Against sum={sum} className="text-[14.5px]" />}
        </h2>
        {sum && (
          <span className="hidden text-[12.5px] text-muted md:inline">
            {sum.commits.length} commit{sum.commits.length === 1 ? "" : "s"} · {sum.files.length} file{sum.files.length === 1 ? "" : "s"} ·{" "}
            <span className="text-good">+{totals.add}</span> <span className="text-bad">−{totals.del}</span> · since{" "}
            {sum.agent ? "it started at " : ""}
            <span className="font-mono">{sum.mergeBase.slice(0, 7)}</span>
            {sum.agent?.live ? " · with what it hasn't committed yet" : ""}
          </span>
        )}
        {loading && !error && <span className="text-[12.5px] text-course/90">{sum?.agent && working ? "Mapping its latest edits…" : "Building the branch's map…"}</span>}
        {working && !loading && !error && <span className="text-[12.5px] text-runtime">Still working: the map follows its edits</span>}
        <div className="ml-auto flex items-center gap-1.5 text-[13px]">
          {sum && (
            <>
              <button
                onClick={() => onChangedOnly(!changedOnly)}
                aria-pressed={changedOnly}
                className={`rounded px-2 py-0.5 hover:bg-white/5 ${changedOnly ? "bg-course/15 text-course" : "text-muted hover:text-text"}`}
                title="Show only the files it changed, or the whole map"
              >
                Only changed
              </button>
              <button onClick={() => setShowCommits((s) => !s)} aria-expanded={showCommits} className={`rounded px-2 py-0.5 hover:bg-white/5 ${showCommits ? "text-text" : "text-muted hover:text-text"}`}>
                Commits
              </button>
              {files.length > 0 && (
                <button onClick={() => setShowFiles((s) => !s)} aria-expanded={showFiles} className={`rounded px-2 py-0.5 hover:bg-white/5 ${showFiles ? "text-text" : "text-muted hover:text-text"}`}>
                  Files <span className="tabular-nums text-muted/80">{files.length}</span>
                </button>
              )}
              <button onClick={onCodeDiff} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text" title="Every changed file's diff, side by side">
                Code diff
              </button>
              <button onClick={onExplain} className="rounded-md bg-course px-2.5 py-0.5 font-cond text-[14.5px] font-semibold text-night hover:brightness-110">
                Explain<span className="hidden sm:inline"> as a story</span>
              </button>
            </>
          )}
          <button onClick={onClose} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text" title="Back to the present (Esc)">
            Close
          </button>
        </div>
      </div>
      {error && <p className="mt-1.5 text-[13px] text-bad">{error}</p>}
      {showCommits && sum && (
        <ul className="mt-2 max-h-[min(120px,18vh)] space-y-0.5 overflow-y-auto">
          {sum.commits.map((c) => (
            <li key={c.sha} className="flex gap-2 text-[12.5px]">
              <span className="shrink-0 font-mono text-muted">{c.sha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate">{c.subject}</span>
              <span className="shrink-0 text-muted/70">{c.author}</span>
            </li>
          ))}
        </ul>
      )}
      {showFiles && sum && files.length > 0 && (
        <ul className="mt-2 flex max-h-[min(96px,15vh)] flex-wrap gap-1 overflow-y-auto">
          {files.map((f) => {
            const st = STATUS[f.status[0]] ?? { label: f.status[0], tone: "text-muted" };
            const here = onMapPaths.has(f.path);
            return (
              <li key={f.path}>
                <button
                  onClick={() => here && onFly(f.path)}
                  disabled={!here}
                  title={here ? `${f.path} — fly there` : `${f.path} — not on the map (filtered out, or not a source file)`}
                  className="flex items-baseline gap-1.5 rounded border border-line bg-panelsolid/60 px-1.5 py-0.5 text-[12px] hover:border-course/60 disabled:opacity-40"
                >
                  <span className={`font-mono text-[10.5px] font-semibold ${st.tone}`}>{st.label}</span>
                  <span className="font-mono">{f.path.split("/").pop()}</span>
                  <span className="font-mono text-[10.5px] tabular-nums">
                    <span className="text-good">+{f.add}</span> <span className="text-bad">−{f.del}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
