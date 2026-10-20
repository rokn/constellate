import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Story, View } from "../../shared/types";
import { absMs, beatMs, clock, fromAbs, liveDiagrams, speechMs, stageAt, storyMs, wordAt } from "../lib/story";
import { SPEEDS, useStoryPlayer } from "../lib/useStoryPlayer";
import { CodeBlock } from "./CodeBlock";
import { CustomView } from "./CustomView";
import { DiagramView } from "./DiagramView";
import { DiffStat, DiffView, parseDiff } from "./DiffView";

const SPEED_KEY = "codeflight.storySpeed";
const STOP_KEY = "codeflight.storyStopEachBeat";

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

/**
 * A story playing: the stage on the right shows the visual being talked
 * about, built up cue by cue; the map behind flies where the story goes; the
 * transport at the bottom carries the caption, the word being said, and every
 * control — play, beats, scrubbing, speed, stopping after each beat.
 *
 * Keys while it's open: Space play/pause, ← → previous/next beat, Shift+← →
 * five seconds, - and = slower/faster, Esc closes.
 */
export function StoryPlayer({
  story,
  queue,
  autoplay,
  onFocus,
  onOpenFile,
  onPick,
  onDiff,
  onClose,
}: {
  story: Story;
  /** The playlist this story is part of (the intro's three), if any. */
  queue: Story[];
  autoplay: boolean;
  onFocus: (paths: string[], label?: string) => void;
  onOpenFile: (path: string, line?: number, endLine?: number) => void;
  /** Another story in the queue. */
  onPick: (id: string, autoplay: boolean) => void;
  /** A branch story: open the branch's whole diff. */
  onDiff?: () => void;
  onClose: () => void;
}) {
  const [speed, setSpeedState] = useState(() => stored(SPEED_KEY, 1));
  const [stopEachBeat, setStopState] = useState(() => stored(STOP_KEY, false));
  const setSpeed = (s: number) => (setSpeedState(s), store(SPEED_KEY, s));
  const setStop = (v: boolean) => (setStopState(v), store(STOP_KEY, v));
  const [showContext, setShowContext] = useState(false);
  // The stage's height, so a diagram is fitted to it whole rather than scrolled.
  const stageBody = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(480);
  useEffect(() => {
    const el = stageBody.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const at = queue.findIndex((s) => s.id === story.id);
  const next = at >= 0 ? queue[at + 1] : undefined;
  const player = useStoryPlayer(story, {
    speed,
    stopEachBeat,
    // A playlist carries on into its next story.
    onEnd: () => next && onPick(next.id, true),
  });

  // Start once it's ready (it may still be voicing when opened).
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!autoplay || story.state !== "ready" || started.current === story.id) return;
    started.current = story.id;
    player.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.id, story.state, autoplay]);

  const beat = story.beats[player.beat];
  const stage = useMemo(() => stageAt(story, player.beat, player.ms), [story, player.beat, player.ms]);
  const live = useMemo(() => liveDiagrams(story), [story]);
  const visual = story.visuals.find((v) => v.id === stage.visual);

  // The map follows the story. Keys change only when a new move fires, so
  // pausing or scrubbing within a beat doesn't fly the camera again.
  const focusRef = useRef(onFocus);
  focusRef.current = onFocus;
  const openRef = useRef(onOpenFile);
  openRef.current = onOpenFile;
  useEffect(() => {
    if (stage.focus) focusRef.current(stage.focus.paths, stage.focus.label);
  }, [stage.focus?.key]);
  useEffect(() => {
    if (stage.open) openRef.current(stage.open.path, stage.open.line, stage.open.endLine);
  }, [stage.open?.key]);

  const total = storyMs(story);
  const now = absMs(story, player.beat, player.ms);
  const step = (dir: 1 | -1) => {
    // Back from the middle of a beat goes to its start first, like a track.
    if (dir < 0 && player.ms > 1500) return player.seek(player.beat, 0);
    player.seek(player.beat + dir, 0);
  };
  const nudgeSpeed = (dir: 1 | -1) => {
    const i = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 1 : i) + dir))]);
  };

  const keys = useRef<{ toggle: () => void; step: (d: 1 | -1) => void; seekAbs: (d: number) => void; nudgeSpeed: (d: 1 | -1) => void; onClose: () => void } | null>(null);
  keys.current = {
    toggle: player.toggle,
    step,
    seekAbs: (d: number) => {
      const p = fromAbs(story, now + d);
      player.seek(p.beat, p.ms);
    },
    nudgeSpeed,
    onClose,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Text fields keep their keys (and the speed menu its arrows); a checkbox or button doesn't.
      const t = e.target;
      const typing = t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && !["checkbox", "radio", "range", "button"].includes(t.type));
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = keys.current;
      if (!k) return;
      // Something modal is over the story (the full diff): its keys are its own.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const handled = (() => {
        if (e.key === " " || e.code === "Space") return k.toggle(), true;
        if (e.key === "ArrowRight") return e.shiftKey ? k.seekAbs(5000) : k.step(1), true;
        if (e.key === "ArrowLeft") return e.shiftKey ? k.seekAbs(-5000) : k.step(-1), true;
        if (e.key === "-" || e.key === "_") return k.nudgeSpeed(-1), true;
        if (e.key === "=" || e.key === "+") return k.nudgeSpeed(1), true;
        if (e.key === "Escape") return k.onClose(), true;
        return false;
      })();
      if (!handled) return;
      // Captured first, so the map's own keys (Space recenters, Esc closes panels) don't also fire.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.target instanceof HTMLElement) e.target.blur();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const notReady = story.state !== "ready";
  const pausing = !!beat && player.ms > speechMs(beat) && player.playing;

  return (
    <>
      {/* The stage */}
      <div className="pointer-events-none absolute bottom-[264px] right-4 top-4 z-20 w-[min(680px,calc(100%-2rem))]">
        <aside className="glass rise pointer-events-auto flex h-full flex-col overflow-hidden rounded-xl shadow-[0_20px_60px_-20px_rgba(0,0,0,.7)]">
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            <span className="rounded border border-course/50 px-1.5 font-cond text-[11.5px] font-medium tracking-wide text-course">
              {story.intro ? `Intro ${story.intro}/${queue.length || 3}` : story.branch ? `${story.branch.name} vs ${story.branch.base}` : "Story"}
            </span>
            <h2 className="min-w-0 flex-1 truncate font-cond text-[19px] font-semibold tracking-wide">{story.title}</h2>
            {story.context.length > 0 && (
              <button
                onClick={() => setShowContext((s) => !s)}
                aria-expanded={showContext}
                className={`rounded px-2 py-0.5 text-[13px] hover:bg-white/5 ${showContext ? "text-text" : "text-muted hover:text-text"}`}
                title="The parts of the code this story is about"
              >
                Code in this story ({story.context.length})
              </button>
            )}
            {onDiff && (
              <button
                onClick={() => {
                  player.pause();
                  onDiff();
                }}
                className="rounded px-2 py-0.5 text-[13px] text-muted hover:bg-white/5 hover:text-text"
                title={`Every change against ${story.branch?.base}`}
              >
                Full diff
              </button>
            )}
            <button onClick={onClose} className="rounded px-2 py-0.5 text-[13px] text-muted hover:bg-white/5 hover:text-text" aria-label="Close story">
              Close
            </button>
          </header>
          {story.summary && <p className="border-b border-line/60 px-4 py-2 text-[13px] text-muted">{story.summary}</p>}

          {showContext && (
            <ul className="max-h-[40%] space-y-0.5 overflow-y-auto border-b border-line/60 px-2 py-2">
              {story.context.map((c, i) => (
                <li key={i}>
                  <button
                    onClick={() => onOpenFile(c.path, c.line, c.endLine)}
                    className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-white/5"
                  >
                    <span className="shrink-0 font-mono text-[12px] text-text/90">
                      {c.path}
                      {c.line ? `:${c.line}${c.endLine ? `–${c.endLine}` : ""}` : ""}
                    </span>
                    <span className="min-w-0 truncate text-[12.5px] text-muted">{c.why}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div ref={stageBody} className="min-h-0 flex-1 overflow-y-auto p-4">
            {notReady ? (
              <Preparing story={story} />
            ) : visual ? (
              <StageView
                key={visual.id}
                view={visual}
                lines={stage.lines}
                emphasis={stage.emphasis}
                shown={live.has(visual.id) ? (stage.revealed[visual.id] ?? []) : undefined}
                step={stage.steps[visual.id] ?? 0}
                room={room}
                onOpenFile={onOpenFile}
              />
            ) : (
              <p className="text-[14px] text-muted">The map is the picture for this part.</p>
            )}
          </div>
        </aside>
      </div>

      {/* The transport */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[84px] z-30 flex justify-center px-4">
        <div className="glass rise pointer-events-auto w-full max-w-[860px] rounded-xl px-4 pb-3 pt-3">
          <Caption story={story} beatIndex={player.beat} ms={player.ms} pausing={pausing} />

          <Scrubber story={story} now={now} total={total} onSeek={(abs) => {
            const p = fromAbs(story, abs);
            player.seek(p.beat, p.ms);
          }} />

          <div className="mt-2 flex items-center gap-1.5 text-[13px]">
            <IconBtn onClick={() => step(-1)} label="Previous beat (←)" disabled={notReady}>
              ⏮
            </IconBtn>
            <button
              onClick={player.toggle}
              disabled={notReady}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-course text-night hover:brightness-110 disabled:opacity-40"
              aria-label={player.playing ? "Pause (Space)" : "Play (Space)"}
              title={player.playing ? "Pause (Space)" : "Play (Space)"}
            >
              {player.playing ? "❚❚" : player.ended ? "↺" : "▶"}
            </button>
            <IconBtn onClick={() => step(1)} label="Next beat (→)" disabled={notReady}>
              ⏭
            </IconBtn>
            <span className="ml-1 font-mono text-[11.5px] tabular-nums text-muted">
              {clock(now)} / {clock(total)}
            </span>
            <span className="ml-1 font-mono text-[11.5px] tabular-nums text-muted/70">
              beat {Math.min(player.beat + 1, story.beats.length)}/{story.beats.length}
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <label className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-0.5 text-muted hover:text-text" title="Pause at the end of each beat; Space carries on">
                <input type="checkbox" checked={stopEachBeat} onChange={(e) => setStop(e.target.checked)} className="accent-[var(--course)]" />
                Stop after each beat
              </label>
              <div className="flex items-center rounded-md border border-line" role="group" aria-label="Speed">
                <IconBtn onClick={() => nudgeSpeed(-1)} label="Slower (-)">
                  −
                </IconBtn>
                <select
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  className="bg-transparent px-0.5 font-mono text-[12px] tabular-nums focus:outline-none"
                  aria-label="Playback speed"
                >
                  {SPEEDS.map((s) => (
                    <option key={s} value={s} className="bg-panelsolid">
                      {s}×
                    </option>
                  ))}
                </select>
                <IconBtn onClick={() => nudgeSpeed(1)} label="Faster (=)">
                  +
                </IconBtn>
              </div>
              {next && (
                <button onClick={() => onPick(next.id, true)} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text" title={next.title}>
                  Next story ›
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function IconBtn({ onClick, label, disabled, children }: { onClick: () => void; label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} title={label} className="rounded px-2 py-0.5 text-muted hover:bg-white/5 hover:text-text disabled:opacity-30">
      {children}
    </button>
  );
}

/** What's still happening before it can play. */
function Preparing({ story }: { story: Story }) {
  if (story.state === "error") return <p className="text-[14px] text-bad">{story.error ?? "The story couldn't be written."}</p>;
  return (
    <div className="space-y-2">
      <div className="working-bar h-px bg-line" />
      <p className="text-[14px] text-muted">
        {story.state === "writing" ? "The navigator is reading the code and writing the script…" : "Voicing the narration…"}
      </p>
      {story.progress && <p className="font-mono text-[12px] text-muted/80">{story.progress}</p>}
    </div>
  );
}

/** The beat's narration, with the word being said lit. */
function Caption({ story, beatIndex, ms, pausing }: { story: Story; beatIndex: number; ms: number; pausing: boolean }) {
  const beat = story.beats[beatIndex];
  if (!beat) return <p className="min-h-[3.2em] text-[15px] text-muted">{story.progress ?? "…"}</p>;
  const w = wordAt(beat, ms);
  const split = w ? w.i : ms >= speechMs(beat) ? beat.say.length : 0;
  return (
    <p className="min-h-[3.2em] text-[16px] leading-relaxed" aria-live="off">
      <span className="text-text">{beat.say.slice(0, split)}</span>
      {w && <span className="rounded-sm bg-course/20 text-course">{beat.say.slice(w.i, w.i + w.n)}</span>}
      <span className="text-muted/70">{beat.say.slice(w ? w.i + w.n : split)}</span>
      {pausing && <span className="ml-2 align-middle font-mono text-[11px] text-muted">‖</span>}
    </p>
  );
}

/** The whole story as one bar, cut into beats; click or drag anywhere to go there. */
function Scrubber({ story, now, total, onSeek }: { story: Story; now: number; total: number; onSeek: (abs: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const toMs = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total;
  };
  let acc = 0;
  const segs = story.beats.map((b) => {
    const start = acc;
    acc += beatMs(b);
    return { b, start, len: beatMs(b) };
  });
  const hovered = hover !== null ? segs.find((s) => hover >= s.start && hover < s.start + s.len) : undefined;
  return (
    <div className="relative mt-2">
      {hovered && hover !== null && (
        <p
          className="pointer-events-none absolute bottom-4 z-10 max-w-[320px] -translate-x-1/2 truncate rounded border border-line bg-panelsolid px-2 py-1 text-[12px] text-text/90"
          style={{ left: `${(hover / total) * 100}%` }}
        >
          {clock(hover)} · {hovered.b.say}
        </p>
      )}
      <div
        ref={bar}
        className="flex h-2.5 cursor-pointer gap-[3px]"
        role="slider"
        aria-label="Story position"
        aria-valuemin={0}
        aria-valuemax={Math.round(total / 1000)}
        aria-valuenow={Math.round(now / 1000)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(toMs(e.clientX));
        }}
        onPointerMove={(e) => {
          setHover(toMs(e.clientX));
          if (e.buttons & 1) onSeek(toMs(e.clientX));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {segs.map(({ b, start, len }) => {
          const fill = Math.max(0, Math.min(1, (now - start) / len));
          const speech = speechMs(b) / len;
          return (
            <div key={b.id} className="relative h-full overflow-hidden rounded-full bg-line" style={{ flex: len }}>
              {/* The beat's pause, a shade apart, so you can see where it stops to let you look. */}
              {b.pauseMs > 0 && <div className="absolute inset-y-0 right-0 bg-white/[0.04]" style={{ width: `${(1 - speech) * 100}%` }} />}
              <div className="absolute inset-y-0 left-0 bg-course/80" style={{ width: `${fill * 100}%` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One visual on the stage, in the state the story has brought it to. */
function StageView({
  view,
  lines,
  emphasis,
  shown,
  step,
  room,
  onOpenFile,
}: {
  view: View;
  lines: number[];
  emphasis: string[];
  shown?: string[];
  step: number;
  /** The stage's inner height. */
  room: number;
  onOpenFile: (path: string, line?: number, endLine?: number) => void;
}) {
  const title = view.kind === "code" || view.kind === "diff" ? view.title ?? view.path : view.title;
  return (
    <section className="rise overflow-hidden rounded-lg border border-line bg-panelsolid/70">
      {title && (
        <div className="flex items-center gap-2 border-b border-line/70 px-3 py-2">
          <h3 className="min-w-0 flex-1 truncate text-[14px] font-medium">{title}</h3>
          {view.kind === "code" && (
            <button
              onClick={() => onOpenFile(view.path, view.startLine, view.startLine + view.code.split("\n").length - 1)}
              className="shrink-0 rounded px-1.5 text-[12px] text-muted hover:bg-white/5 hover:text-course"
            >
              Open file
            </button>
          )}
        </div>
      )}
      {view.kind === "code" && (
        <>
          {view.note && <p className="px-3 pt-2 text-[13px] text-muted">{view.note}</p>}
          <div className="px-3 pt-1 font-mono text-[12px] text-muted/80">
            {view.path}:{view.startLine}
          </div>
          <CodeBlock code={view.code} lang={view.lang} startLine={view.startLine} pointed={lines} maxHeight={`${Math.max(160, room - 32 - 40 - 64)}px`} />
        </>
      )}
      {view.kind === "diagram" && (
        <div className="p-3">
          <DiagramView
            // The stage is taller than it is wide: anything but a short chain reads better top-down.
            spec={view.nodes.length > 3 ? { ...view, dir: "TD" } : view}
            tone={view.layer === "logical" ? "var(--runtime)" : "var(--static)"}
            emphasis={emphasis}
            shown={shown}
            grow
            // Less the stage's padding, the card's title bar and its own padding.
            maxHeight={Math.max(200, room - 32 - 40 - 24)}
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
          <DiffView diff={view.diff} lang={view.lang} maxHeight={`${Math.max(160, room - 32 - 40 - 64)}px`} />
        </>
      )}
      {view.kind === "custom" && <CustomView html={view.html} height={view.height} step={step} onOpen={(p, l) => onOpenFile(p, l)} />}
      {view.kind === "text" && (
        <div className="prose-nav px-3 py-2.5">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.markdown}</ReactMarkdown>
        </div>
      )}
    </section>
  );
}
