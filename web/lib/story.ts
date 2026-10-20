import type { Story, StoryBeat } from "../../shared/types";

/**
 * A story's timeline, as pure functions of (beat, ms into the beat). The
 * player never applies cues one by one as they pass; it asks what the stage
 * looks like at the current moment, so seeking anywhere — back, forward, into
 * the middle of a beat — lands on exactly what playing up to there would show.
 */

/** Roughly how long a line takes to say, when a story has no voice (matches the server's). */
export function estimateMs(say: string) {
  return Math.max(1200, Math.round((say.split(/\s+/).filter(Boolean).length / 2.6) * 1000));
}

export const speechMs = (b: StoryBeat) => b.audio?.ms ?? estimateMs(b.say);
export const beatMs = (b: StoryBeat) => speechMs(b) + b.pauseMs;
export const storyMs = (s: Story) => s.beats.reduce((t, b) => t + beatMs(b), 0);

/** When, in ms into its beat, the narration reaches character `at`. */
export function cueMs(b: StoryBeat, at: number): number {
  if (at <= 0) return 0;
  const words = b.audio?.words;
  if (words?.length) {
    const w = words.find((x) => x.i + x.n > at);
    return w ? w.s : speechMs(b);
  }
  return (at / Math.max(1, b.say.length)) * speechMs(b);
}

/** The word being said at `ms`, as a character range of the beat's text. */
export function wordAt(b: StoryBeat, ms: number): { i: number; n: number } | null {
  const words = b.audio?.words;
  if (words?.length) {
    let hit = null;
    for (const w of words) {
      if (w.s > ms) break;
      hit = w;
    }
    return hit && ms <= speechMs(b) ? { i: hit.i, n: hit.n } : null;
  }
  // No timings: estimate by position in the text.
  if (ms > speechMs(b)) return null;
  const at = Math.floor((ms / speechMs(b)) * b.say.length);
  const start = b.say.lastIndexOf(" ", at) + 1;
  const end = b.say.indexOf(" ", at);
  return { i: start, n: (end < 0 ? b.say.length : end) - start };
}

export type Stage = {
  /** The visual on stage, by id. */
  visual: string | null;
  lines: number[];
  emphasis: string[];
  /** Per diagram that builds up live: the nodes drawn in so far. */
  revealed: Record<string, string[]>;
  steps: Record<string, number>;
  /** The latest camera and code-panel moves; `key` changes whenever a new one fires. */
  focus?: { key: string; paths: string[]; label?: string };
  open?: { key: string; path: string; line?: number; endLine?: number };
};

/** Diagrams with any reveal cue start empty and draw themselves in. */
export function liveDiagrams(s: Story): Set<string> {
  const live = new Set<string>();
  let on: string | null = null;
  for (const b of s.beats)
    for (const c of b.cues) {
      if (c.kind === "show") on = c.visual;
      else if (c.kind === "reveal" && on) live.add(on);
    }
  return live;
}

export function stageAt(s: Story, beat: number, ms: number): Stage {
  const st: Stage = { visual: null, lines: [], emphasis: [], revealed: {}, steps: {} };
  for (let bi = 0; bi <= beat && bi < s.beats.length; bi++) {
    const b = s.beats[bi];
    b.cues.forEach((c, ci) => {
      if (bi === beat && cueMs(b, c.at) > ms) return;
      const key = `${bi}:${ci}`;
      switch (c.kind) {
        case "show":
          st.visual = c.visual;
          st.lines = [];
          st.emphasis = [];
          break;
        case "lines":
          st.lines = c.lines;
          break;
        case "emphasize":
          st.emphasis = c.nodes;
          break;
        case "reveal":
          if (st.visual) st.revealed[st.visual] = [...new Set([...(st.revealed[st.visual] ?? []), ...c.nodes])];
          break;
        case "step":
          if (st.visual) st.steps[st.visual] = c.step;
          break;
        case "focus":
          st.focus = { key, paths: c.paths, label: c.label };
          break;
        case "open":
          st.open = { key, path: c.path, line: c.line, endLine: c.endLine };
          break;
      }
    });
  }
  return st;
}

/** Position in the whole story, from a beat and ms into it — and back. */
export function absMs(s: Story, beat: number, ms: number) {
  return s.beats.slice(0, beat).reduce((t, b) => t + beatMs(b), 0) + ms;
}
export function fromAbs(s: Story, abs: number): { beat: number; ms: number } {
  let t = Math.max(0, abs);
  for (let i = 0; i < s.beats.length; i++) {
    const d = beatMs(s.beats[i]);
    if (t < d || i === s.beats.length - 1) return { beat: i, ms: Math.min(t, d) };
    t -= d;
  }
  return { beat: 0, ms: 0 };
}

export const clock = (ms: number) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};
