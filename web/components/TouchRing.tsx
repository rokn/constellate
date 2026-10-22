import { useEffect, useRef, useState } from "react";

/**
 * The ring that opens under a held finger: actions on what it's holding,
 * set around it like the bodies around a beacon. Slide toward one and lift
 * to do it, all in one gesture; or lift in the middle and tap one.
 */

export type RingItem = { label: string; run: () => void };

const RADIUS = 96;
/** How far from the middle the finger must slide before a petal is chosen. */
const DEADZONE = 34;
const EDGE = 16;

export function TouchRing({
  x,
  y,
  pointerId,
  title,
  detail,
  items,
  onClose,
}: {
  x: number;
  y: number;
  pointerId: number;
  title?: string;
  detail?: string;
  items: RingItem[];
  onClose: () => void;
}) {
  // Kept on screen whole: near an edge the ring opens a little further in.
  const cx = Math.min(Math.max(x, RADIUS + 60 + EDGE), window.innerWidth - RADIUS - 60 - EDGE);
  const cy = Math.min(Math.max(y, RADIUS + 30 + EDGE), window.innerHeight - RADIUS - 30 - EDGE);
  const [lit, setLit] = useState<number | null>(null);
  const litRef = useRef<number | null>(null);
  const following = useRef(true);
  const done = useRef(false);
  /** A new touch since the holding finger lifted: only that can tap a petal (the lift's own click can't). */
  const armed = useRef(false);
  /** Run one action, once: the lift that chose it is followed by a click on the same spot. */
  const choose = (i: number) => {
    if (done.current) return;
    done.current = true;
    onClose();
    items[i].run();
  };
  const angleOf = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / items.length;

  useEffect(() => {
    navigator.vibrate?.(12);
    // Measured from where the finger went down: near an edge the ring opens
    // further in, but the slide still starts at the finger.
    const pick = (e: PointerEvent) => {
      const dx = e.clientX - x;
      const dy = e.clientY - y;
      if (Math.hypot(dx, dy) < DEADZONE) return null;
      const a = Math.atan2(dy, dx);
      let best = 0;
      let bestD = Infinity;
      items.forEach((_, i) => {
        const d = Math.abs(Math.atan2(Math.sin(a - angleOf(i)), Math.cos(a - angleOf(i))));
        if (d < bestD) [best, bestD] = [i, d];
      });
      return best;
    };
    const onMove = (e: PointerEvent) => {
      if (!following.current || e.pointerId !== pointerId) return;
      const i = pick(e);
      if (i !== litRef.current) {
        litRef.current = i;
        setLit(i);
        if (i !== null) navigator.vibrate?.(6);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!following.current || e.pointerId !== pointerId) return;
      following.current = false;
      const i = litRef.current;
      if (i !== null) choose(i);
      // Lifted in the middle: the ring stays for a tap.
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey);
    };
    // The ring is made fresh for each hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-40"
      onPointerDownCapture={() => {
        if (!following.current) armed.current = true;
      }}
      onPointerDown={(e) => {
        // A tap outside the ring, once it's waiting for one, closes it.
        if (!following.current && e.target === e.currentTarget) onClose();
      }}
    >
      {title && (
        <div
          className="glass pointer-events-none absolute w-[260px] rounded-xl px-3 py-2 text-center"
          style={{ left: cx - 130, top: cy > window.innerHeight / 2 ? cy - RADIUS - 112 : cy + RADIUS + 34 }}
        >
          <p className="truncate font-cond text-[17px] font-semibold">{title}</p>
          {detail && <p className="mt-0.5 line-clamp-3 text-[12.5px] leading-snug text-muted">{detail}</p>}
        </div>
      )}
      <div className="pointer-events-none absolute h-3 w-3 rounded-full bg-course shadow-[0_0_18px_4px] shadow-course/60" style={{ left: cx - 6, top: cy - 6 }} />
      {items.map((it, i) => {
        const a = angleOf(i);
        return (
          <div key={it.label} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: cx + Math.cos(a) * RADIUS, top: cy + Math.sin(a) * RADIUS }}>
            <button
              onClick={() => armed.current && choose(i)}
              className={`ring-in whitespace-nowrap rounded-full px-3.5 py-2 font-cond text-[15px] font-semibold transition-colors ${lit === i ? "bg-course text-night" : "glass text-text"}`}
              style={{ animationDelay: `${i * 18}ms` }}
            >
              {it.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
