import { useState } from "react";
import type { AgentRun } from "../../shared/types";
import { post } from "../lib/api";

/**
 * Coding agents on this repo: start one, follow what each is doing, tell it
 * more, see its branch on the map, bring it up to date with its base, stop it
 * or throw its work away. Each works on its own branch in its own worktree;
 * nothing lands until you land it.
 */

const STATUS: Record<AgentRun["status"], { label: string; dot: string }> = {
  starting: { label: "Starting", dot: "bg-runtime animate-pulse" },
  working: { label: "Working", dot: "bg-runtime animate-pulse" },
  done: { label: "Done", dot: "bg-good" },
  failed: { label: "Failed", dot: "bg-bad" },
  stopped: { label: "Stopped", dot: "bg-muted" },
};

async function act(body: Record<string, unknown>): Promise<string | null> {
  const r = await post("/api/agents", body);
  if (r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error ?? "That didn't work.";
}

function Agent({ a, onShow }: { a: AgentRun; onShow: (a: AgentRun) => void }) {
  const [reply, setReply] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const running = a.status === "working" || a.status === "starting";
  const s = STATUS[a.status];
  // Which action is under way, so only its button says so.
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (body: { action: string } & Record<string, unknown>) => {
    setBusy(body.action);
    setError((await act({ id: a.id, ...body })) ?? "");
    setBusy(null);
  };

  return (
    <li className="rounded-lg border border-line/60 p-2.5">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left" aria-expanded={open}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} title={s.label} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{a.title}</span>
        <span className="text-[11.5px] tabular-nums text-muted">
          {a.files.length} file{a.files.length === 1 ? "" : "s"}
        </span>
      </button>
      <p className="mt-1 truncate text-[12px] text-muted">
        {running ? a.activity ?? s.label : a.error ?? s.label}
        <span className="ml-1.5 font-mono text-[11px] opacity-70">{a.branch}</span>
        {a.pr && (
          <a href={a.pr.url} target="_blank" rel="noreferrer" className="ml-1.5 text-course hover:underline">
            PR #{a.pr.number}
            {a.pr.state === "merged" ? " merged" : ""}
          </a>
        )}
      </p>
      {open && (
        <div className="mt-2 space-y-2 text-[12.5px]">
          {a.summary && <p className="whitespace-pre-wrap leading-snug">{a.summary}</p>}
          {a.files.length > 0 && (
            <ul className="max-h-28 overflow-y-auto font-mono text-[11.5px] text-muted">
              {a.files.map((f) => (
                <li key={f} className="truncate">
                  {f}
                </li>
              ))}
            </ul>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!reply.trim()) return;
              void run({ action: "message", text: reply });
              setReply("");
            }}
          >
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={running ? "Tell it more (goes after its current step)…" : "Ask for a follow-up change…"}
              className="w-full rounded-md border border-line bg-panelsolid px-2 py-1 text-[12.5px] focus:border-course/60 focus:outline-none"
            />
          </form>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => onShow(a)}
              disabled={!a.commits && !a.files.length}
              className="glass rounded-md px-2 py-0.5 text-muted hover:text-text disabled:opacity-40"
              title="Its branch on the map, lit against where it started"
            >
              Show on map
            </button>
            {running && (
              <button onClick={() => void run({ action: "stop" })} className="glass rounded-md px-2 py-0.5 text-muted hover:text-text">
                Stop
              </button>
            )}
            {!running && a.commits > 0 && a.pr?.state !== "merged" && (
              <button
                onClick={() => void run({ action: "rebase" })}
                disabled={!!busy}
                className="glass rounded-md px-2 py-0.5 text-muted hover:text-text disabled:opacity-40"
                title={`Replay its commits on top of ${a.pr?.base ?? (a.base === "HEAD" ? "the checkout" : a.base)} as it is now${a.pr?.state === "open" ? ", and push to its PR" : ""}`}
              >
                {busy === "rebase" ? "Rebasing…" : "Rebase"}
              </button>
            )}
            {!running && a.commits > 0 && !a.pr && (
              <button
                onClick={() => void run({ action: "pr" })}
                disabled={!!busy}
                className="glass rounded-md px-2 py-0.5 text-course hover:text-text disabled:opacity-40"
                title="Push its branch and open a pull request on GitHub"
              >
                {busy === "pr" ? "Opening…" : "Open PR"}
              </button>
            )}
            {!running && a.pr?.state === "open" && (
              <button
                onClick={() => {
                  if (confirm(`Merge PR #${a.pr!.number} "${a.title}" into ${a.pr!.base}? Merging to main deploys.`)) void run({ action: "merge" });
                }}
                disabled={!!busy}
                className="glass rounded-md px-2 py-0.5 text-good hover:text-text disabled:opacity-40"
                title="Rebase-merge its pull request on GitHub"
              >
                {busy === "merge" ? "Merging…" : "Merge"}
              </button>
            )}
            <button
              onClick={() => {
                if (confirm(`Discard "${a.title}"? Its branch ${a.branch} and everything it changed are deleted here${a.pr ? ` (PR #${a.pr.number} stays on GitHub)` : ""}.`)) void run({ action: "discard" });
              }}
              className="glass rounded-md px-2 py-0.5 text-muted hover:text-bad"
            >
              Discard
            </button>
            {a.costUsd ? <span className="ml-auto self-center text-[11px] tabular-nums text-muted">${a.costUsd.toFixed(2)}</span> : null}
          </div>
          {error && <p className="text-[12px] text-bad">{error}</p>}
        </div>
      )}
    </li>
  );
}

export function AgentsPanel({ agents, onShow, onClose }: { agents: AgentRun[]; onShow: (a: AgentRun) => void; onClose: () => void }) {
  const [task, setTask] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const newest = [...agents].reverse();

  return (
    <div className="glass rise pointer-events-auto flex max-h-[min(75vh,680px)] w-[min(420px,calc(100vw-2rem))] flex-col rounded-xl p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-cond text-[18px] font-semibold">Agents</h2>
        <button onClick={onClose} className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:text-text">
          Done
        </button>
      </div>
      <form
        className="mb-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!task.trim() || starting) return;
          setStarting(true);
          const err = await act({ action: "start", task });
          setStarting(false);
          setError(err ?? "");
          if (!err) setTask("");
        }}
      >
        <textarea
          autoFocus
          rows={2}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            } else if (e.key === "Escape") onClose();
          }}
          placeholder="What should an agent change? It works on its own branch."
          className="w-full resize-none rounded-md border border-line bg-panelsolid px-2.5 py-1.5 text-[13px] focus:border-course/60 focus:outline-none"
        />
        {error && <p className="mt-1 text-[12px] text-bad">{error}</p>}
        {starting && <p className="mt-1 text-[12px] text-muted">Making it a worktree…</p>}
      </form>
      {newest.length === 0 ? (
        <p className="text-[12.5px] text-muted">No agents yet. Start one here, or ask the voice to change something.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {newest.map((a) => (
            <Agent key={a.id} a={a} onShow={onShow} />
          ))}
        </ul>
      )}
    </div>
  );
}
