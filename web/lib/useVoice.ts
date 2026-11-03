import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenContext, UiCommand } from "../../shared/types";
import type { BoardScreen } from "../../shared/board";

/**
 * The browser end of the voice: mic capture and playback at 24 kHz through
 * AudioWorklets, barge-in, captions, and the commands the voice issues. The
 * session itself lives in server/voice.ts; this only carries audio and tells
 * it what is on screen.
 *
 * Keeping it from cutting itself off. The browser's echo canceller only knows
 * about audio that came in over WebRTC, so a voice played through Web Audio
 * leaks straight back into the mic (on a Quest the speakers sit an inch from
 * it); the speech detector hears it, and the reply was cancelled mid-word.
 * Three things stop that:
 *  - The voice is played through a WebRTC loopback (two local peer
 *    connections into an <audio>), so the echo canceller hears it and takes
 *    it out of the mic.
 *  - An echo guard: while it's speaking, the mic sends silence unless it's
 *    clearly louder than the voice's own echo (a margin, in dB, over what it
 *    learns in the reply's first moments).
 *  - Talking over it ducks it first and stops it only once that's really
 *    speech (still going after a moment, or words transcribed). A cough, a
 *    click, a leftover echo: it comes back up. The server no longer cancels
 *    on its own; this decides.
 */

/**
 * Minutes without them saying anything before the voice turns off (a
 * setting, ten by default): the speech-to-text is billed for every second
 * streamed. The server keeps the same clock, kept to an hour at most.
 */
const DEFAULT_IDLE_MIN = 10;

export type VoiceState = "idle" | "connecting" | "listening" | "speaking" | "error";
export type Turn = { role: "user" | "voice"; text: string };
/** The transcript, with what happened along the way (cut off, talked over, reconnecting…). */
export type LogEntry = { at: number; who: "you" | "voice" | "note"; text: string; cut?: boolean };

/** How the voice guards against hearing itself: all on by default. */
export type VoiceAudio = {
  /** Play through a WebRTC loopback, so the browser's echo canceller hears it. */
  loopback?: boolean;
  /** While it speaks, the mic sends silence unless it's clearly louder than the echo. */
  echoGuard?: boolean;
  /** How much louder than its echo you have to be to talk over it (dB). */
  talkOverDb?: number;
  /** How long talking over it must last before it stops (ms); words transcribed stop it sooner. */
  confirmMs?: number;
  /** Audio queued before it starts playing (ms): smooths a patchy connection. */
  prebufferMs?: number;
};

/** After the last sound it played, how long the room (and the loopback's buffer) may still carry it. */
const ECHO_TAIL_MS = 450;
const LOG_MAX = 300;

/**
 * The voice's audio, played through two local peer connections into an
 * <audio>: the one path the browser's echo canceller takes as its reference.
 * Resolves to a teardown, or null if WebRTC isn't there (play it directly).
 */
async function loopbackPlay(stream: MediaStream): Promise<(() => void) | null> {
  if (typeof RTCPeerConnection === "undefined") return null;
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  const el = new Audio();
  el.autoplay = true;
  const down = () => {
    a.close();
    b.close();
    el.pause();
    el.srcObject = null;
  };
  try {
    a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate).catch(() => {});
    const track = new Promise<MediaStream>((ok, fail) => {
      b.ontrack = (e) => ok(e.streams[0] ?? new MediaStream([e.track]));
      setTimeout(() => fail(new Error("no loopback track")), 2500);
    });
    for (const t of stream.getAudioTracks()) a.addTrack(t, stream);
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    el.srcObject = await track;
    await el.play();
    return down;
  } catch {
    down();
    return null;
  }
}

function toBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

export function useVoice({
  screen,
  onCommand,
  volume = 1,
  idleMinutes = DEFAULT_IDLE_MIN,
  path = "/api/voice",
  settings,
  onDictated,
  interrupt = true,
  audioOptions,
}: {
  /** What's on screen: the code map's, or the workshop's (with path /api/board/voice). */
  screen: ScreenContext | BoardScreen;
  onCommand: (cmd: UiCommand) => void;
  volume?: number;
  idleMinutes?: number;
  path?: string;
  /** Voice settings for the server's session (speed, eagerness, …): sent on connect and when they change. */
  settings?: Record<string, unknown>;
  /** Words taken down as said (dictation), from the server. */
  onDictated?: (text: string) => void;
  /** Whether talking over it stops it (else it finishes; it still hears you). */
  interrupt?: boolean;
  /** How it keeps from hearing itself. */
  audioOptions?: VoiceAudio;
}) {
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt;
  const audioOpts = useRef<VoiceAudio>({});
  audioOpts.current = audioOptions ?? {};
  const idleMin = useRef(idleMinutes);
  idleMin.current = Math.min(60, Math.max(1, Math.round(idleMinutes || DEFAULT_IDLE_MIN)));
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const note = useCallback((who: LogEntry["who"], text: string, cut?: boolean) => {
    setLog((l) => [...l.slice(-(LOG_MAX - 1)), { at: Date.now(), who, text, ...(cut ? { cut } : {}) }]);
  }, []);
  const clearLog = useCallback(() => setLog([]), []);

  const ws = useRef<WebSocket | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const playback = useRef<AudioWorkletNode | null>(null);
  const gain = useRef<GainNode | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  /** Ducked while someone may be talking over it (1 = not). */
  const duck = useRef(1);
  const setGain = useCallback(() => {
    const g = gain.current;
    if (!g) return;
    g.gain.setTargetAtTime(volumeRef.current * duck.current, g.context.currentTime, 0.03);
  }, []);
  useEffect(() => setGain(), [volume, setGain]);
  const loopDown = useRef<(() => void) | null>(null);
  /** Playing now, and when it last was: the echo guard's clock. */
  const playingNow = useRef(false);
  const lastPlayed = useRef(0);
  const guard = useRef({ echo: 0, learnUntil: 0, loud: 0, openUntil: 0 });
  /** Someone may be talking over it: stop it once that's sure. */
  const barge = useRef<ReturnType<typeof setTimeout> | null>(null);
  const partial = useRef({ user: "", voice: "" });
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const onDictatedRef = useRef(onDictated);
  onDictatedRef.current = onDictated;
  const screenRef = useRef(screen);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const send = useCallback((obj: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(obj));
  }, []);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const settingsKey = JSON.stringify(settings ?? null);
  useEffect(() => {
    if (settings) send({ type: "proxy.settings", settings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, send]);

  // Whatever changes on screen reaches the voice's instructions.
  const screenKey = JSON.stringify(screen);
  useEffect(() => {
    screenRef.current = screen;
    send({ type: "proxy.screen", screen });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenKey, send]);

  const commitVoice = useCallback(
    (cut = false) => {
      const text = partial.current.voice.trim();
      partial.current.voice = "";
      setCaption("");
      if (text) {
        setTurns((t) => [...t.slice(-30), { role: "voice", text }]);
        note("voice", text, cut);
      }
    },
    [note],
  );

  /** Talked over for real: stop the voice. */
  const cutOff = useCallback(() => {
    if (barge.current) clearTimeout(barge.current);
    barge.current = null;
    playback.current?.port.postMessage({ type: "flush" });
    send({ type: "response.cancel" });
    duck.current = 1;
    setGain();
    commitVoice(true);
    setState("listening");
  }, [send, commitVoice, setGain]);

  const stop = useCallback(() => {
    clearTimeout(idleTimer.current);
    idleTimer.current = undefined;
    if (barge.current) clearTimeout(barge.current);
    barge.current = null;
    loopDown.current?.();
    loopDown.current = null;
    playingNow.current = false;
    ws.current?.close();
    ws.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    void audio.current?.close();
    audio.current = null;
    playback.current = null;
    gain.current = null;
    setState("idle");
    setHeard("");
    commitVoice();
  }, [commitVoice]);

  const stopRef = useRef(stop);
  stopRef.current = stop;
  const stillHere = useCallback(() => {
    clearTimeout(idleTimer.current);
    const min = idleMin.current;
    idleTimer.current = setTimeout(() => {
      stopRef.current();
      setError(`Voice turned off after ${min} minute${min === 1 ? "" : "s"} of silence.`);
    }, min * 60_000);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setState("connecting");
    stillHere();
    try {
      mic.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext({ sampleRate: 24000 });
      audio.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-worklets.js");

      const opts = audioOpts.current;
      const play = new AudioWorkletNode(ctx, "playback-processor", { outputChannelCount: [1] });
      const pre = Math.round(Math.max(0, Math.min(500, opts.prebufferMs ?? 100)) * 24);
      play.port.postMessage({ type: "config", prebuffer: pre, maxWait: pre * 2 });
      // Through a gain, so the voice can be turned up (a headset's speakers are quiet) or down.
      const g = ctx.createGain();
      duck.current = 1;
      g.gain.value = volumeRef.current;
      gain.current = g;
      play.connect(g);
      // Through the loopback, so the echo canceller knows it; straight out if that can't be had.
      let routed = false;
      if (opts.loopback !== false) {
        const dest = ctx.createMediaStreamDestination();
        g.connect(dest);
        const down = await loopbackPlay(dest.stream);
        if (down) {
          loopDown.current = down;
          routed = true;
          note("note", "Its voice is echo-cancelled (it won't hear itself)");
        } else {
          g.disconnect(dest);
          note("note", "Echo cancelling for the voice isn't available here: playing it directly.");
        }
      }
      if (!routed) g.connect(ctx.destination);
      play.port.onmessage = (e) => {
        if (e.data?.type !== "playing") return;
        const on = !!e.data.value;
        if (on && !playingNow.current) {
          // A new stretch of speech: learn its echo afresh.
          guard.current = { echo: 0, learnUntil: performance.now() + 250, loud: 0, openUntil: 0 };
        }
        playingNow.current = on;
        lastPlayed.current = performance.now();
        setState(on ? "speaking" : "listening");
      };
      playback.current = play;

      const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}?idle=${idleMin.current}`);
      ws.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "proxy.screen", screen: screenRef.current }));
        if (settingsRef.current) socket.send(JSON.stringify({ type: "proxy.settings", settings: settingsRef.current }));
      };
      let failed = false;
      socket.onerror = () => {
        failed = true;
        setError("The voice connection failed.");
        setState("error");
      };
      // However it closes (the server ends an idle session, the network drops),
      // the mic goes too: nothing should keep capturing with nowhere to send it.
      socket.onclose = () => {
        if (ws.current !== socket) return;
        ws.current = null;
        stopRef.current();
        if (failed) setState("error");
      };
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        switch (msg.type) {
          case "proxy.status":
            if (msg.status === "ready") {
              // It listens; it doesn't open with a speech of its own.
              setState("listening");
              note("note", "Listening");
            } else if (msg.status === "reconnecting") {
              note("note", "The voice's connection dropped: reconnecting…");
            } else if (msg.status === "error") {
              setError(msg.message ?? "Voice error");
              setState("error");
              note("note", `Error: ${msg.message ?? "voice error"}`);
            }
            return;
          case "proxy.error":
            setError(msg.message);
            setState("error");
            note("note", `Error: ${msg.message}`);
            return;
          case "proxy.idle":
            setError("Voice turned off after 10 minutes of silence.");
            note("note", "Turned off after a long silence");
            return;
          case "proxy.command":
            onCommandRef.current(msg.cmd as UiCommand);
            return;
          case "proxy.dictated":
            onDictatedRef.current?.(String(msg.text ?? ""));
            return;
          case "input_audio_buffer.speech_started": {
            stillHere();
            const speaking = playingNow.current || performance.now() - lastPlayed.current < ECHO_TAIL_MS;
            if (!speaking) {
              commitVoice();
              setState("listening");
              return;
            }
            // Over the voice. If that's not allowed, it finishes (it still hears you).
            if (!interruptRef.current) return;
            // Duck it, and stop it once it's surely speech.
            duck.current = 0.25;
            setGain();
            if (barge.current) clearTimeout(barge.current);
            const wait = Math.max(0, Math.min(1500, audioOpts.current.confirmMs ?? 350));
            barge.current = setTimeout(() => {
              barge.current = null;
              note("note", "You talked over it: stopped");
              cutOff();
            }, wait);
            return;
          }
          case "input_audio_buffer.speech_stopped":
            if (barge.current) {
              // Too short to be them: a cough, a click, its own echo. Back up.
              clearTimeout(barge.current);
              barge.current = null;
              duck.current = 1;
              setGain();
              note("note", "A sound while it spoke (not words): kept going");
            }
            return;
          case "conversation.item.input_audio_transcription.delta":
            partial.current.user += msg.delta ?? "";
            setHeard(partial.current.user);
            // Words: it's them. Stop now rather than wait.
            if (barge.current && partial.current.user.replace(/[^\p{L}\p{N}]/gu, "").length >= 3) {
              note("note", "You talked over it: stopped");
              cutOff();
            }
            return;
          case "conversation.item.input_audio_transcription.completed": {
            const text = (msg.transcript ?? partial.current.user).trim();
            partial.current.user = "";
            setHeard("");
            if (text) {
              setTurns((t) => [...t.slice(-30), { role: "user", text }]);
              note("you", text);
            }
            return;
          }
          case "response.output_audio.delta":
            if (msg.delta) playback.current?.port.postMessage({ type: "chunk", data: fromBase64(msg.delta) });
            return;
          case "response.output_audio_transcript.delta":
          case "response.output_text.delta":
            partial.current.voice += msg.delta ?? "";
            setCaption(partial.current.voice);
            return;
          case "response.done":
            commitVoice(msg.response?.status === "cancelled" || msg.response?.status === "incomplete");
            return;
        }
      };

      /**
       * The echo guard: while the voice speaks (and a moment after), the mic
       * only goes through when it's clearly louder than the voice's own echo,
       * learned in the first moments of each stretch of speech.
       */
      const echoPass = (f: Float32Array) => {
        const o = audioOpts.current;
        if (o.echoGuard === false) return true;
        const now = performance.now();
        if (!playingNow.current && now - lastPlayed.current > ECHO_TAIL_MS) return true;
        let sum = 0;
        for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
        const rms = Math.sqrt(sum / f.length);
        const gd = guard.current;
        if (now < gd.learnUntil) {
          gd.echo = gd.echo ? Math.max(gd.echo * 0.7 + rms * 0.3, rms * 0.8) : rms;
          return false;
        }
        const margin = 10 ** (Math.max(0, Math.min(30, o.talkOverDb ?? 10)) / 20);
        const loud = rms > Math.max(0.012, gd.echo * margin);
        // The echo drifts (the voice gets louder, quieter): follow it, but not up into their speech.
        if (!loud) gd.echo += (rms - gd.echo) * 0.05;
        gd.loud = loud ? gd.loud + 1 : 0;
        if (gd.loud >= 2) gd.openUntil = now + 700;
        return now < gd.openUntil;
      };

      const source = ctx.createMediaStreamSource(mic.current);
      const capture = new AudioWorkletNode(ctx, "capture-processor");
      capture.port.onmessage = (e) => {
        const f = e.data as Float32Array;
        const pcm = new Int16Array(f.length);
        if (echoPass(f)) {
          for (let i = 0; i < f.length; i++) {
            const v = Math.max(-1, Math.min(1, f[i]));
            pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
          }
        } // else: silence, so the stream (and the speech detector's clock) keeps going.
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) }));
        }
      };
      source.connect(capture);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      capture.connect(mute).connect(ctx.destination);
    } catch (err) {
      clearTimeout(idleTimer.current);
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access was denied. Everything else works without it."
          : String(err),
      );
      setState("error");
    }
  }, [send, commitVoice, stillHere, path, note, setGain, cutOff]);

  useEffect(() => stop, [stop]);

  return { state, error, caption, heard, turns, log, clearLog, start, stop, send };
}
