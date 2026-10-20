import { useEffect, useState } from "react";
import type { Activity, LogicalModule, Overview, RepoGraph, SessionState, Topic } from "../../shared/types";
import type { Turn, VoiceState } from "../lib/useVoice";

/* -------------------------------- landing -------------------------------- */

const RECENT = "codeflight.recent";

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function rememberRepo(root: string) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([root, ...loadRecent().filter((r) => r !== root)].slice(0, 6)));
  } catch {
    /* private mode */
  }
}

export function Landing({ onOpen, error }: { onOpen: (path: string) => void; error?: string }) {
  const [path, setPath] = useState("");
  const recent = loadRecent();
  return (
    <div className="absolute inset-0 flex items-center justify-center px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) onOpen(path.trim());
        }}
        className="rise w-full max-w-[560px]"
      >
        <h1 className="font-cond text-[64px] font-semibold leading-none tracking-tight">Codeflight</h1>
        <p className="mt-3 max-w-[46ch] text-[16px] leading-relaxed text-muted">
          Open a repository on this machine. It becomes a map you fly through, with a navigator who reads the code and
          shows you how it works.
        </p>
        <div className="glass mt-7 flex items-center gap-2 rounded-xl px-3 py-2">
          <input
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="~/code/my-project"
            className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[14px] focus:outline-none"
            aria-label="Path to a local repository"
          />
          <button className="rounded-lg bg-course px-4 py-1.5 font-cond text-[16px] font-semibold text-night hover:brightness-110">
            Take off
          </button>
        </div>
        {error && <p className="mt-3 text-[13.5px] text-bad">{error}</p>}
        {recent.length > 0 && (
          <div className="mt-6">
            <p className="text-[13px] text-muted">Recent</p>
            <ul className="mt-1.5 space-y-1">
              {recent.map((r) => (
                <li key={r}>
                  <button type="button" onClick={() => onOpen(r)} className="font-mono text-[13px] text-text/85 hover:text-course">
                    {r}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </div>
  );
}

/* --------------------------------- intro --------------------------------- */

/**
 * The opening: while the scan runs, the repo's name; while the navigator
 * charts the map, what it is reading (the bodies light up in the space behind);
 * when it lands, the headline and a choice of how to start.
 */
export function Intro({
  state,
  graph,
  onTour,
  onExplore,
}: {
  state: SessionState;
  graph: RepoGraph | null;
  onTour: () => void;
  onExplore: () => void;
}) {
  const o = state.overview;
  const reading = [...state.activity].reverse().find((a) => a.kind === "read" || a.kind === "search" || a.kind === "tool");
  const langs = graph
    ? Object.entries(graph.languages).sort((a, b) => b[1] - a[1]).slice(0, 4)
    : [];
  const total = langs.reduce((s, [, n]) => s + n, 0) || 1;

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center px-6 sm:px-14">
      {/* A scrim, so the type reads against the brightest part of the map. */}
      <div className="absolute inset-y-0 left-0 w-[min(860px,100%)] bg-gradient-to-r from-night via-night/80 to-transparent" aria-hidden />
      <div className="relative max-w-[640px]">
        <p className="rise font-mono text-[12.5px] text-muted">{state.repo?.root}</p>
        <h1 className="rise mt-1 font-cond text-[clamp(56px,9vw,112px)] font-semibold leading-[0.9] tracking-tight" style={{ animationDelay: "80ms" }}>
          {state.repo?.name}
        </h1>

        {graph && (
          <div className="rise mt-5 max-w-[420px]" style={{ animationDelay: "200ms" }}>
            <p className="text-[15px] text-text/90">
              {graph.totals.files.toLocaleString("en-US")} files, {graph.totals.loc.toLocaleString("en-US")} lines, {graph.imports.length.toLocaleString("en-US")} imports
              {graph.branch ? ` on ${graph.branch}` : ""}
            </p>
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line">
              {langs.map(([l, n], i) => (
                <span key={l} style={{ width: `${(n / total) * 100}%`, opacity: 1 - i * 0.2 }} className="bg-static" />
              ))}
            </div>
            <p className="mt-1.5 text-[12.5px] text-muted">{langs.map(([l]) => l).join(", ")}</p>
          </div>
        )}

        {!o && (
          <p className="mt-8 text-[15px] text-muted" aria-live="polite">
            {state.status === "scanning" ? "Mapping files and imports…" : (
              <>
                <span className="text-course">The navigator is charting the map.</span>{" "}
                {reading?.detail}
              </>
            )}
          </p>
        )}

        {o && (
          <div className="pointer-events-auto rise mt-8">
            <p className="font-cond text-[26px] font-medium leading-snug text-text">{o.headline}</p>
            {o.welcome && <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-muted">{o.welcome}</p>}
            <div className="mt-6 flex flex-wrap gap-3">
              <button onClick={onTour} className="rounded-lg bg-course px-4 py-2 font-cond text-[17px] font-semibold text-night hover:brightness-110">
                Take the tour
              </button>
              <button onClick={onExplore} className="glass rounded-lg px-4 py-2 font-cond text-[17px] font-medium hover:border-muted">
                Explore on my own
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- tour ---------------------------------- */

export function TourCaption({
  module,
  index,
  total,
  onNext,
  onStop,
}: {
  module: LogicalModule;
  index: number;
  total: number;
  onNext: () => void;
  onStop: () => void;
}) {
  return (
    <div key={module.id} className="glass rise pointer-events-auto w-full max-w-[460px] rounded-xl px-5 py-4">
      <div className="flex items-baseline gap-3">
        <span className="font-cond text-[14px] tabular-nums text-runtime">
          {index + 1}/{total}
        </span>
        <h2 className="font-cond text-[26px] font-semibold leading-tight">{module.label}</h2>
      </div>
      <p className="mt-1.5 text-[14.5px] leading-relaxed text-text/85">{module.summary}</p>
      <p className="mt-1 text-[12.5px] text-muted">{module.paths.length} files</p>
      <div className="mt-3 flex gap-2">
        <button onClick={onNext} className="rounded-md bg-white/5 px-3 py-1 text-[13px] hover:bg-white/10">
          {index + 1 < total ? "Next" : "Finish"}
        </button>
        <button onClick={onStop} className="rounded-md px-3 py-1 text-[13px] text-muted hover:text-text">
          End tour
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ destinations ----------------------------- */

export function Destinations({ topics, onPick }: { topics: Topic[]; onPick: (t: Topic) => void }) {
  return (
    <div
      className="pointer-events-auto flex w-full max-w-[980px] gap-2 overflow-x-auto pb-1"
      style={{ maskImage: "linear-gradient(90deg, #000 92%, transparent)" }}
    >
      {topics.map((t, i) => (
        <button
          key={t.id}
          onClick={() => onPick(t)}
          className="glass rise group w-[230px] shrink-0 rounded-lg px-3.5 py-2.5 text-left hover:border-course/60"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <p className="font-cond text-[17px] font-semibold leading-tight group-hover:text-course">{t.title}</p>
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted">{t.hook}</p>
        </button>
      ))}
    </div>
  );
}

/* -------------------------------- activity ------------------------------- */

/** The last few things the navigator did, fading with age. */
export function ActivityTicker({ activity, busy }: { activity: Activity[]; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const recent = activity.filter((a) => now - a.at < (busy ? 30_000 : 6_000)).slice(-4);
  if (!recent.length) return null;
  return (
    <ul className="space-y-0.5" aria-live="polite">
      {recent.map((a, i) => (
        <li
          key={a.at + a.detail}
          className={`truncate font-mono text-[11.5px] ${a.kind === "error" ? "text-bad" : i === recent.length - 1 ? "text-text/90" : "text-muted/70"}`}
        >
          <span className={a.kind === "read" ? "text-course" : a.kind === "search" ? "text-static" : "text-runtime"}>▸</span> {a.detail}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------- voice --------------------------------- */

const VOICE_COPY: Record<VoiceState, string> = {
  idle: "Talk to the navigator",
  connecting: "Connecting",
  listening: "Listening",
  speaking: "Speaking",
  error: "Voice unavailable",
};

export function VoiceDock({
  available,
  state,
  error,
  caption,
  heard,
  turns,
  onStart,
  onStop,
}: {
  available: boolean;
  state: VoiceState;
  error: string | null;
  caption: string;
  heard: string;
  turns: Turn[];
  onStart: () => void;
  onStop: () => void;
}) {
  const live = state !== "idle" && state !== "error";
  const last = caption || heard || (live ? turns.at(-1)?.text : "");
  return (
    <div className="pointer-events-auto flex max-w-[360px] flex-col items-end gap-2">
      {last && (
        <p className={`glass rise rounded-lg px-3 py-2 text-[13.5px] leading-snug ${heard && !caption ? "italic text-muted" : "text-text"}`}>
          {last}
        </p>
      )}
      {error && <p className="text-right text-[12.5px] text-bad">{error}</p>}
      <button
        onClick={live ? onStop : onStart}
        disabled={!available}
        title={available ? (live ? "Hang up (v)" : "Talk (v)") : "Set INWORLD_API_KEY on the server to enable voice"}
        className="glass flex items-center gap-2.5 rounded-full py-1.5 pl-2 pr-4 disabled:opacity-40"
        aria-pressed={live}
      >
        <span className="relative flex h-6 w-6 items-center justify-center">
          <span
            className={`absolute inset-0 rounded-full ${state === "speaking" ? "animate-ping bg-course/40" : ""}`}
            aria-hidden
          />
          <span
            className={`h-3 w-3 rounded-full transition-all ${
              state === "speaking" ? "scale-125 bg-course" : state === "listening" ? "bg-course/70" : state === "error" ? "bg-bad" : "bg-muted/50"
            }`}
          />
        </span>
        <span className="font-cond text-[15px] font-medium">{available ? VOICE_COPY[state] : "Voice off"}</span>
      </button>
    </div>
  );
}

export type { Overview };
