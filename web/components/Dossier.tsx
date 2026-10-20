import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Activity, Frame, View } from "../../shared/types";
import { CodeBlock } from "./CodeBlock";
import { CustomView } from "./CustomView";
import { DiagramView } from "./DiagramView";

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
}: {
  frames: Frame[];
  frameId: string;
  pointer: Pointer;
  activity: Activity[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenFile: (path: string, line?: number, endLine?: number) => void;
  onRetry: (frame: Frame) => void;
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

const KIND: Record<View["kind"], string> = {
  text: "Note",
  code: "Code",
  diagram: "Diagram",
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
  const title =
    view.kind === "code" ? view.title ?? view.path : view.kind === "text" ? view.title : view.title;
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
      </div>

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

      {view.kind === "custom" && <CustomView html={view.html} height={view.height} onOpen={(p, l) => onOpenFile(p, l)} />}

      {view.kind === "text" && (
        <div className="prose-nav px-3 py-2.5">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.markdown}</ReactMarkdown>
        </div>
      )}
    </section>
  );
}
