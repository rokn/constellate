import { useEffect, useRef } from "react";
import type { Commit } from "../../shared/types";
import { summarize, type MapDelta } from "../lib/history";

/**
 * History as a list of commits — the ones that touch what the filter shows.
 * Selecting one turns the map back to that commit: files that didn't exist
 * yet leave, imports are the ones written then, and what the commit itself
 * did is drawn over it. ↑ / ↓ walk the list; Shift widens the selection.
 */

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  if (s < 86_400 * 60) return `${Math.round(s / 86_400)}d`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
};
const when = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STATUS = { A: ["added", "text-good"], M: ["changed", "text-[#ffd27a]"], D: ["deleted", "text-bad"] } as const;

export function CommitList({
  commits,
  total,
  showAll,
  selected,
  span,
  delta,
  loading,
  onMapPaths,
  follow,
  playing,
  coupling,
  onSelect,
  onOpenFile,
  onExplain,
  onShowAll,
  onFollow,
  onPlay,
  onCoupling,
  onClear,
  onClose,
}: {
  /** Newest first, already narrowed to what the filter shows (unless showAll). */
  commits: Commit[];
  total: number;
  showAll: boolean;
  /** The selected span's newest and oldest commit (the same for one commit). */
  selected: { to: string; from: string } | null;
  /** Every commit in the selected span, newest first. */
  span: Commit[];
  delta: MapDelta | null;
  loading: boolean;
  /** Files the filter shows, for ordering the changed-file list. */
  onMapPaths: Set<string>;
  follow: boolean;
  playing: boolean;
  coupling: boolean;
  onSelect: (c: Commit, extend: boolean) => void;
  onOpenFile: (path: string) => void;
  onExplain: () => void;
  onShowAll: (all: boolean) => void;
  onFollow: (on: boolean) => void;
  onPlay: () => void;
  onCoupling: (on: boolean) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const inSpan = new Set(span.map((c) => c.sha));
  const head = span[0];
  const sum = summarize(span);

  // Keep the selected commit in view as the arrows walk the list.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-sha="${selected?.to}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected?.to]);

  const changed = head
    ? [...new Map(span.flatMap((c) => c.files).map((f) => [f.path, f])).values()].sort(
        (a, b) => Number(onMapPaths.has(b.path)) - Number(onMapPaths.has(a.path)) || b.add + b.del - (a.add + a.del),
      )
    : [];

  return (
    <div className="glass rise pointer-events-auto flex max-h-[min(380px,46vh)] w-full max-w-[1040px] flex-col rounded-xl">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 px-3.5 py-2">
        <h2 className="font-cond text-[17px] font-semibold">History</h2>
        <p className="text-[12.5px] text-muted">
          {showAll ? `${total} commits` : `${commits.length} of ${total} commits touch what the filter shows`}
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Toggle on={showAll} onClick={() => onShowAll(!showAll)} title="List commits that only touch filtered-out files too">
            All commits
          </Toggle>
          <Toggle on={follow} onClick={() => onFollow(!follow)} title="Fly to what each commit changed">
            Follow
          </Toggle>
          <Toggle on={coupling} onClick={() => onCoupling(!coupling)} title="Threads between files that keep changing together" tone="#b48cff">
            Coupling
          </Toggle>
          <button
            onClick={onPlay}
            title="Step forward through the commits on its own"
            className={`rounded-full px-2.5 py-0.5 text-[12px] ${playing ? "bg-course/25 text-text ring-1 ring-course/60" : "bg-course font-semibold text-night"}`}
          >
            {playing ? "Pause" : "Play"}
          </button>
          {selected && (
            <button onClick={onClear} className="rounded px-1.5 text-[12px] text-muted hover:text-text" title="Back to the map as it is now (Esc)">
              Now
            </button>
          )}
          <button onClick={onClose} className="rounded px-1.5 text-[12px] text-muted hover:text-text">
            Close
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The commits */}
        <div ref={list} className="min-w-0 flex-[1.15] overflow-y-auto py-1" role="listbox" aria-label="Commits">
          {commits.length === 0 && <p className="px-3.5 py-3 text-[13px] text-muted">No commits touch the files this filter shows.</p>}
          {commits.map((c) => {
            const add = c.files.reduce((s, f) => s + f.add, 0);
            const del = c.files.reduce((s, f) => s + f.del, 0);
            const isHead = c.sha === selected?.to;
            return (
              <button
                key={c.sha}
                data-sha={c.sha}
                role="option"
                aria-selected={inSpan.has(c.sha)}
                onClick={(e) => onSelect(c, e.shiftKey)}
                className={`flex w-full items-baseline gap-2 px-3.5 py-[3px] text-left ${
                  isHead ? "bg-course/20" : inSpan.has(c.sha) ? "bg-course/10" : "hover:bg-white/5"
                }`}
                title={`${c.subject}\n${c.author} · ${when(c.at)}`}
              >
                <span className={`w-[52px] shrink-0 font-mono text-[11px] ${c.worktree ? "text-good" : "text-muted"}`}>{c.worktree ? "now" : c.short}</span>
                <span className={`min-w-0 flex-1 truncate text-[12.5px] ${isHead ? "text-text" : "text-text/85"}`}>{c.subject}</span>
                <span className="shrink-0 font-mono text-[10.5px]">
                  <span className="text-good">+{add}</span> <span className="text-bad">−{del}</span>
                </span>
                <span className="w-9 shrink-0 text-right text-[11px] text-muted">{ago(c.at)}</span>
              </button>
            );
          })}
        </div>

        {/* What the selection did */}
        <div className="min-w-0 flex-1 overflow-y-auto border-l border-line/60 px-3.5 py-2">
          {!head ? (
            <p className="text-[13px] text-muted">
              Pick a commit to turn the map back to it: files that didn’t exist yet leave, and the imports are the ones written then.
              <br />
              <span className="text-[12px]">↑ ↓ step through · Shift+↑ ↓ widen to a span · Esc back to now</span>
            </p>
          ) : (
            <>
              <p className="text-[13.5px] font-medium leading-snug">{span.length > 1 ? `${span.length} commits` : head.subject}</p>
              <p className="mt-0.5 text-[12px] text-muted">
                {span.length > 1
                  ? `${when(span.at(-1)!.at)} – ${when(head.at)} · ${sum.authors.slice(0, 3).join(", ")}`
                  : `${head.author} · ${when(head.at)} · ${head.worktree ? "uncommitted" : head.short}`}
              </p>
              <p className="mt-1.5 flex flex-wrap gap-x-3 text-[12px]">
                <span>
                  <span className="font-mono text-good">+{sum.add.toLocaleString("en-US")}</span>{" "}
                  <span className="font-mono text-bad">−{sum.del.toLocaleString("en-US")}</span> in {sum.files} files
                </span>
                {loading ? (
                  <span className="text-muted">drawing the map then…</span>
                ) : (
                  delta && (
                    <span className="text-muted">
                      map: <MapCount n={delta.addedFiles.size} sign="+" what="file" />{" "}
                      <MapCount n={delta.removedFiles.size} sign="−" what="file" /> · imports{" "}
                      <MapCount n={delta.addedEdges.size} sign="+" /> <MapCount n={delta.removedEdges.size} sign="−" />
                    </span>
                  )
                )}
              </p>
              <ul className="mt-2 space-y-px">
                {changed.slice(0, 80).map((f) => (
                  <li key={f.path}>
                    <button
                      onClick={() => onOpenFile(f.path)}
                      disabled={f.status === "D"}
                      className={`flex w-full items-baseline gap-2 rounded px-1 text-left hover:bg-white/5 disabled:hover:bg-transparent ${onMapPaths.has(f.path) ? "" : "opacity-50"}`}
                      title={`${f.path} — ${STATUS[f.status][0]}${onMapPaths.has(f.path) ? "" : " (not on the filtered map)"}`}
                    >
                      <span className={`w-3 shrink-0 font-mono text-[11px] ${STATUS[f.status][1]}`}>{f.status}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{f.path}</span>
                      <span className="shrink-0 font-mono text-[10.5px]">
                        <span className="text-good">+{f.add}</span> <span className="text-bad">−{f.del}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button onClick={onExplain} className="mt-2 rounded-md bg-course/15 px-2.5 py-1 text-[12.5px] text-course hover:bg-course/25">
                Explain {span.length > 1 ? "these commits" : "this commit"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MapCount({ n, sign, what }: { n: number; sign: "+" | "−"; what?: string }) {
  return (
    <span className={n ? (sign === "+" ? "text-good" : "text-bad") : "text-muted/60"}>
      {sign}
      {n}
      {what ? ` ${what}${n === 1 ? "" : "s"}` : ""}
    </span>
  );
}

function Toggle({ on, onClick, title, tone, children }: { on: boolean; onClick: () => void; title: string; tone?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`rounded-full px-2 py-0.5 text-[12px] ${on ? "text-text ring-1" : "border border-line text-muted hover:text-text"}`}
      style={on ? { background: `${tone ?? "#ff4fd8"}33`, ["--tw-ring-color" as string]: `${tone ?? "#ff4fd8"}99` } : undefined}
    >
      {children}
    </button>
  );
}
