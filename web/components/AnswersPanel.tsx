import { useEffect, useMemo, useRef, useState } from "react";
import type { Frame } from "../../shared/types";

/**
 * Every answer the navigator has given in this repo, newest first, to jump
 * between. Type to narrow by question or answer; ↑ ↓ to move, Enter to open.
 */

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

function shows(f: Frame) {
  const kinds = new Map<string, number>();
  for (const v of f.views) kinds.set(v.kind, (kinds.get(v.kind) ?? 0) + 1);
  const names: Record<string, string> = { code: "code", diagram: "diagram", custom: "visual", text: "note", diff: "diff" };
  return [...kinds].map(([k, n]) => `${n > 1 ? `${n} ` : ""}${names[k] ?? k}${n > 1 ? "s" : ""}`).join(", ");
}

export function AnswersPanel({
  frames,
  current,
  onOpen,
  onClose,
}: {
  frames: Frame[];
  /** The answer open in the panel, if any. */
  current: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const newest = [...frames].reverse();
    return needle ? newest.filter((f) => `${f.request} ${f.title} ${f.answer}`.toLowerCase().includes(needle)) : newest;
  }, [frames, q]);
  const [at, setAt] = useState(() => Math.max(0, list.findIndex((f) => f.id === current)));
  useEffect(() => setAt(0), [q]);
  const ul = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ul.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  return (
    <div className="glass rise pointer-events-auto flex max-h-[min(70vh,640px)] w-[min(400px,calc(100vw-2rem))] flex-col rounded-xl p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-cond text-[18px] font-semibold">Answers</h2>
        <button onClick={onClose} className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:text-text">
          Done
        </button>
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setAt((i) => Math.min(list.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAt((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && list[at]) onOpen(list[at].id);
          else if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder={`Search ${frames.length} answers…`}
        className="mb-2 w-full rounded-md border border-line bg-panelsolid px-2.5 py-1.5 text-[13px] focus:border-course/60 focus:outline-none"
      />
      {list.length === 0 ? (
        <p className="text-[12.5px] text-muted">{frames.length ? "Nothing matches." : "No answers yet — ask the navigator something."}</p>
      ) : (
        <ul ref={ul} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" role="listbox" aria-label="Answers">
          {list.map((f, i) => (
            <li key={f.id} data-i={i}>
              <button
                role="option"
                aria-selected={f.id === current}
                onClick={() => onOpen(f.id)}
                onMouseEnter={() => setAt(i)}
                className={`w-full rounded-md px-2 py-1.5 text-left ${i === at ? "bg-white/[.06]" : ""} ${f.id === current ? "ring-1 ring-course/60" : ""}`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text/95">{f.request || f.title}</span>
                  <span className="shrink-0 text-[11px] text-muted">{f.state === "working" ? "working…" : ago(f.createdAt)}</span>
                </span>
                <span className="mt-0.5 flex items-baseline gap-2 text-[11.5px] text-muted">
                  {f.state === "error" ? (
                    <span className="text-bad">failed</span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{f.answer.replace(/\s+/g, " ").slice(0, 140)}</span>
                  )}
                  {(f.views.length > 0 || f.focus.length > 0) && (
                    <span className="shrink-0">
                      {[shows(f), f.focus.length ? `${f.focus.length} file${f.focus.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11.5px] text-muted">↑ ↓ to move · Enter to open · a to toggle</p>
    </div>
  );
}
