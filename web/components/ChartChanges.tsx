import { useEffect, useState } from "react";
import type { CommitFile } from "../../shared/types";

/**
 * What changed since the map was charted, under the "re-chart" prompt: the
 * commits, the files with their churn, and ways to look at them — so you can
 * tell whether re-charting is worth it before you do.
 */

type Changes = {
  since: { sha: string; short: string; at: number; subject: string };
  commits: { sha: string; short: string; subject: string; author: string; at: number }[];
  files: CommitFile[];
  uncommitted: boolean;
};

const when = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STATUS = { A: "text-good", M: "text-[#ffd27a]", D: "text-bad" } as const;

export function ChartChanges({
  version,
  onMap,
  onOpenFile,
  onLight,
  onHistory,
}: {
  /** Refetch when the code is rescanned. */
  version: number;
  /** Files on the map now, to tell which changes you can fly to. */
  onMap: Set<string>;
  onOpenFile: (path: string) => void;
  /** Light these files on the map. */
  onLight: (paths: string[]) => void;
  /** Show the commits since the chart in History: newest and oldest sha. */
  onHistory: (to: string, from: string) => void;
}) {
  const [data, setData] = useState<Changes | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch("/api/chart-changes")
      .then((r) => (r.ok ? (r.json() as Promise<Changes>) : null))
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [version]);

  if (data === undefined) return <p className="mt-2 text-[12px] text-muted">Reading the changes…</p>;
  if (data === null) return <p className="mt-2 text-[12px] text-muted">There's no record of the commit the map was charted at.</p>;

  const add = data.files.reduce((s, f) => s + f.add, 0);
  const del = data.files.reduce((s, f) => s + f.del, 0);
  const visible = data.files.filter((f) => f.status !== "D" && onMap.has(f.path)).map((f) => f.path);
  return (
    <div className="mt-2 border-t border-line/60 pt-2">
      <p className="text-[12px] text-muted">
        Since {data.since.short} ({when(data.since.at)}): {data.commits.length} commit{data.commits.length === 1 ? "" : "s"}
        {data.uncommitted ? " and uncommitted work" : ""} · {data.files.length} files ·{" "}
        <span className="font-mono text-good">+{add.toLocaleString("en-US")}</span> <span className="font-mono text-bad">−{del.toLocaleString("en-US")}</span>
      </p>
      {data.commits.length > 0 && (
        <ul className="mt-1.5 max-h-28 space-y-px overflow-y-auto">
          {data.commits.map((c) => (
            <li key={c.sha} className="flex items-baseline gap-2 text-[12px]" title={`${c.author} · ${when(c.at)}`}>
              <span className="shrink-0 font-mono text-[11px] text-muted">{c.short}</span>
              <span className="min-w-0 truncate">{c.subject}</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="mt-1.5 max-h-40 space-y-px overflow-y-auto">
        {data.files.slice(0, 120).map((f) => {
          const canOpen = f.status !== "D" && onMap.has(f.path);
          return (
            <li key={f.path}>
              <button
                onClick={() => canOpen && onOpenFile(f.path)}
                disabled={!canOpen}
                className="flex w-full items-baseline gap-2 rounded px-1 text-left hover:bg-white/5 disabled:opacity-55 disabled:hover:bg-transparent"
                title={f.status === "D" ? `${f.path} — deleted` : canOpen ? f.path : `${f.path} — not on the map (filtered or not code)`}
              >
                <span className={`w-3 shrink-0 font-mono text-[11px] ${STATUS[f.status]}`}>{f.status}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{f.path}</span>
                <span className="shrink-0 font-mono text-[10.5px]">
                  <span className="text-good">+{f.add}</span> <span className="text-bad">−{f.del}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          onClick={() => onLight(visible)}
          disabled={!visible.length}
          className="rounded-md border border-line px-2 py-0.5 text-[12px] text-muted hover:text-text disabled:opacity-40"
        >
          Light them on the map
        </button>
        {data.commits.length > 0 && (
          <button
            onClick={() => onHistory(data.commits[0].sha, data.commits.at(-1)!.sha)}
            className="rounded-md border border-line px-2 py-0.5 text-[12px] text-muted hover:text-text"
            title="Turn the map to these commits and see what each one did"
          >
            Open in History
          </button>
        )}
      </div>
    </div>
  );
}
