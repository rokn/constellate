import * as THREE from "three";
import { music } from "../lib/music";

/**
 * The room's sound: a quiet ambience under the map, and small effects for
 * what your hands do. Everything is synthesised with Web Audio (no files to
 * load), and the effects that belong somewhere (a body you picked, a panel
 * snapping onto the table) come from there, through an HRTF panner that
 * follows your head.
 *
 * The ambience is a low, slow pad with a breath of filtered noise, and now
 * and then a faint chime from one of the map's bodies: each top-level folder
 * has its own note, so the map hums in its own key. While you're listening
 * to music (lib/music), it hushes: the music is the ambience then.
 */

export type Sfx = "tick" | "hover" | "pick" | "focus" | "grab" | "drop" | "snap" | "fling" | "place" | "enter" | "back";

export type SoundSettings = { sfx: boolean; sfxVolume: number; ambience: boolean; ambienceVolume: number };

/** A minor pentatonic over A, two octaves: notes that never clash. */
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];
const note = (i: number, base = 440) => base * Math.pow(2, SCALE[((i % SCALE.length) + SCALE.length) % SCALE.length] / 12);

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Where an ambient chime can come from: a body on the map, and the folder it's in. */
export type ChimeSource = () => { at: THREE.Vector3; key: string } | null;

class Sound {
  private ctx: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private ambBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private pad: { stop: () => void } | null = null;
  private chimeTimer = 0;
  private lastHover = 0;
  private s: SoundSettings = { sfx: true, sfxVolume: 0.6, ambience: true, ambienceVolume: 0.5 };
  private live = false;
  chimeSource: ChimeSource | null = null;

  /** Called from a press (a user gesture): the browser lets audio start then. */
  start() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      const master = ctx.createDynamicsCompressor();
      master.threshold.value = -14;
      master.ratio.value = 4;
      master.connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.ambBus = ctx.createGain();
      this.sfxBus.connect(master);
      this.ambBus.connect(master);
      this.ambBus.gain.value = 0;
      // Two seconds of white noise, for breath, whooshes and clacks.
      const n = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    this.live = true;
    void this.ctx.resume().catch(() => {});
    this.apply();
  }

  /** A press in the room: if the browser held audio back until now, it can start. */
  resume() {
    if (this.live && this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  /** Out of the headset: the ambience fades and the context sleeps. */
  stop() {
    this.live = false;
    const ctx = this.ctx;
    if (!ctx) return;
    this.ambBus!.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    setTimeout(() => {
      if (this.live) return;
      this.pad?.stop();
      this.pad = null;
      void ctx.suspend().catch(() => {});
    }, 900);
  }

  configure(s: SoundSettings) {
    this.s = s;
    this.apply();
  }

  apply() {
    const ctx = this.ctx;
    if (!ctx || !this.live) return;
    this.sfxBus!.gain.setTargetAtTime(this.s.sfx ? this.s.sfxVolume : 0, ctx.currentTime, 0.05);
    const amb = this.s.ambience ? this.s.ambienceVolume * 0.5 * (music.state.on ? 0.1 : 1) : 0;
    this.ambBus!.gain.setTargetAtTime(amb, ctx.currentTime, 0.8);
    if (amb > 0 && !this.pad) this.pad = this.makePad();
  }

  /** Each frame: your ears are where your head is. */
  listen(pos: THREE.Vector3, quat: THREE.Quaternion, now: number) {
    const ctx = this.ctx;
    if (!ctx || !this.live || ctx.state !== "running") return;
    const l = ctx.listener;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02);
      l.forwardY.setTargetAtTime(f.y, t, 0.02);
      l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.setTargetAtTime(u.x, t, 0.02);
      l.upY.setTargetAtTime(u.y, t, 0.02);
      l.upZ.setTargetAtTime(u.z, t, 0.02);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    // Now and then, a body on the map chimes, softly, in its folder's note.
    if (this.s.ambience && !music.state.on && this.chimeSource && now > this.chimeTimer) {
      this.chimeTimer = now + 3500 + Math.random() * 6000;
      const c = this.chimeSource();
      if (c) this.chime(c.at, hash(c.key));
    }
  }

  /** An effect, from `at` (world) if it belongs somewhere, else in your head. */
  play(kind: Sfx, at?: THREE.Vector3 | null, key?: string) {
    const ctx = this.ctx;
    if (!ctx || !this.live || !this.s.sfx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    if (kind === "hover") {
      // Brushing past bodies would chatter: one blip at a time.
      if (t - this.lastHover < 0.07) return;
      this.lastHover = t;
    }
    const out = this.out(at, this.sfxBus!);
    const k = key ? hash(key) : 0;
    switch (kind) {
      case "tick":
        this.tone(out, t, { f: 2100, f2: 1500, type: "sine", gain: 0.12, a: 0.002, d: 0.045 });
        this.burst(out, t, { band: 4200, q: 3, gain: 0.08, d: 0.012 });
        break;
      case "back":
        this.tone(out, t, { f: 1500, f2: 1000, type: "sine", gain: 0.1, a: 0.002, d: 0.07 });
        break;
      case "hover":
        this.tone(out, t, { f: note(k, 880), type: "sine", gain: 0.035, a: 0.004, d: 0.08 });
        break;
      case "pick":
        this.tone(out, t, { f: note(k, 440), type: "triangle", gain: 0.16, a: 0.004, d: 0.5 });
        this.tone(out, t + 0.06, { f: note(k + 2, 440) * 2, type: "sine", gain: 0.08, a: 0.004, d: 0.6 });
        break;
      case "focus":
        [0, 2, 4, 7].forEach((s, i) => this.tone(out, t + i * 0.07, { f: note(k + s, 440), type: "triangle", gain: 0.1, a: 0.005, d: 0.55 }));
        break;
      case "grab":
        this.tone(out, t, { f: 260, f2: 340, type: "sine", gain: 0.14, a: 0.004, d: 0.09 });
        break;
      case "drop":
        this.tone(out, t, { f: 300, f2: 210, type: "sine", gain: 0.12, a: 0.004, d: 0.11 });
        break;
      case "snap":
        // A clack on the surface, and the thud of it landing.
        this.burst(out, t, { band: 2400, q: 1.4, gain: 0.35, d: 0.03 });
        this.tone(out, t, { f: 150, f2: 90, type: "sine", gain: 0.35, a: 0.002, d: 0.14 });
        this.tone(out, t + 0.03, { f: 1320, type: "sine", gain: 0.05, a: 0.004, d: 0.25 });
        break;
      case "fling":
        this.sweep(out, t, { from: 500, to: 3200, gain: 0.3, d: 0.4 });
        break;
      case "place":
        // The map coming down on the table: a low swell and a shimmer over it.
        this.tone(out, t, { f: 110, type: "sine", gain: 0.25, a: 0.15, d: 1.6 });
        this.tone(out, t, { f: 165, type: "sine", gain: 0.12, a: 0.2, d: 1.6 });
        [0, 4, 7, 9].forEach((s, i) => this.tone(out, t + 0.25 + i * 0.09, { f: note(s, 880), type: "sine", gain: 0.05, a: 0.01, d: 0.9 }));
        break;
      case "enter":
        [0, 2, 4, 5, 7].forEach((s, i) => this.tone(out, t + i * 0.11, { f: note(s, 440), type: "sine", gain: 0.07, a: 0.02, d: 1.2 }));
        break;
    }
  }

  /* -------------------------------- voices -------------------------------- */

  /** Where a voice goes: through a panner at `at`, or straight to the bus. */
  private out(at: THREE.Vector3 | null | undefined, bus: AudioNode): AudioNode {
    const ctx = this.ctx!;
    if (!at) return bus;
    const p = ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = 0.6;
    p.rolloffFactor = 0.8;
    if (p.positionX) {
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
    } else p.setPosition(at.x, at.y, at.z);
    p.connect(bus);
    // The panner goes once its voices have.
    setTimeout(() => p.disconnect(), 3000);
    return p;
  }

  private tone(out: AudioNode, t: number, o: { f: number; f2?: number; type: OscillatorType; gain: number; a: number; d: number }) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + o.a + o.d);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain, t + o.a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.a + o.d);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + o.a + o.d + 0.05);
  }

  /** A short burst of filtered noise: a click or a clack. */
  private burst(out: AudioNode, t: number, o: { band: number; q: number; gain: number; d: number }) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = o.band;
    bp.Q.value = o.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(o.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + o.d + 0.02);
  }

  /** Noise swept up through a band: a whoosh. */
  private sweep(out: AudioNode, t: number, o: { from: number; to: number; gain: number; d: number }) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(o.from, t);
    bp.frequency.exponentialRampToValueAtTime(o.to, t + o.d);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain, t + o.d * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.d);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + o.d + 0.05);
  }

  /** A faint bell from a body on the map, in its folder's note. */
  private chime(at: THREE.Vector3, k: number) {
    const ctx = this.ctx!;
    const out = this.out(at, this.ambBus!);
    const t = ctx.currentTime;
    const f = note(k, 660);
    this.tone(out, t, { f, type: "sine", gain: 0.06, a: 0.01, d: 2.2 });
    this.tone(out, t, { f: f * 2.01, type: "sine", gain: 0.015, a: 0.01, d: 1.4 });
  }

  /**
   * The ambience: three low voices a fifth and an octave apart, drifting
   * against each other, and a breath of noise whose colour slowly moves.
   */
  private makePad() {
    const ctx = this.ctx!;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.ambBus!);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    lp.Q.value = 0.7;
    lp.connect(bus);
    const nodes: AudioScheduledSourceNode[] = [];
    for (const [f, g, detune] of [
      [55, 0.22, -4],
      [82.4, 0.12, 3],
      [110, 0.1, 6],
      [164.8, 0.035, -7],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      o.detune.value = detune;
      const gn = ctx.createGain();
      gn.gain.value = g;
      // Each voice swells and fades on its own slow breath.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.03 + Math.random() * 0.05;
      const depth = ctx.createGain();
      depth.gain.value = g * 0.6;
      lfo.connect(depth).connect(gn.gain);
      o.connect(gn).connect(lp);
      o.start();
      lfo.start();
      nodes.push(o, lfo);
    }
    // Breath: noise, low-passed, its cutoff wandering.
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = 380;
    const ng = ctx.createGain();
    ng.gain.value = 0.05;
    const wander = ctx.createOscillator();
    wander.frequency.value = 0.045;
    const wd = ctx.createGain();
    wd.gain.value = 220;
    wander.connect(wd).connect(nf.frequency);
    n.connect(nf).connect(ng).connect(bus);
    n.start();
    wander.start();
    nodes.push(n, wander);
    return {
      stop: () => {
        for (const x of nodes) {
          try {
            x.stop();
          } catch {
            /* already stopped */
          }
        }
        bus.disconnect();
      },
    };
  }
}

/** One for the page: the room's ears. */
export const sfx = new Sound();
// Music starting or stopping hushes the ambience, or brings it back.
music.subscribe(() => sfx.apply());
