import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Activity, AgentRun, Frame, GroupOverlay, View } from "../../shared/types";
import { post } from "../lib/api";
import { CodeBlock } from "./CodeBlock";
import { CustomView } from "./CustomView";
import { DiagramView } from "./DiagramView";
import { DiffStat, DiffView, parseDiff } from "./DiffView";

export type Pointer = { viewId?: string; nodeIds?: string[]; lines?: number[] } | null;

/**
 * Where the navigator's answers land. One frame at a time — a frame is one
 * stop on the flight — with the earlier ones a step away. Every view is
 * addressable, so the voice can point at it while it talks.
 */
export function Dossier({
  frames,
  frameId,
  pointer,
  activity,
  onSelect,
  onClose,
  onOpenFile,
  onRetry,
  markers,
  onMarkers,
  onFlyMarker,
  agents,
}: {
  frames: Frame[];
  frameId: string;
  pointer: Pointer;
  activity: Activity[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenFile: (path: string, line?: number, endLine?: number) => void;
  onRetry: (frame: Frame) => void;
  /** The markers this answer put on the map. */
  markers: GroupOverlay[];
  onMarkers: (action: "hide" | "show" | "delete") => void;
  onFlyMarker: (g: GroupOverlay) => void;
  /** The coding agents, for an answer that asks to confirm a merge. */
  agents: AgentRun[];
}) {
  const i = frames.findIndex((f) => f.id === frameId);
  const frame = frames[i];
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pointer?.viewId) return;
    body.current
      ?.querySelector(`[data-view-id="${pointer.viewId}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [pointer]);

  if (!frame) return null;
  const working = frame.state === "working";
  const latest = [...activity].reverse().find((a) => a.at >= frame.createdAt);

  return (
    <aside className="glass rise pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-xl shadow-[0_20px_60px_-20px_rgba(0,0,0,.7)]">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <button
          onClick={() => i > 0 && onSelect(frames[i - 1].id)}
          disabled={i <= 0}
          className="rounded px-1.5 text-muted hover:text-text disabled:opacity-30"
          aria-label="Previous answer"
        >
          ‹
        </button>
        <span className="font-cond text-[13px] tabular-nums text-muted">
          {i + 1} of {frames.length}
        </span>
        <button
          onClick={() => i < frames.length - 1 && onSelect(frames[i + 1].id)}
          disabled={i >= frames.length - 1}
          className="rounded px-1.5 text-muted hover:text-text disabled:opacity-30"
          aria-label="Next answer"
        >
          ›
        </button>
        <h2 className="ml-1 min-w-0 flex-1 truncate font-cond text-[19px] font-semibold tracking-wide">{frame.title}</h2>
        <button onClick={onClose} className="rounded px-2 py-0.5 text-[13px] text-muted hover:bg-white/5 hover:text-text" aria-label="Close answer">
          Close
        </button>
      </header>
      {working && <div className="working-bar h-px bg-line" />}

      <div ref={body} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6 pt-4">
        {frame.request && frame.request !== frame.title && (
          <p className="text-[13px] italic text-muted">“{frame.request}”</p>
        )}

        {frame.answer ? (
          <p className="text-[15.5px] leading-relaxed text-text">{frame.answer}</p>
        ) : working ? (
          <p className="text-[14px] text-muted">{latest?.detail ?? "Setting a course…"}</p>
        ) : null}

        {frame.confirm?.action === "merge" && <ConfirmMerge agent={agents.find((a) => a.id === frame.confirm!.agentId)} />}

        {markers.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
            <span>Marked on the map:</span>
            {markers.map((g) => (
              <button
                key={g.id}
                onClick={() => onFlyMarker(g)}
                className={`inline-flex items-center gap-1 hover:text-text ${g.visible ? "" : "opacity-55"}`}
                title={g.summary || "Fly there"}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: g.visible ? g.color : "transparent", border: `1.5px solid ${g.color}` }} />
                {g.label}
              </button>
            ))}
            <span className="ml-auto flex gap-1">
              <button onClick={() => onMarkers(markers.some((g) => g.visible) ? "hide" : "show")} className="rounded px-1.5 hover:bg-white/5 hover:text-text">
                {markers.some((g) => g.visible) ? "Hide" : "Show"}
              </button>
              <button onClick={() => onMarkers("delete")} className="rounded px-1.5 hover:text-bad">
                Delete
              </button>
            </span>
          </div>
        )}

        {frame.state === "error" && (
          <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[13.5px] text-bad">
            {frame.error ?? "The navigator stopped."}{" "}
            <button onClick={() => onRetry(frame)} className="ml-1 underline underline-offset-2">
              Ask again
            </button>
          </div>
        )}

        {frame.views.map((v) => (
          <ViewCard key={v.id} view={v} pointer={pointer?.viewId === v.id ? pointer : null} onOpenFile={onOpenFile} />
        ))}

        {working && frame.views.length > 0 && latest && (
          <p className="text-[13px] text-muted">{latest.detail}…</p>
        )}
      </div>
    </aside>
  );
}

/**
 * A merge asked for in Ask, waiting for its yes. Merging to main deploys, so
 * the navigator never merges on a typed request: this button is the yes.
 */
function ConfirmMerge({ agent: a }: { agent?: AgentRun }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  if (!a) return <p className="text-[13px] text-muted">The agent this merge was for has been discarded.</p>;
  if (a.pr?.state === "merged") {
    return (
      <p className="text-[13px] text-good">
        Merged: PR #{a.pr.number} into {a.pr.base}.
      </p>
    );
  }
  const running = a.status === "working" || a.status === "starting";
  const what = a.pr?.state === "open" ? `PR #${a.pr.number} “${a.title}” into ${a.pr.base}` : `“${a.title}” (its branch is pushed and a PR opened first)`;

  return (
    <div className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-[13.5px]">
      <p>
        Merge {what}? Merging to main deploys.
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={async () => {
            setBusy(true);
            const r = await post("/api/agents", { action: "merge", id: a.id });
            const j = r.ok ? null : ((await r.json().catch(() => ({}))) as { error?: string });
            setError(j ? j.error ?? "That didn't work." : "");
            setBusy(false);
          }}
          disabled={busy || running}
          className="glass rounded-md px-2.5 py-0.5 text-good hover:text-text disabled:opacity-40"
          title="Rebase-merge its pull request on GitHub"
        >
          {busy ? "Merging…" : "Merge"}
        </button>
        <button onClick={() => setDismissed(true)} disabled={busy} className="rounded-md px-2 py-0.5 text-muted hover:text-text disabled:opacity-40">
          Not now
        </button>
        {running && <span className="text-[12px] text-muted">It's still working; merge once it finishes.</span>}
      </div>
      {error && <p className="mt-1 text-[12px] text-bad">{error}</p>}
    </div>
  );
}

const KIND: Record<View["kind"], string> = {
  text: "Note",
  code: "Code",
  diagram: "Diagram",
  diff: "Diff",
  custom: "Visualization",
};

function ViewCard({
  view,
  pointer,
  onOpenFile,
}: {
  view: View;
  pointer: Pointer;
  onOpenFile: (path: string, line?: number, endLine?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const title =
    view.kind === "code" || view.kind === "diff" ? view.title ?? view.path : view.title;
  const tag =
    view.kind === "diagram" ? (view.layer === "logical" ? "Runtime" : "Static") : KIND[view.kind];
  const tagTone =
    view.kind === "diagram"
      ? view.layer === "logical" ? "text-runtime border-runtime/40" : "text-static border-static/40"
      : "text-muted border-line";

  return (
    <section
      data-view-id={view.id}
      className={`rise overflow-hidden rounded-lg border bg-panelsolid/70 ${pointer ? "pointed" : "border-line"}`}
    >
      <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2">
        <span className={`rounded border px-1.5 font-cond text-[11.5px] font-medium tracking-wide ${tagTone}`}>{tag}</span>
        {title && <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{title}</h3>}
        {view.kind === "code" && (
          <button
            onClick={() => onOpenFile(view.path, view.startLine, view.startLine + view.code.split("\n").length - 1)}
            className="shrink-0 rounded px-1.5 text-[12px] text-muted hover:bg-white/5 hover:text-course"
            title={`Open ${view.path}`}
          >
            Open file
          </button>
        )}
        {(view.kind === "diagram" || view.kind === "custom") && (
          <button
            onClick={() => setExpanded(true)}
            className="shrink-0 rounded px-1.5 text-[12px] text-muted hover:bg-white/5 hover:text-text"
            title="See it full screen (Esc to come back)"
          >
            Full screen
          </button>
        )}
      </div>
      {expanded && (view.kind === "diagram" || view.kind === "custom") && (
        <FullView view={view} title={title ?? ""} pointer={pointer} onOpenFile={onOpenFile} onClose={() => setExpanded(false)} />
      )}

      {view.kind === "code" && (
        <>
          {view.note && <p className="px-3 pt-2 text-[13px] text-muted">{view.note}</p>}
          <div className="text-[12px] text-muted/80 px-3 pt-1 font-mono">
            {view.path}:{view.startLine}
          </div>
          <CodeBlock
            code={view.code}
            lang={view.lang}
            startLine={view.startLine}
            highlight={view.highlight}
            annotations={view.annotations}
            pointed={pointer?.lines ?? []}
            maxHeight="26rem"
          />
        </>
      )}

      {view.kind === "diagram" && (
        <div className="p-3">
          <DiagramView
            spec={view}
            tone={view.layer === "logical" ? "var(--runtime)" : "var(--static)"}
            emphasis={pointer?.nodeIds ?? []}
            onNodeClick={(id) => {
              const n = view.nodes.find((x) => x.id === id);
              if (n?.path) onOpenFile(n.path);
            }}
          />
        </div>
      )}

      {view.kind === "diff" && (
        <>
          <div className="flex items-baseline gap-3 px-3 pt-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted/80">{view.path}</span>
            <DiffStat {...parseDiff(view.diff)} />
          </div>
          {view.note && <p className="px-3 pt-1 text-[13px] text-muted">{view.note}</p>}
          <DiffView diff={view.diff} lang={view.lang} maxHeight="28rem" />
        </>
      )}

      {view.kind === "custom" && <CustomView html={view.html} height={view.height} onOpen={(p, l) => onOpenFile(p, l)} />}

      {view.kind === "text" && (
        <div className="prose-nav px-3 py-2.5">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.markdown}</ReactMarkdown>
        </div>
      )}
    </section>
  );
}

/**
 * A diagram or visualization filling the window. Rendered into <body> so the
 * panel's edges don't clip it; Esc closes just this, not the panel behind.
 */
function FullView({
  view,
  title,
  pointer,
  onOpenFile,
  onClose,
}: {
  view: Extract<View, { kind: "diagram" | "custom" }>;
  title: string;
  pointer: Pointer;
  onOpenFile: (path: string, line?: number, endLine?: number) => void;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Captured first, so the app's own Esc (closing the panel) doesn't also fire.
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const open = (path: string, line?: number) => {
    onClose();
    onOpenFile(path, line);
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-night/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate font-cond text-[19px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded px-2 py-0.5 text-[13px] text-muted hover:bg-white/5 hover:text-text">
            Exit full screen
          </button>
        </div>
        <div ref={body} className={`min-h-0 flex-1 ${view.kind === "diagram" ? "overflow-hidden" : "overflow-auto p-6"}`}>
          {view.kind === "diagram" && room.h > 0 && (
            <ZoomableDiagram view={view} pointer={pointer} room={room} onOpen={open} />
          )}
          {view.kind === "custom" && room.h > 0 && (
            <CustomView html={view.html} height={Math.max(room.h - 48, view.height ?? 0)} onOpen={(p, l) => open(p, l)} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A diagram you can actually read at full screen: it opens fitted to the
 * window, the wheel zooms toward the pointer, dragging pans, and Rotate
 * re-lays it top-to-bottom (a long pipeline often fits a screen better that
 * way). Boxes stay clickable — a press only becomes a pan once it moves.
 */
function ZoomableDiagram({
  view,
  pointer,
  room,
  onOpen,
}: {
  view: Extract<View, { kind: "diagram" }>;
  pointer: Pointer;
  room: { w: number; h: number };
  onOpen: (path: string) => void;
}) {
  const [dir, setDir] = useState(view.dir);
  const spec = { ...view, dir };
  const content = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  /** Set when a press turned into a pan, so the click that follows is swallowed. */
  const panned = useRef(false);

  // Measure the laid-out diagram (it changes when rotated).
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.scrollWidth, h: el.scrollHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [dir]);

  const fitScale = size.w && size.h ? Math.min(2, (room.w - 64) / size.w, (room.h - 96) / size.h) : 1;
  const fit = () => setT({ s: fitScale, x: (room.w - size.w * fitScale) / 2, y: (room.h - size.h * fitScale) / 2 });
  // Re-fit whenever the diagram's size or the room changes (opening, rotating, resizing).
  useEffect(() => {
    if (size.w && size.h) fit();
    // fit reads the latest values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, room.w, room.h]);

  const zoomAt = (cx: number, cy: number, s: number) =>
    setT((p) => {
      const next = Math.max(fitScale * 0.5, Math.min(4, s));
      return { s: next, x: cx - ((cx - p.x) * next) / p.s, y: cy - ((cy - p.y) * next) / p.s };
    });

  return (
    <div
      className="relative h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
      onWheel={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, t.s * Math.exp(-e.deltaY * 0.0015));
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
        d.moved = true;
        setT((p) => ({ ...p, x: d.tx + dx, y: d.ty + dy }));
      }}
      onPointerUp={() => {
        panned.current = !!drag.current?.moved;
        drag.current = null;
      }}
      // A pan that ends over a box must not count as a click on it. The click
      // arrives after pointerup, hence the flag rather than the drag state.
      onClickCapture={(e) => {
        if (panned.current) e.stopPropagation();
        panned.current = false;
      }}
    >
      <div
        ref={content}
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, width: "max-content" }}
      >
        <DiagramView
          key={dir}
          spec={spec}
          natural
          tone={view.layer === "logical" ? "var(--runtime)" : "var(--static)"}
          emphasis={pointer?.nodeIds ?? []}
          onNodeClick={(id) => {
            const n = view.nodes.find((x) => x.id === id);
            if (n?.path) onOpen(n.path);
          }}
        />
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-line bg-panelsolid/90 p-1 text-[12.5px]">
        <button onClick={() => zoomAt(room.w / 2, room.h / 2, t.s / 1.25)} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text" aria-label="Zoom out">−</button>
        <span className="w-12 text-center font-mono text-[11.5px] tabular-nums text-muted">{Math.round(t.s * 100)}%</span>
        <button onClick={() => zoomAt(room.w / 2, room.h / 2, t.s * 1.25)} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text" aria-label="Zoom in">+</button>
        <button onClick={fit} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text">Fit</button>
        <button onClick={() => zoomAt(room.w / 2, room.h / 2, 1)} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text">100%</button>
        <button
          onClick={() => setDir((d) => (d === "LR" ? "TD" : "LR"))}
          className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text"
          title="Re-lay the diagram left-to-right or top-to-bottom"
        >
          Rotate
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-4 text-[11.5px] text-muted/70">Scroll to zoom · drag to pan · click a box to open its file</p>
    </div>
  );
}
