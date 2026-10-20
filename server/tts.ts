import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BeatWord, StorySettings } from "../shared/types";
import { CACHE_DIR } from "./session";

/**
 * Narration through Inworld's text-to-speech. Each story beat is synthesized
 * on its own (a beat is well under the 2,000-character limit), with word
 * timestamps, so the player can fire a cue on the exact word it was anchored
 * to and caption the word being spoken. Audio is cached on disk by what was
 * said and how, so replaying, reopening, or re-voicing a story with a voice
 * already used costs nothing.
 */

const TTS_URL = "https://api.inworld.ai/tts/v1/voice";
const VOICES_URL = "https://api.inworld.ai/tts/v1/voices";
const AUDIO_DIR = path.join(CACHE_DIR, "audio");

export const ttsAvailable = () => !!process.env.INWORLD_API_KEY?.trim();

/** Which voice a story was voiced with; a change in any of these means re-voicing. */
export const voiceKey = (s: StorySettings) => `${s.ttsModel}|${s.voiceId}|${s.rate}`;

const audioKey = (text: string, s: StorySettings) => createHash("sha1").update(`${voiceKey(s)}|${text}`).digest("hex").slice(0, 24);
const audioPath = (key: string) => path.join(AUDIO_DIR, `${key}.mp3`);
const metaPath = (key: string) => path.join(AUDIO_DIR, `${key}.json`);

export type Voiced = { key: string; ms: number; words: BeatWord[] };

type Alignment = { words: string[]; wordStartTimeSeconds: number[]; wordEndTimeSeconds: number[] };

/**
 * Inworld's words, placed in the script: each timed word is found in `say`
 * from where the previous one ended, so a cue's character offset maps to the
 * moment it's spoken. Spaces and punctuation-only tokens are dropped.
 */
function align(say: string, a: Alignment): BeatWord[] {
  const out: BeatWord[] = [];
  const lower = say.toLowerCase();
  let cursor = 0;
  a.words.forEach((raw, k) => {
    const w = raw.trim();
    if (!/[\p{L}\p{N}]/u.test(w)) return;
    const at = lower.indexOf(w.toLowerCase(), cursor);
    if (at < 0) return; // the voice normalized it ("42" → "forty-two"); its neighbours still place the beat
    out.push({ i: at, n: w.length, s: Math.round(a.wordStartTimeSeconds[k] * 1000), e: Math.round(a.wordEndTimeSeconds[k] * 1000) });
    cursor = at + w.length;
  });
  return out;
}

export async function synthesize(say: string, settings: StorySettings): Promise<Voiced> {
  const key = audioKey(say, settings);
  try {
    await stat(audioPath(key));
    return JSON.parse(await readFile(metaPath(key), "utf8")) as Voiced;
  } catch {
    /* not voiced yet */
  }

  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${process.env.INWORLD_API_KEY?.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: say,
      voiceId: settings.voiceId,
      modelId: settings.ttsModel,
      audioConfig: { audioEncoding: "MP3", speakingRate: settings.rate },
      timestampType: "WORD",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Inworld TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { audioContent?: string; timestampInfo?: { wordAlignment?: Alignment } };
  if (!body.audioContent) throw new Error("Inworld TTS returned no audio.");

  const a = body.timestampInfo?.wordAlignment;
  const words = a ? align(say, a) : [];
  const ms = a?.wordEndTimeSeconds.length ? Math.round(Math.max(...a.wordEndTimeSeconds) * 1000) : estimateMs(say);
  const voiced: Voiced = { key, ms, words };
  await mkdir(AUDIO_DIR, { recursive: true });
  await writeFile(audioPath(key), Buffer.from(body.audioContent, "base64"));
  await writeFile(metaPath(key), JSON.stringify(voiced));
  return voiced;
}

/** Roughly how long a line takes to say, for a story played without a voice. */
export function estimateMs(say: string) {
  return Math.max(1200, Math.round((say.split(/\s+/).filter(Boolean).length / 2.6) * 1000));
}

export async function readAudio(key: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{24}$/.test(key)) return null;
  try {
    return await readFile(audioPath(key));
  } catch {
    return null;
  }
}

/** A line in a voice, for hearing it before choosing it. Cached like any other. */
export function previewVoice(settings: StorySettings): Promise<Voiced> {
  return synthesize("Here's how your stories will sound: a short walk through the code, in step with what's on screen.", settings);
}

export type VoiceOption = { id: string; name: string; description: string };

let voices: Promise<VoiceOption[]> | null = null;

/** The English voices this key can use, fetched once. */
export function listVoices(): Promise<VoiceOption[]> {
  if (!ttsAvailable()) return Promise.resolve([]);
  voices ??= fetch(VOICES_URL, { headers: { Authorization: `Basic ${process.env.INWORLD_API_KEY?.trim()}` }, signal: AbortSignal.timeout(20_000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`voices ${r.status}`))))
    .then((b: { voices?: { voiceId: string; displayName?: string; description?: string; languages?: string[] }[] }) =>
      (b.voices ?? [])
        .filter((v) => !v.languages?.length || v.languages.some((l) => /^en/i.test(l)))
        .map((v) => ({ id: v.voiceId, name: v.displayName || v.voiceId, description: v.description ?? "" })),
    )
    .catch((err) => {
      voices = null; // try again next time
      throw err;
    });
  return voices;
}
