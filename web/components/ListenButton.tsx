import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { music, type MusicSource } from "../lib/music";

const subscribe = (fn: () => void) => music.subscribe(fn);
const snapshot = () => music.state;

/**
 * Listen: let the sky move with the music you're playing. Spotify's streams
 * can't be read by a page, so this listens to what's actually playing: a tab
 * or the computer's audio, picked in the browser's share dialog, or the
 * microphone. How much it moves is the Music knob in Tune.
 */
export function ListenButton() {
  const s = useSyncExternalStore(subscribe, snapshot);
  const [open, setOpen] = useState(false);
  const dot = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // A dot that beats with the music, so you can see it's hearing something.
  useEffect(() => {
    if (!s.on) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const p = music.read();
      if (dot.current) dot.current.style.transform = `scale(${1 + p.bass * 0.6 + p.beat * 0.8})`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [s.on]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  const pick = (source: MusicSource) => {
    setOpen(false);
    void music.start(source);
  };

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => (s.on ? music.stop() : setOpen((o) => !o))}
        aria-expanded={s.on ? undefined : open}
        aria-pressed={s.on}
        title={s.on ? `Moving with the music from ${s.source === "mic" ? "the microphone" : "the shared audio"}. Click to stop` : "Move the sky with the music you're playing"}
        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 text-[13px] ${s.on ? "bg-course/20 text-text ring-1 ring-course/60" : "glass text-muted hover:text-text"}`}
      >
        {s.on && <span ref={dot} className="h-1.5 w-1.5 rounded-full bg-course transition-transform duration-75" />}
        {s.starting ? "Listening…" : s.on ? "Listening" : "Listen"}
      </button>
      {open && !s.on && (
        <div className="glass rise absolute left-0 top-full z-30 mt-1.5 w-[280px] rounded-lg p-1.5 text-[13px]">
          <button onClick={() => pick("share")} className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-white/10">
            <span className="text-text">A tab or your computer's audio</span>
            <span className="block text-[11.5px] text-muted">Pick the Spotify tab (or your whole screen, for the app) and turn on Share audio</span>
          </button>
          <button onClick={() => pick("mic")} className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-white/10">
            <span className="text-text">The microphone</span>
            <span className="block text-[11.5px] text-muted">Hears whatever's playing in the room</span>
          </button>
          <p className="px-2.5 pb-1 pt-1.5 text-[11.5px] text-muted">The sound stays in this page. How much the sky moves is the Music knob in Tune.</p>
        </div>
      )}
      {s.error && !s.on && !open && (
        <button onClick={() => setOpen(true)} className="glass absolute left-0 top-full z-30 mt-1.5 w-max max-w-[280px] rounded-md px-2.5 py-1 text-left text-[12px] text-bad">
          {s.error}
        </button>
      )}
    </div>
  );
}
