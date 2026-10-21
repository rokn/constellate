import { useState } from "react";
import type { RemoteStatus } from "../../shared/types";

/**
 * New commits on the branch's upstream, found by the server's periodic fetch:
 * what they are, and a pull that fast-forwards and rescans. Re-charting stays
 * a separate step, offered by the stale banner once the code has moved.
 */

const when = (t: number) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function RemoteBanner({ remote }: { remote: RemoteStatus }) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const n = remote.behind;
  const post = (url: string) => fetch(url, { method: "POST" }).catch(() => undefined);

  return (
    <div className={`glass pointer-events-auto rounded-md px-3 py-1.5 text-[12.5px] text-text/90 ${open ? "w-[min(440px,calc(100vw-2rem))]" : "max-w-[340px]"}`}>
      {n > 0 && (
        <>
          {n} new commit{n === 1 ? "" : "s"} on <span className="font-mono text-[11.5px]">{remote.upstream}</span>
          {remote.ahead > 0 ? ` (and ${remote.ahead} here that aren't there)` : ""}.{" "}
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-text underline-offset-2 hover:underline">
            {open ? "Hide" : "What's new?"}
          </button>{" "}
          ·{" "}
          <button
            onClick={() => void post("/api/remote/pull")}
            disabled={remote.pulling}
            className="text-course underline-offset-2 hover:underline disabled:opacity-50"
            title="Fast-forward to the upstream and rescan the map; your groupings, notes and answers are kept"
          >
            {remote.pulling ? "Pulling…" : "Pull and rescan"}
          </button>
        </>
      )}
      {remote.error && (
        <p className={`${n > 0 ? "mt-1" : ""} text-bad`}>
          {remote.error}{" "}
          <button
            onClick={() => {
              setChecking(true);
              void post("/api/remote/check").finally(() => setChecking(false));
            }}
            disabled={checking}
            className="text-text underline-offset-2 hover:underline disabled:opacity-50"
          >
            {checking ? "Checking…" : "Try again"}
          </button>
        </p>
      )}
      {open && n > 0 && (
        <ul className="mt-1.5 max-h-40 space-y-px overflow-y-auto border-t border-line/60 pt-1.5">
          {remote.commits.map((c) => (
            <li key={c.short} className="flex items-baseline gap-2 text-[12px]" title={`${c.author} · ${when(c.at)}`}>
              <span className="shrink-0 font-mono text-[11px] text-muted">{c.short}</span>
              <span className="min-w-0 truncate">{c.subject}</span>
            </li>
          ))}
          {n > remote.commits.length && <li className="text-[11.5px] text-muted">and {n - remote.commits.length} older</li>}
        </ul>
      )}
    </div>
  );
}
