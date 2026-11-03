import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "../lib/useVoice";

/**
 * The voice's transcript: everything said — yours and its — with what
 * happened along the way (talked over, a sound it ignored, reconnecting), so
 * when it cuts off you can see why. A floating panel: drag it by its title
 * to wherever you want it; pinned, it stays open (and there) across reloads.
 * Used by the code map and the workshop alike.
 */

type Place = { x: number; y: number; pinned: boolean };

function load(key: string): Place | null {
  try {
    const p = JSON.parse(localStorage.getItem(key) ?? "null") as Place | null;
    return p && typeof p.x === "number" ? p : null;
  } catch {
    return null;
  }
}

export function useTranscriptOpen(key: string) {
  const [open, setOpen] = useState(() => !!load(key)?.pinned);
  return [open, setOpen] as const;
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function TranscriptLog({
  log,
  heard,
  caption,
  onClear,
  onClose,
  storageKey = "voice.log",
}: {
  log: LogEntry[];
  /** What they're saying right now, and what it's saying: shown live under the log. */
  heard?: string;
  caption?: string;
  onClear: () => void;
  onClose: () => void;
  storageKey?: string;
}) {
  const [place, setPlace] = useState<Place>(() => load(storageKey) ?? { x: 24, y: 120, pinned: false });
  const [notes, setNotes] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(place));
    } catch {
      /* not kept */
    }
  }, [place, storageKey]);

  // Follow the newest line, unless they've scrolled up to read.
  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log.length, heard, caption]);

  const shown = notes ? log : log.filter((e) => e.who !== "note");
  const copy = () => {
    const text = log.map((e) => `[${time(e.at)}] ${e.who === "you" ? "You" : e.who === "voice" ? "Voice" : "·"}: ${e.text}${e.cut ? " (cut off)" : ""}`).join("\n");
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  return (
    <div
      className="pointer-events-auto fixed z-40 flex w-[340px] flex-col overflow-hidden rounded-lg border border-cyan-300/25 bg-[#06121c]/92 text-[#dff6ff] shadow-2xl backdrop-blur"
      style={{ left: Math.max(0, Math.min(place.x, innerWidth - 120)), top: Math.max(0, Math.min(place.y, innerHeight - 60)), height: 360 }}
    >
      <div
        className="flex cursor-move select-none items-center gap-2 border-b border-cyan-300/15 px-3 py-2"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          drag.current = { dx: e.clientX - place.x, dy: e.clientY - place.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setPlace((p) => ({ ...p, x: e.clientX - d.dx, y: e.clientY - d.dy }));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300">Transcript</span>
        <span className="flex-1" />
        <button className={`rounded px-1.5 text-[11px] ${notes ? "text-[#ffb547]" : "text-[#7fa6bd]"}`} onClick={() => setNotes((n) => !n)} title="Show what happened too (talked over, reconnecting…)">
          events
        </button>
        <button className="rounded px-1.5 text-[11px] text-[#7fa6bd] hover:text-white" onClick={copy} title="Copy it all">
          copy
        </button>
        <button className="rounded px-1.5 text-[11px] text-[#7fa6bd] hover:text-white" onClick={onClear} title="Clear">
          clear
        </button>
        <button
          className={`rounded px-1.5 text-[13px] ${place.pinned ? "text-[#ffb547]" : "text-[#7fa6bd] hover:text-white"}`}
          onClick={() => setPlace((p) => ({ ...p, pinned: !p.pinned }))}
          title={place.pinned ? "Pinned: stays open, here, across reloads" : "Pin it open here"}
          aria-pressed={place.pinned}
        >
          📌
        </button>
        <button className="rounded px-1.5 text-[14px] text-[#7fa6bd] hover:text-white" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div
        ref={body}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 text-[13px] leading-snug"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!shown.length && !heard && !caption && <p className="text-[#7fa6bd]">Nothing said yet. Turn the voice on and talk.</p>}
        {shown.map((e, i) =>
          e.who === "note" ? (
            <p key={i} className="text-[11.5px] italic text-[#7fa6bd]">
              <span className="mr-1.5 tabular-nums opacity-70">{time(e.at)}</span>
              {e.text}
            </p>
          ) : (
            <p key={i}>
              <span className="mr-1.5 text-[10.5px] tabular-nums text-[#4f7286]">{time(e.at)}</span>
              <span className={`mr-1 font-semibold ${e.who === "you" ? "text-cyan-300" : "text-[#ffb547]"}`}>{e.who === "you" ? "You" : "Voice"}</span>
              {e.text}
              {e.cut && <span className="ml-1 text-[11px] text-red-300">— cut off</span>}
            </p>
          ),
        )}
        {heard && (
          <p className="italic text-cyan-200/70">
            <span className="mr-1 font-semibold not-italic text-cyan-300">You</span>
            {heard}…
          </p>
        )}
        {caption && (
          <p className="text-[#ffd79a]/80">
            <span className="mr-1 font-semibold text-[#ffb547]">Voice</span>
            {caption}…
          </p>
        )}
      </div>
    </div>
  );
}
