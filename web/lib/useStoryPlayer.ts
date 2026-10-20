import { useCallback, useEffect, useRef, useState } from "react";
import type { Story } from "../../shared/types";
import { beatMs, speechMs } from "./story";

/**
 * Plays a story: one beat at a time, each its own clip. While a beat is being
 * spoken the audio element is the clock — cues land on the word because the
 * word timings are the audio's own. Its pause, and a story without a voice,
 * run on a plain clock instead. Speed scales both, so the narration and the
 * silences between keep their proportions.
 */

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

const audioUrl = (key: string) => `/api/story-audio?key=${key}`;

export function useStoryPlayer(story: Story | null, opts: { speed: number; stopEachBeat: boolean; onEnd?: () => void }) {
  const [pos, setPos] = useState({ beat: 0, ms: 0 });
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);

  const audio = useRef<HTMLAudioElement | null>(null);
  /** Clips loaded ahead, by key, so the next beat starts without a gap. */
  const preload = useRef(new Map<string, HTMLAudioElement>());
  /** Where the plain clock started: the position, and when. */
  const base = useRef({ ms: 0, at: 0 });
  const live = useRef({ beat: 0, ms: 0, playing: false });
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const storyRef = useRef(story);
  storyRef.current = story;
  /** Beats whose clip wouldn't load: they play on the plain clock. */
  const broken = useRef(new Set<string>());

  const beatOf = (i: number) => storyRef.current?.beats[i];
  const voiced = (i: number) => {
    const a = beatOf(i)?.audio;
    return a && !broken.current.has(a.key) ? a : undefined;
  };

  /** Point the audio element at a beat's clip, at `ms` into it. Returns whether that beat is spoken by it. */
  const load = useCallback((i: number, ms: number) => {
    const el = (audio.current ??= new Audio());
    el.playbackRate = optsRef.current.speed;
    const a = voiced(i);
    const b = beatOf(i);
    if (!a || !b || ms >= speechMs(b)) {
      el.pause();
      return false;
    }
    const url = audioUrl(a.key);
    if (!el.src.endsWith(url)) {
      el.src = url;
      el.preload = "auto";
    }
    el.currentTime = ms / 1000;
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Warm the next beat's clip. */
  const warm = (i: number) => {
    const a = voiced(i);
    if (!a || preload.current.has(a.key)) return;
    const el = new Audio(audioUrl(a.key));
    el.preload = "auto";
    preload.current.set(a.key, el);
  };

  const startClock = (ms: number) => {
    base.current = { ms, at: performance.now() };
  };

  /** Start (or keep) playing from where `live` says. */
  const run = useCallback(() => {
    const { beat, ms } = live.current;
    startClock(ms);
    if (load(beat, ms)) {
      audio.current!.play().catch(() => {
        // Blocked or broken: carry on without it rather than stall.
        const k = voiced(beat)?.key;
        if (k) broken.current.add(k);
      });
    }
    warm(beat + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const seek = useCallback(
    (beat: number, ms = 0) => {
      const s = storyRef.current;
      if (!s?.beats.length) return;
      const b = Math.max(0, Math.min(s.beats.length - 1, beat));
      const m = Math.max(0, Math.min(ms, beatMs(s.beats[b])));
      live.current = { ...live.current, beat: b, ms: m };
      setPos({ beat: b, ms: m });
      setEnded(false);
      if (live.current.playing) run();
      else load(b, m);
    },
    [run, load],
  );

  const play = useCallback(() => {
    const s = storyRef.current;
    if (!s?.beats.length || s.state !== "ready") return;
    if (ended) {
      live.current = { beat: 0, ms: 0, playing: true };
      setPos({ beat: 0, ms: 0 });
      setEnded(false);
    } else {
      // Held at the end of a beat (stop after each beat): carry on with the next one.
      const { beat, ms } = live.current;
      if (beat < s.beats.length - 1 && ms >= beatMs(s.beats[beat])) {
        live.current = { beat: beat + 1, ms: 0, playing: true };
        setPos({ beat: beat + 1, ms: 0 });
      }
    }
    live.current.playing = true;
    setPlaying(true);
    run();
  }, [ended, run]);

  const pause = useCallback(() => {
    live.current.playing = false;
    setPlaying(false);
    audio.current?.pause();
  }, []);

  // A new story starts from the top, stopped; the caller decides to play.
  useEffect(() => {
    live.current = { beat: 0, ms: 0, playing: false };
    setPos({ beat: 0, ms: 0 });
    setPlaying(false);
    setEnded(false);
    audio.current?.pause();
    broken.current.clear();
  }, [story?.id]);

  // Stopped being playable (re-voicing): stop rather than play stale audio.
  useEffect(() => {
    if (story && story.state !== "ready" && live.current.playing) pause();
  }, [story?.state, pause]);

  // Speed changes apply mid-beat, without a jump.
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = opts.speed;
    startClock(live.current.ms);
  }, [opts.speed]);

  // The clock: one frame at a time while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = storyRef.current;
      if (!s) return;
      const { beat } = live.current;
      const b = s.beats[beat];
      if (!b) return;
      const el = audio.current;
      const speech = speechMs(b);
      const speaking = !!voiced(beat) && el && !el.paused && !el.ended && live.current.ms < speech;
      let ms: number;
      if (speaking) {
        ms = el!.currentTime * 1000;
        // Keep the plain clock in step, for the hand-over to the pause.
        startClock(ms);
      } else {
        ms = base.current.ms + (performance.now() - base.current.at) * optsRef.current.speed;
        // A clip that ended a little early or late hands over at its true end.
        if (voiced(beat) && el?.ended && ms < speech) {
          ms = speech;
          startClock(ms);
        }
      }
      if (ms >= beatMs(b)) {
        const last = beat >= s.beats.length - 1;
        if (last) {
          live.current = { beat, ms: beatMs(b), playing: false };
          setPos({ beat, ms: beatMs(b) });
          setPlaying(false);
          setEnded(true);
          optsRef.current.onEnd?.();
          return;
        }
        if (optsRef.current.stopEachBeat) {
          // Hold at the end of this beat, so its picture stays up; play moves on.
          live.current = { beat, ms: beatMs(b), playing: false };
          setPos({ beat, ms: beatMs(b) });
          setPlaying(false);
          return;
        }
        live.current = { beat: beat + 1, ms: 0, playing: true };
        setPos({ beat: beat + 1, ms: 0 });
        run();
        return;
      }
      live.current.ms = ms;
      setPos({ beat, ms });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, run, load]);

  // Done with the player: silence.
  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = null;
      preload.current.clear();
    },
    [],
  );

  return { ...pos, playing, ended, play, pause, seek, toggle: () => (live.current.playing ? pause() : play()) };
}
