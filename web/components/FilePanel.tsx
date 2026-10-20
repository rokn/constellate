import { useEffect, useMemo, useState } from "react";
import { fetchFile, type FileData } from "../lib/api";
import { CodeBlock } from "./CodeBlock";
import { GoEditor } from "./GoEditor";
import { DiffStat, DiffView } from "./DiffView";

/** The open file's change in the span of history shown on the map. */
export type FileChange = { from: string; to: string; add: number; del: number; status: "A" | "M" | "D"; label?: string };

/**
 * The code panel. A file is never a dead end: everything it imports and
 * everything that imports it is one click (and one flight) away, and its
 * symbols are a jump list.
 */
export function FilePanel({
  path,
  line,
  endLine,
  change,
  onClose,
  onNavigate,
  onAsk,
  onHide,
  goEditor,
  onReferences,
  onSelection,
  full,
  onToggleFull,
}: {
  path: string;
  line?: number;
  endLine?: number;
  change?: FileChange;
  onClose: () => void;
  onNavigate: (path: string, line?: number) => void;
  onAsk: (request: string) => void;
  onHide: () => void;
  /** Use VS Code's editor with gopls for Go files. */
  goEditor?: boolean;
  onReferences?: (name: string, paths: string[]) => void;
  onSelection?: (text: string) => void;
  /** Taking the whole window. */
  full?: boolean;
  onToggleFull?: () => void;
}) {
  const [file, setFile] = useState<FileData | null | undefined>(undefined);
  const [jump, setJump] = useState<number | undefined>(line);
  // A file that changed in the shown span opens on its diff.
  const [tab, setTab] = useState<"changes" | "source">(change ? "changes" : "source");
  const [diff, setDiff] = useState<string | null | undefined>(undefined);
  const changeKey = change ? `${change.from}..${change.to}` : "";
  // Keyed by the range, not the change object, which is rebuilt on every update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setTab(change && !line ? "changes" : "source"), [path, changeKey, line]);
  useEffect(() => {
    if (!change || tab !== "changes") return;
    let live = true;
    setDiff(undefined);
    fetch(`/api/diff?path=${encodeURIComponent(path)}&from=${change.from}&to=${change.to}`)
      .then((r) => (r.ok ? r.json() : { diff: null }))
      .then((b: { diff: string | null }) => live && setDiff(b.diff))
      .catch(() => live && setDiff(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, changeKey, tab]);

  useEffect(() => {
    let live = true;
    setFile(undefined);
    fetchFile(path).then((f) => live && setFile(f));
    return () => {
      live = false;
    };
  }, [path]);

  useEffect(() => setJump(line), [line, path]);

  const range = useMemo(() => {
    if (!line) return [];
    const end = Math.max(line, endLine ?? line);
    return Array.from({ length: Math.min(end - line + 1, 400) }, (_, i) => line + i);
  }, [line, endLine]);

  const segs = path.split("/");

  return (
    <aside className="glass rise pointer-events-auto flex h-full w-full flex-col overflow-hidden rounded-xl shadow-[0_20px_60px_-20px_rgba(0,0,0,.7)]">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[12px] text-muted">{segs.slice(0, -1).join("/") || "/"}</p>
          <h2 className="truncate font-cond text-[21px] font-semibold leading-tight">{segs.at(-1)}</h2>
          {file && (
            <p className="mt-0.5 text-[12.5px] text-muted">
              {file.lang}, {file.text.split("\n").length} lines
              {file.externals.length > 0 && <> · uses {file.externals.slice(0, 5).join(", ")}</>}
            </p>
          )}
        </div>
        <button
          onClick={() => onAsk(`Explain ${path}: what it's for, how it works, and what depends on it.`)}
          className="shrink-0 rounded-md border border-course/50 px-2.5 py-1 text-[13px] text-course hover:bg-course/10"
        >
          Explain this file
        </button>
        <button
          onClick={onHide}
          title="Hide this file from the map (x) — bring it back from Filter"
          className="shrink-0 rounded px-2 py-1 text-[13px] text-muted hover:bg-white/5 hover:text-text"
        >
          Hide
        </button>
        {onToggleFull && (
          <button
            onClick={onToggleFull}
            aria-pressed={!!full}
            title={full ? "Back to the side panel (Esc)" : "Fill the window with the code"}
            className="shrink-0 rounded px-2 py-1 text-[13px] text-muted hover:bg-white/5 hover:text-text"
          >
            {full ? "Exit full screen" : "Full screen"}
          </button>
        )}
        <button onClick={onClose} className="shrink-0 rounded px-2 py-1 text-[13px] text-muted hover:bg-white/5 hover:text-text">
          Close
        </button>
      </header>

      {file && (file.imports.length > 0 || file.importers.length > 0) && (
        <div className="space-y-1.5 border-b border-line px-4 py-2.5 text-[12.5px]">
          {file.imports.length > 0 && (
            <Links label="Imports" tone="static" paths={file.imports} links={file.importLinks} verb="takes" onPick={(p) => onNavigate(p)} />
          )}
          {file.importers.length > 0 && (
            <Links
              label="Used by"
              tone="course"
              paths={file.importers}
              links={file.importerLinks}
              verb="uses"
              // Land on the line that imports this file.
              onPick={(p, line) => onNavigate(p, line)}
            />
          )}
        </div>
      )}

      {file && file.symbols.length > 0 && (
        <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
          {file.symbols.map((s) => (
            <button
              key={`${s.name}${s.line}`}
              onClick={() => setJump(s.line)}
              className="shrink-0 rounded px-2 py-0.5 font-mono text-[11.5px] text-muted hover:bg-white/5 hover:text-text"
              title={`${s.kind} at line ${s.line}`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {change && (
        <div className="flex items-center gap-1 border-b border-line px-3 py-1.5">
          {(["changes", "source"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`rounded px-2 py-0.5 text-[12.5px] ${tab === t ? "bg-white/10 text-text" : "text-muted hover:text-text"}`}
            >
              {t === "changes" ? (change.status === "A" ? "Added" : "Changes") : "Source"}
            </button>
          ))}
          <span className="ml-1"><DiffStat add={change.add} del={change.del} /></span>
          {change.label && <span className="min-w-0 truncate text-[12px] text-muted">in {change.label}</span>}
          <button
            onClick={() => onAsk(`Explain what changed in ${path} between ${change.from === change.to ? `commit ${change.to.slice(0, 9)}` : `${change.from.slice(0, 9)} and ${change.to.slice(0, 9)}`}, and why. Show the diff that matters and light the range on the map.`)}
            className="ml-auto shrink-0 rounded-md border border-course/50 px-2 py-0.5 text-[12.5px] text-course hover:bg-course/10"
          >
            Explain this change
          </button>
        </div>
      )}

      {change && tab === "changes" ? (
        <div className="min-h-0 flex-1">
          {diff === undefined && <p className="p-4 text-[13px] text-muted">Reading the diff…</p>}
          {diff === null && <p className="p-4 text-[13px] text-bad">The diff couldn’t be read.</p>}
          {diff && <DiffView diff={diff} lang={file?.lang ?? "text"} maxHeight="100%" />}
          {diff === "" && <p className="p-4 text-[13px] text-muted">No changes to this file in the range.</p>}
        </div>
      ) : (
      <div className="min-h-0 flex-1" data-selectable="file">
        {file === undefined && <p className="p-4 text-[13px] text-muted">Opening…</p>}
        {file === null && <p className="p-4 text-[13px] text-bad">This file couldn’t be read. It may have moved since the scan.</p>}
        {file && (
          goEditor && file.lang === "go" ? (
            <GoEditor
              path={file.path}
              line={jump}
              endLine={jump === line ? endLine : undefined}
              onOpenRepoFile={(p, l) => onNavigate(p, l)}
              onReferences={(n, ps) => onReferences?.(n, ps)}
              onSelection={(t) => onSelection?.(t)}
            />
          ) : (
            <CodeBlock code={file.text} lang={file.lang} highlight={range} scrollTo={jump} maxHeight="100%" />
          )
        )}
      </div>
      )}
    </aside>
  );
}

function Links({
  label,
  tone,
  paths,
  links,
  verb,
  onPick,
}: {
  label: string;
  tone: "static" | "course";
  paths: string[];
  links?: { path: string; names: string[]; line?: number }[];
  verb: string;
  onPick: (path: string, line?: number) => void;
}) {
  const byPath = new Map((links ?? []).map((l) => [l.path, l]));
  return (
    <div className="flex items-baseline gap-2">
      <span className={`w-14 shrink-0 font-cond text-[12.5px] ${tone === "static" ? "text-static" : "text-course"}`}>{label}</span>
      <div className="flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5">
        {paths.slice(0, 14).map((p) => (
          <button
            key={p}
            onClick={() => onPick(p, byPath.get(p)?.line)}
            className="font-mono text-[11.5px] text-text/85 hover:text-course"
            title={byPath.get(p)?.names.length ? `${p}\n${verb}: ${byPath.get(p)!.names.join(", ")}` : p}
          >
            {p.split("/").pop()}
          </button>
        ))}
        {paths.length > 14 && <span className="text-muted">and {paths.length - 14} more</span>}
      </div>
    </div>
  );
}
