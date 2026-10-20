import { useEffect, useState } from "react";
import type { Story, StorySettings } from "../../shared/types";
import { post } from "../lib/api";
import { clock, storyMs } from "../lib/story";

type VoiceOption = { id: string; name: string; description: string };

/**
 * Your stories: the repo's intro three, the ones you asked for, a box to ask
 * for another, and how they're told — the voice, its pace, and a line on
 * style that the writer follows.
 */
export function StoriesPanel({
  stories,
  settings,
  charted,
  onPlay,
  onPlayIntro,
  onClose,
}: {
  stories: Story[];
  settings: StorySettings;
  charted: boolean;
  onPlay: (id: string) => void;
  onPlayIntro: () => void;
  onClose: () => void;
}) {
  const [request, setRequest] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const intro = stories.filter((s) => s.intro).sort((a, b) => a.intro! - b.intro!);
  const mine = stories.filter((s) => !s.intro).sort((a, b) => b.createdAt - a.createdAt);

  const write = () => {
    if (!request.trim()) return;
    void post("/api/stories", { action: "create", request: request.trim() });
    setRequest("");
  };

  return (
    <div className="glass rise pointer-events-auto flex max-h-[calc(100vh-240px)] w-[min(420px,calc(100vw-2rem))] flex-col rounded-xl">
      <div className="flex items-center justify-between px-3.5 pt-3">
        <h2 className="font-cond text-[18px] font-semibold">Stories</h2>
        <div className="flex gap-1">
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            className={`rounded px-2 py-0.5 text-[13px] hover:bg-white/5 ${settingsOpen ? "text-text" : "text-muted hover:text-text"}`}
          >
            Voice & style
          </button>
          <button onClick={onClose} className="rounded px-2 py-0.5 text-[13px] text-muted hover:bg-white/5 hover:text-text">
            Close
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 pb-3.5 pt-2">
        {settingsOpen && <Settings settings={settings} />}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            write();
          }}
          className="flex gap-1.5"
        >
          <input
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="Tell me the story of… (how a request is served)"
            className="min-w-0 flex-1 rounded-md border border-line bg-panelsolid/60 px-2.5 py-1.5 text-[13.5px] focus:border-course/60 focus:outline-none"
            aria-label="What the story should explain"
          />
          <button disabled={!request.trim() || !charted} className="rounded-md bg-course px-3 py-1 font-cond text-[15px] font-semibold text-night hover:brightness-110 disabled:opacity-40">
            Write
          </button>
        </form>

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="font-cond text-[14px] font-semibold uppercase tracking-wider text-muted">Intro</h3>
            {intro.some((s) => s.state === "ready") && (
              <button onClick={onPlayIntro} className="text-[12.5px] text-course hover:underline">
                Play all three
              </button>
            )}
          </div>
          {intro.length ? (
            <ul className="mt-1 space-y-1">
              {intro.map((s) => (
                <Row key={s.id} story={s} onPlay={() => onPlay(s.id)} />
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[13px] text-muted">
              Three short narrated stories on the most interesting parts of this codebase.{" "}
              <button
                disabled={!charted}
                onClick={() => void post("/api/stories", { action: "intro" })}
                className="text-course hover:underline disabled:opacity-40"
              >
                Write them
              </button>
            </p>
          )}
        </section>

        {mine.length > 0 && (
          <section>
            <h3 className="font-cond text-[14px] font-semibold uppercase tracking-wider text-muted">Yours</h3>
            <ul className="mt-1 space-y-1">
              {mine.map((s) => (
                <Row key={s.id} story={s} onPlay={() => onPlay(s.id)} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ story, onPlay }: { story: Story; onPlay: () => void }) {
  const ready = story.state === "ready";
  return (
    <li className="group flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-white/[0.03]">
      <button
        onClick={onPlay}
        disabled={story.state === "error"}
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line text-[10px] text-course hover:border-course/70 disabled:opacity-30"
        aria-label={`Play ${story.title}`}
      >
        ▶
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium leading-tight">{story.title}</p>
        <p className="truncate text-[12.5px] text-muted">
          {story.state === "writing" ? (
            <span className="text-course/90">{story.progress ?? "Writing…"}</span>
          ) : story.state === "voicing" ? (
            <span className="text-course/90">Voicing…</span>
          ) : story.state === "error" ? (
            <span className="text-bad">{story.error}</span>
          ) : (
            <>
              {clock(storyMs(story))}
              {story.silent ? " · no voice" : ""} · {story.summary}
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {(story.state === "error" || (ready && story.silent)) && (
          <button onClick={() => void post("/api/stories", { action: "retry", id: story.id })} className="rounded px-1.5 text-[12px] text-muted hover:text-text">
            Retry
          </button>
        )}
        <button onClick={() => void post("/api/stories", { action: "delete", id: story.id })} className="rounded px-1.5 text-[12px] text-muted hover:text-bad" aria-label={`Delete ${story.title}`}>
          Delete
        </button>
      </div>
    </li>
  );
}

function Settings({ settings }: { settings: StorySettings }) {
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [style, setStyle] = useState(settings.style);
  useEffect(() => setStyle(settings.style), [settings.style]);
  useEffect(() => {
    void fetch("/api/story-voices")
      .then((r) => r.json())
      .then((b: { available: boolean; voices: VoiceOption[] }) => {
        setAvailable(b.available);
        setVoices(b.voices);
      })
      .catch(() => setVoices([]));
  }, []);
  const save = (patch: Partial<StorySettings>) => void post("/api/story-settings", { settings: patch });
  const current = voices?.find((v) => v.id === settings.voiceId);

  return (
    <div className="space-y-2.5 rounded-lg border border-line bg-panelsolid/50 p-3">
      {!available && <p className="text-[12.5px] text-muted">Set INWORLD_API_KEY on the server to voice stories. Without it they play silently, with captions.</p>}
      <label className="block">
        <span className="text-[12.5px] text-muted">Voice</span>
        <select
          value={settings.voiceId}
          onChange={(e) => save({ voiceId: e.target.value })}
          disabled={!available || !voices?.length}
          className="mt-0.5 w-full rounded-md border border-line bg-panelsolid px-2 py-1 text-[13.5px] focus:border-course/60 focus:outline-none"
        >
          {!voices?.some((v) => v.id === settings.voiceId) && <option value={settings.voiceId}>{settings.voiceId}</option>}
          {voices?.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        {current?.description && <span className="mt-0.5 block text-[12px] text-muted/80">{current.description}</span>}
      </label>
      <label className="block">
        <span className="flex justify-between text-[12.5px] text-muted">
          <span>Voice pace</span>
          <span className="font-mono tabular-nums">{settings.rate.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0.7}
          max={1.3}
          step={0.05}
          value={settings.rate}
          disabled={!available}
          onChange={(e) => save({ rate: Number(e.target.value) })}
          className="w-full accent-[var(--course)]"
        />
        <span className="block text-[12px] text-muted/80">How the voice is synthesized. Playback speed is in the player.</span>
      </label>
      <label className="block">
        <span className="text-[12.5px] text-muted">Style</span>
        <textarea
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          onBlur={() => style !== settings.style && save({ style })}
          rows={2}
          placeholder="e.g. dry and precise, like a staff engineer at a whiteboard"
          className="mt-0.5 w-full resize-none rounded-md border border-line bg-panelsolid px-2 py-1 text-[13px] focus:border-course/60 focus:outline-none"
        />
        <span className="block text-[12px] text-muted/80">Applies to stories written from now on. A new voice re-voices a story the next time it plays.</span>
      </label>
    </div>
  );
}
