import { useRef, useState } from "react";
import { buzz } from "../lib/haptics";

/**
 * A thin strip along the bottom edge, for the thumb: slide along it to move
 * through history or a story. Each step it passes (a commit, a beat) ticks
 * under the finger, and a tag above it says where you are.
 */
export function EdgeScrub({
  value,
  stepOf,
  labelOf,
  onScrub,
}: {
  /** Where it is now, 0 (left) to 1 (right). */
  value: number;
  /** Which step a position falls in: crossing into another one ticks. */
  stepOf: (f: number) => number;
  labelOf: (f: number) => string;
  onScrub: (f: number) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ f: number; x: number } | null>(null);
  const lastStep = useRef<number | null>(null);

  const at = (clientX: number) => {
    const r = strip.current!.getBoundingClientRect();
    return { f: Math.max(0, Math.min(1, (clientX - r.left) / r.width)), x: clientX };
  };
  const move = (clientX: number) => {
    const p = at(clientX);
    setDrag(p);
    const s = stepOf(p.f);
    if (s !== lastStep.current) {
      if (lastStep.current !== null) buzz(5);
      lastStep.current = s;
    }
    onScrub(p.f);
  };

  const shown = drag?.f ?? value;
  return (
    <div
      ref={strip}
      className="absolute inset-x-0 bottom-0 z-40 h-[calc(22px+env(safe-area-inset-bottom))]"
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        lastStep.current = stepOf(value);
        move(e.clientX);
      }}
      onPointerMove={(e) => drag && move(e.clientX)}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      <div className={`pointer-events-none absolute inset-x-3 bottom-[calc(7px+env(safe-area-inset-bottom))] rounded-full bg-white/10 transition-[height] ${drag ? "h-[5px]" : "h-[3px]"}`}>
        <div className="h-full rounded-full bg-course/70" style={{ width: `${shown * 100}%` }} />
        <div
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-course shadow-[0_0_12px_2px] shadow-course/50 transition-[width,height] ${drag ? "h-4 w-4" : "h-2 w-2"}`}
          style={{ left: `${shown * 100}%` }}
        />
      </div>
      {drag && (
        <div
          className="glass pointer-events-none absolute bottom-[calc(30px+env(safe-area-inset-bottom))] max-w-[min(420px,80vw)] -translate-x-1/2 truncate rounded-lg px-2.5 py-1 text-[13px]"
          style={{ left: Math.max(120, Math.min(window.innerWidth - 120, drag.x)) }}
        >
          {labelOf(drag.f)}
        </div>
      )}
    </div>
  );
}
