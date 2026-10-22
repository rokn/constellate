import { useEffect, useState } from "react";
import type { LibraryRepo } from "../../shared/types";
import { post } from "../lib/api";

/**
 * The GitHub repos a server keeps (CODEFLIGHT_REPOS_DIR): open one you had,
 * or give it a new one to clone. Each comes back with its map, groupings,
 * notes and answers as you left them.
 */

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(t).toLocaleDateString();
};

export function Shelf({ autoFocus, onOpened }: { autoFocus?: boolean; onOpened?: () => void }) {
  const [repos, setRepos] = useState<LibraryRepo[] | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    void fetch("/api/repos")
      .then((r) => (r.ok ? (r.json() as Promise<LibraryRepo[]>) : []))
      .then(setRepos)
      .catch(() => setRepos([]));
  useEffect(load, []);

  const open = async (github: string) => {
    setBusy(true);
    setError(null);
    const r = await post("/api/open", { github }).catch(() => null);
    setBusy(false);
    if (!r?.ok) return setError(((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't open it.");
    onOpened?.();
  };

  const remove = async (r: LibraryRepo) => {
    if (!window.confirm(`Remove ${r.id}? Its clone goes, and so does its map, with its groupings, notes, answers and stories.`)) return;
    await post("/api/repos", { action: "remove", id: r.id });
    load();
  };

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) void open(input.trim());
        }}
        className="glass flex items-center gap-2 rounded-xl px-3 py-2"
      >
        <input
          autoFocus={autoFocus}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="github.com/owner/repo"
          className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[14px] focus:outline-none"
          aria-label="GitHub repository"
        />
        <button disabled={busy} className="rounded-lg bg-course px-4 py-1.5 font-cond text-[16px] font-semibold text-night hover:brightness-110 disabled:opacity-60">
          Take off
        </button>
      </form>
      {error && <p className="mt-2 text-[13px] text-bad">{error}</p>}
      {!!repos?.length && (
        <ul className="mt-4 max-h-[50vh] space-y-0.5 overflow-y-auto">
          {repos.map((r) => (
            <li key={r.id} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
              <button
                type="button"
                disabled={r.current || busy}
                onClick={() => void open(r.id)}
                className="min-w-0 flex-1 text-left disabled:cursor-default"
                title={r.current ? "Open now" : `Open ${r.id}`}
              >
                <span className={`font-mono text-[13px] ${r.current ? "text-course" : "text-text/90 group-hover:text-course"}`}>{r.id}</span>
                <span className="ml-2 text-[11.5px] text-muted">{r.current ? "open now" : r.openedAt ? ago(r.openedAt) : ""}</span>
                <span className="block truncate text-[12.5px] text-muted">{r.headline ?? "Not mapped yet"}</span>
              </button>
              {!r.current && (
                <button
                  type="button"
                  onClick={() => void remove(r)}
                  className="mt-0.5 text-[12px] text-muted opacity-0 hover:text-bad focus:opacity-100 group-hover:opacity-100"
                  title="Remove its clone and its saved map"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
