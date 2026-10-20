import { useState } from "react";
import type { Note, NoteTarget } from "../../shared/types";

/**
 * Your notes: pinned to a file or an import line, drawn on the map as yellow
 * sticky cards. The editor writes or edits one; the panel lists them all.
 */

export const NOTE_BG = "#ffd75e";

const name = (p: string) => p.split("/").pop()!;
export const describeTarget = (t: NoteTarget) => (t.kind === "file" ? name(t.path) : `${name(t.from)} → ${name(t.to)}`);
const fullTarget = (t: NoteTarget) => (t.kind === "file" ? t.path : `${t.from} → ${t.to}`);

export function NoteEditor({
  target,
  note,
  onSave,
  onDelete,
  onGo,
  onClose,
}: {
  target: NoteTarget;
  /** Editing this note; absent when writing a new one. */
  note?: Note;
  onSave: (text: string) => void;
  onDelete?: () => void;
  onGo: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(note?.text ?? "");
  const save = () => (text.trim() ? onSave(text.trim()) : onClose());
  return (
    <div
      className="rise pointer-events-auto w-[min(420px,calc(100vw-2rem))] rounded-xl p-3 shadow-[0_20px_60px_-20px_rgba(0,0,0,.8)]"
      style={{ background: "#16130a", border: `1px solid ${NOTE_BG}66` }}
      role="dialog"
      aria-label="Note"
    >
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-cond text-[16px] font-semibold" style={{ color: NOTE_BG }}>
          {note ? "Note" : "New note"}
        </span>
        <button onClick={onGo} className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-muted hover:text-text" title={`Fly to ${fullTarget(target)}`}>
          on {target.kind === "file" ? "" : "the import "}
          {fullTarget(target)}
        </button>
      </div>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        rows={4}
        placeholder="What you want to remember here — why it's like this, what to check, a todo…"
        className="w-full resize-y rounded-md border border-line bg-black/30 px-2.5 py-2 text-[13.5px] leading-snug focus:outline-none"
        style={{ borderColor: `${NOTE_BG}44` }}
      />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={save} className="rounded-md px-3 py-1 text-[13px] font-semibold text-black" style={{ background: NOTE_BG }}>
          {note ? "Save" : "Pin note"}
        </button>
        <button onClick={onClose} className="rounded-md px-2 py-1 text-[13px] text-muted hover:text-text">
          Cancel
        </button>
        <span className="text-[11.5px] text-muted">⌘↵ to save</span>
        {onDelete && (
          <button onClick={onDelete} className="ml-auto rounded-md px-2 py-1 text-[13px] text-muted hover:text-bad">
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

export function NotesPanel({ notes, onOpen, onClose }: { notes: Note[]; onOpen: (n: Note) => void; onClose: () => void }) {
  const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="glass rise pointer-events-auto w-[min(380px,calc(100vw-2rem))] space-y-2 rounded-xl p-3.5">
      <div className="flex items-center justify-between">
        <h2 className="font-cond text-[18px] font-semibold">Notes</h2>
        <button onClick={onClose} className="rounded px-2 py-0.5 text-[12.5px] text-muted hover:text-text">
          Done
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          Pin a note to a file with <kbd className="font-mono">n</kbd> or the code panel's Note button, or to an import line by right-clicking it (or
          hovering it and pressing <kbd className="font-mono">n</kbd>).
        </p>
      ) : (
        <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
          {sorted.map((n) => (
            <li key={n.id}>
              <button onClick={() => onOpen(n)} className="w-full rounded-md px-2 py-1.5 text-left hover:bg-white/5" title={fullTarget(n.target)}>
                <span className="flex items-baseline gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: NOTE_BG }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">{describeTarget(n.target)}</span>
                </span>
                <span className="mt-0.5 line-clamp-2 block pl-4 text-[13px] text-text/90">{n.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
