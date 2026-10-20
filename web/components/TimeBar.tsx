import { useMemo, useState } from "react";
import type { Commit, History, TimeRange } from "../../shared/types";
import { commitsIn, summarize, type Span } from "../lib/history";

/**
 * The time axis. Each bar is a day (or a week, for long histories) of
 * commits, as tall as the churn in it. Drag across bars to choose a span; the
 * map lights up whatever changed in it. Uncommitted work is the last bar.
 */

type Bucket = { start: number; commits: Commit[]; churn: number; worktree?: boolean };

const DAY = 86_400_000;
const fmt = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });

export function TimeBar({
  history,
  range,
  replaying,
  coupling,
  onRange,
  onSpan,
  onPickCommit,
  onClear,
  onReplay,
  onCoupling,
  onClose,
}: {
  history: History;
  range: TimeRange | null;
  replaying: boolean;
  coupling: boolean;
  onRange: (r: TimeRange) => void;
  onSpan: (s: Span) => void;
  onPickCommit: (c: Commit) => void;
  onClear: () => void;
  onReplay: () => void;
  onCoupling: (on: boolean) => void;
  onClose: () => void;
}) {
  const buckets = useMemo(() => {
    const real = history.commits.filter((c) => !c.worktree);
    if (!real.length) return [] as Bucket[];
    const oldest = real.at(-1)!.at;
    const newest = real[0].at;
    // Long histories bucket by week so the strip stays readable.
    const size = (newest - oldest) / DAY > 140 ? 7 * DAY : DAY;
    const start0 = Math.floor(oldest / size) * size;
    const n = Math.floor((newest - start0) / size) + 1;
    const out: Bucket[] = Array.from({ length: n }, (_, i) => ({ start: start0 + i * size, commits: [], churn: 0 }));
    for (const c of real) {
      const b = out[Math.floor((c.at - start0) / size)];
      b.commits.push(c);
      b.churn += c.files.reduce((s, f) => s + f.add + f.del, 0);
    }
    const wt = history.commits[0]?.worktree ? history.commits[0] : null;
    if (wt) out.push({ start: Date.now(), commits: [wt], churn: wt.files.reduce((s, f) => s + f.add + f.del, 0), worktree: true });
    return out;
  }, [history]);

  const maxChurn = Math.max(1, ...buckets.map((b) => b.churn));
  const inRange = useMemo(() => new Set(range ? commitsIn(history, range).map((c) => c.sha) : []), [history, range]);
  const rangeCommits = useMemo(() => (range ? commitsIn(history, range) : []), [history, range]);
  const sum = summarize(rangeCommits);

  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  const span = drag ? [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)] : null;

  const commitRange = (i: number, j: number) => {
    const picked = buckets.slice(i, j + 1).flatMap((b) => b.commits);
    if (!picked.length) return;
    // Buckets are oldest-first; commits inside each are newest-first.
    const sorted = [...picked].sort((x, y) => y.at - x.at);
    const label = i === j ? `${buckets[i].worktree ? "Uncommitted" : fmt(buckets[i].start)}` : undefined;
    onRange({ from: sorted.at(-1)!.sha, to: sorted[0].sha, label });
  };

  return (
    <div className="glass rise pointer-events-auto w-full max-w-[980px] rounded-xl px-3.5 pb-2.5 pt-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="font-cond text-[17px] font-semibold">History</h2>
        {range && rangeCommits.length > 0 ? (
          <p className="text-[13px] text-text/90">
            {range.label && <span className="text-course">{range.label} · </span>}
            {sum.commits} commit{sum.commits === 1 ? "" : "s"} · {sum.files} files ·{" "}
            <span className="font-mono text-[12px] text-good">+{sum.add.toLocaleString("en-US")}</span>{" "}
            <span className="font-mono text-[12px] text-bad">−{sum.del.toLocaleString("en-US")}</span>
            {sum.authors.length > 0 && <span className="text-muted"> · {sum.authors.slice(0, 3).join(", ")}{sum.authors.length > 3 ? ` +${sum.authors.length - 3}` : ""}</span>}
          </p>
        ) : (
          <p className="text-[13px] text-muted">Drag across the bars to light up what changed.</p>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {(
            [
              ["last_commit", "Last commit"],
              ["week", "Week"],
              ["month", "Month"],
              ["all", "All"],
              ...(history.commits[0]?.worktree ? [["uncommitted", "Uncommitted"]] : []),
            ] as [Span, string][]
          ).map(([s, t]) => (
            <button key={s} onClick={() => onSpan(s)} className="rounded-full border border-line px-2 py-0.5 text-[12px] text-muted hover:text-text">
              {t}
            </button>
          ))}
          <button
            onClick={() => onCoupling(!coupling)}
            aria-pressed={coupling}
            title="Threads between files that keep changing together"
            className={`rounded-full px-2 py-0.5 text-[12px] ${coupling ? "bg-[#b48cff]/20 text-text ring-1 ring-[#b48cff]/60" : "border border-line text-muted hover:text-text"}`}
          >
            Coupling
          </button>
          <button
            onClick={onReplay}
            disabled={!range}
            className={`rounded-full px-2.5 py-0.5 text-[12px] disabled:opacity-35 ${replaying ? "bg-course/25 text-text ring-1 ring-course/60" : "bg-course text-night font-semibold"}`}
          >
            {replaying ? "Stop replay" : "Replay"}
          </button>
          {range && (
            <button onClick={onClear} className="rounded px-1.5 text-[12px] text-muted hover:text-text">
              Clear
            </button>
          )}
          <button onClick={onClose} className="rounded px-1.5 text-[12px] text-muted hover:text-text">
            Close
          </button>
        </div>
      </div>

      {/* The strip */}
      <div
        className="flex h-14 select-none items-end gap-px"
        onPointerLeave={() => drag && setDrag(null)}
        role="group"
        aria-label="Commit activity over time; drag to choose a span"
      >
        {buckets.map((b, i) => {
          const h = b.commits.length ? 8 + 92 * Math.sqrt(b.churn / maxChurn) : 3;
          const selected = span ? i >= span[0] && i <= span[1] : b.commits.some((c) => inRange.has(c.sha));
          return (
            <div
              key={b.start + (b.worktree ? 1 : 0)}
              className="group relative flex h-full flex-1 cursor-pointer items-end"
              onPointerDown={() => setDrag({ a: i, b: i })}
              onPointerEnter={() => drag && setDrag({ ...drag, b: i })}
              onPointerUp={() => {
                if (!drag) return;
                commitRange(Math.min(drag.a, i), Math.max(drag.a, i));
                setDrag(null);
              }}
              title={`${b.worktree ? "Uncommitted" : fmt(b.start)}: ${b.commits.length} commit${b.commits.length === 1 ? "" : "s"}`}
            >
              <div
                className={`w-full rounded-t-[2px] transition-colors ${
                  b.worktree
                    ? selected ? "bg-good" : "bg-good/40"
                    : selected ? "bg-course" : b.commits.length ? "bg-static/35 group-hover:bg-static/70" : "bg-line/50"
                }`}
                style={{ height: `${h}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[10.5px] text-muted/70">
        <span>{buckets[0] ? fmt(buckets[0].start) : ""}</span>
        <span>{history.truncated ? "older history not loaded" : ""}</span>
        <span>{history.commits.find((c) => !c.worktree) ? fmt(history.commits.find((c) => !c.worktree)!.at) : ""}</span>
      </div>

      {/* The commits in the span */}
      {rangeCommits.length > 0 && (
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5" style={{ maskImage: "linear-gradient(90deg, #000 94%, transparent)" }}>
          {rangeCommits.slice(0, 60).map((c) => {
            const add = c.files.reduce((s, f) => s + f.add, 0);
            const del = c.files.reduce((s, f) => s + f.del, 0);
            return (
              <button
                key={c.sha}
                onClick={() => onPickCommit(c)}
                className="shrink-0 rounded-md border border-line bg-panelsolid/60 px-2 py-1 text-left hover:border-course/60"
                title={`${c.subject}\n${c.author} · ${new Date(c.at).toLocaleString("en-US")}`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] text-muted">{c.worktree ? "now" : c.short}</span>
                  <span className="max-w-[220px] truncate text-[12.5px]">{c.subject}</span>
                </span>
                <span className="font-mono text-[10.5px]">
                  <span className="text-good">+{add}</span> <span className="text-bad">−{del}</span>
                  <span className="text-muted"> · {c.files.length} files</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
