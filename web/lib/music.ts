/**
 * Listening to the music you play while you fly, so the sky can move with it.
 *
 * Spotify can't be read directly: its streams are DRM-protected, so a page
 * never gets their samples, and its Web API no longer gives new apps the
 * per-track audio analysis. So we listen the way a visualiser on a stage
 * does: to what's actually playing. Either a tab or the computer's audio,
 * shared through the browser's screen-share picker (pick the Spotify tab, or
 * the whole screen with its audio, for the desktop app), or the microphone,
 * which hears the room (the headset's way: its browser can't share audio).
 *
 * The samples stay in the page. An analyser splits them into bass, mids and
 * highs, each scaled against its own recent peak so a quiet room and a loud
 * one move the sky about as much, and kicks in the bass become beats.
 */

import * as THREE from "three";

export type MusicSource = "share" | "mic";
export type MusicState = { on: boolean; starting: boolean; source: MusicSource | null; error: string | null };

/** What the music is doing now, each 0..1. */
export type Pulse = { level: number; bass: number; mid: number; high: number; beat: number };

const QUIET: Pulse = { level: 0, bass: 0, mid: 0, high: 0, beat: 0 };

class Music {
  state: MusicState = { on: false, starting: false, source: null, error: null };
  private listeners = new Set<() => void>();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private bins: Uint8Array<ArrayBuffer> | null = null;
  private pulse: Pulse = { ...QUIET };
  private readAt = 0;
  /** Each band's recent peak, falling slowly: what "loud" means right now. */
  private peak = { bass: 0.05, mid: 0.05, high: 0.05 };
  /** The bass's running average, for telling a kick from a held note. */
  private bassAvg = 0;
  private beatAt = 0;

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(s: Partial<MusicState>) {
    this.state = { ...this.state, ...s };
    for (const fn of this.listeners) fn();
  }

  /** Called from a press: the browser asks which tab, screen or microphone. */
  async start(source: MusicSource) {
    this.stop();
    this.set({ starting: true, source, error: null });
    try {
      const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      let stream: MediaStream;
      if (source === "share") {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser can't share a tab's audio. Try the microphone.");
        // Chrome only offers audio alongside video; the video is dropped at once.
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { ...raw, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
          systemAudio: "include",
        } as DisplayMediaStreamOptions);
        for (const t of stream.getVideoTracks()) {
          t.stop();
          stream.removeTrack(t);
        }
        if (!stream.getAudioTracks().length) throw new Error("No audio came with that share. Pick a tab or screen and turn on “Share audio”.");
      } else {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't use the microphone here.");
        stream = await navigator.mediaDevices.getUserMedia({ audio: raw });
      }
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.55;
      // Only into the analyser, never the speakers: the music is already playing.
      ctx.createMediaStreamSource(stream).connect(analyser);
      void ctx.resume().catch(() => {});
      // Stopping the share from the browser's own bar ends it here too.
      for (const t of stream.getAudioTracks()) t.addEventListener("ended", () => this.stream === stream && this.stop());
      this.ctx = ctx;
      this.stream = stream;
      this.analyser = analyser;
      this.bins = new Uint8Array(analyser.frequencyBinCount);
      this.peak = { bass: 0.05, mid: 0.05, high: 0.05 };
      this.bassAvg = 0;
      this.set({ on: true, starting: false });
    } catch (e) {
      const err = e as Error;
      // Closing the picker isn't a failure, just a change of mind.
      const cancelled = err.name === "NotAllowedError" && source === "share";
      this.set({ on: false, starting: false, source: null, error: cancelled ? null : err.name === "NotAllowedError" ? "The microphone wasn't allowed." : err.message });
    }
  }

  stop() {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.bins = null;
    this.pulse = { ...QUIET };
    if (this.state.on || this.state.starting) this.set({ on: false, starting: false, source: null });
  }

  /** Mean of the bins between two frequencies, 0..1. */
  private band(lo: number, hi: number) {
    const bins = this.bins!;
    const hz = this.ctx!.sampleRate / 2 / bins.length;
    const a = Math.max(1, Math.floor(lo / hz));
    const b = Math.min(bins.length - 1, Math.ceil(hi / hz));
    let sum = 0;
    for (let i = a; i <= b; i++) sum += bins[i];
    return sum / ((b - a + 1) * 255);
  }

  /** The music now. Cheap to call more than once a frame: it reads the analyser once per frame. */
  read(now = performance.now()): Pulse {
    if (!this.analyser || !this.bins) return QUIET;
    const dt = Math.min(0.1, (now - this.readAt) / 1000);
    if (dt < 0.008) return this.pulse;
    this.readAt = now;
    this.analyser.getByteFrequencyData(this.bins);
    const raw = { bass: this.band(30, 150), mid: this.band(150, 2000), high: this.band(2000, 10000) };
    const p = this.pulse;
    const fall = Math.exp(-dt / 6);
    for (const k of ["bass", "mid", "high"] as const) {
      this.peak[k] = Math.max(raw[k], this.peak[k] * fall, 0.02);
      // Quiet hiss under the floor reads as nothing.
      const v = Math.max(0, (raw[k] / this.peak[k] - 0.15) / 0.85);
      // Up at once, down gently, so it pulses instead of flickering.
      p[k] = v > p[k] ? v : p[k] + (v - p[k]) * Math.min(1, dt * 6);
    }
    p.level = p.bass * 0.5 + p.mid * 0.35 + p.high * 0.15;
    // A beat: the bass jumping well above where it's been, not too soon after the last.
    this.bassAvg += (raw.bass - this.bassAvg) * Math.min(1, dt * 3);
    if (raw.bass > this.bassAvg * 1.3 && raw.bass > this.peak.bass * 0.55 && now - this.beatAt > 220) {
      this.beatAt = now;
      p.beat = 1;
    } else p.beat *= Math.exp(-dt / 0.18);
    return p;
  }
}

/** How the sky moves with the music: multipliers on the tuned values, and the colours to draw. */
export type Sky = { starSize: number; starOpacity: number; bloom: number; star: THREE.Color; night: THREE.Color };

const HUE = new THREE.Color();
const sky: Sky = { starSize: 1, starOpacity: 1, bloom: 1, star: new THREE.Color(), night: new THREE.Color() };

/**
 * The sky for this pulse, `k` strong (the tuned "Music" knob; 0 is still).
 * Stars swell with the bass and flash on beats, take a colour from the highs,
 * and the night lifts toward a deep colour with the bass. The colour drifts
 * slowly round the wheel, a little faster when the mids are busy.
 */
export function skyFor(p: Pulse, k: number, starBase: THREE.Color, nightBase: THREE.Color, now = performance.now()): Sky {
  const hue = (now / 40000 + p.mid * 0.08) % 1;
  sky.starSize = 1 + k * (0.7 * p.bass + 0.9 * p.beat);
  sky.starOpacity = 1 + k * (0.5 * p.level + 0.5 * p.beat - 0.2);
  sky.bloom = 1 + k * (0.45 * p.bass + 0.6 * p.beat);
  sky.star.copy(starBase).lerp(HUE.setHSL(hue, 0.75, 0.72, THREE.SRGBColorSpace), Math.min(1, k * (0.25 + 0.6 * p.high)));
  sky.night.copy(nightBase).lerp(HUE.setHSL((hue + 0.5) % 1, 0.65, 0.14, THREE.SRGBColorSpace), Math.min(1, k * (0.4 * p.bass + 0.35 * p.beat)));
  return sky;
}

/** One for the page: the desktop and the headset hear the same music. */
export const music = new Music();
