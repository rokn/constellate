import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenContext, UiCommand } from "../../shared/types";

/**
 * The browser end of the voice: mic capture and playback at 24 kHz through
 * AudioWorklets, barge-in, captions, and the commands the voice issues. The
 * session itself lives in server/voice.ts; this only carries audio and tells
 * it what is on screen.
 */

export type VoiceState = "idle" | "connecting" | "listening" | "speaking" | "error";
export type Turn = { role: "user" | "voice"; text: string };

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

export function useVoice({ screen, onCommand }: { screen: ScreenContext; onCommand: (cmd: UiCommand) => void }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [heard, setHeard] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);

  const ws = useRef<WebSocket | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const playback = useRef<AudioWorkletNode | null>(null);
  const partial = useRef({ user: "", voice: "" });
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const screenRef = useRef(screen);

  const send = useCallback((obj: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(obj));
  }, []);

  // Whatever changes on screen reaches the voice's instructions.
  const screenKey = JSON.stringify(screen);
  useEffect(() => {
    screenRef.current = screen;
    send({ type: "proxy.screen", screen });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenKey, send]);

  const commitVoice = useCallback(() => {
    const text = partial.current.voice.trim();
    partial.current.voice = "";
    setCaption("");
    if (text) setTurns((t) => [...t.slice(-30), { role: "voice", text }]);
  }, []);

  const stop = useCallback(() => {
    ws.current?.close();
    ws.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    void audio.current?.close();
    audio.current = null;
    playback.current = null;
    setState("idle");
    setHeard("");
    commitVoice();
  }, [commitVoice]);

  const start = useCallback(async () => {
    setError(null);
    setState("connecting");
    try {
      mic.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext({ sampleRate: 24000 });
      audio.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-worklets.js");

      const play = new AudioWorkletNode(ctx, "playback-processor", { outputChannelCount: [1] });
      play.connect(ctx.destination);
      play.port.onmessage = (e) => {
        if (e.data?.type === "playing") setState(e.data.value ? "speaking" : "listening");
      };
      playback.current = play;

      const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice`);
      ws.current = socket;
      socket.onopen = () => socket.send(JSON.stringify({ type: "proxy.screen", screen: screenRef.current }));
      socket.onerror = () => {
        setError("The voice connection failed.");
        setState("error");
      };
      socket.onclose = () => setState((s) => (s === "error" ? s : "idle"));
      socket.onmessage = (e) => {
        const msg = JSON.parse(e.data as string);
        switch (msg.type) {
          case "proxy.status":
            if (msg.status === "ready") {
              setState("listening");
              send({
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "[system] They just switched the voice on. If the map is charted, open in a sentence or two with what this codebase is and offer the tour or a topic; if it is still being charted, say so in one line. No greeting, no introduction." }],
                },
              });
              send({ type: "response.create" });
            } else if (msg.status === "error") {
              setError(msg.message ?? "Voice error");
              setState("error");
            }
            return;
          case "proxy.error":
            setError(msg.message);
            setState("error");
            return;
          case "proxy.command":
            onCommandRef.current(msg.cmd as UiCommand);
            return;
          case "input_audio_buffer.speech_started":
            // Barge-in: drop what is queued for playback and cancel the response.
            playback.current?.port.postMessage({ type: "flush" });
            send({ type: "response.cancel" });
            commitVoice();
            setState("listening");
            return;
          case "conversation.item.input_audio_transcription.delta":
            partial.current.user += msg.delta ?? "";
            setHeard(partial.current.user);
            return;
          case "conversation.item.input_audio_transcription.completed": {
            const text = (msg.transcript ?? partial.current.user).trim();
            partial.current.user = "";
            setHeard("");
            if (text) setTurns((t) => [...t.slice(-30), { role: "user", text }]);
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
            commitVoice();
            return;
        }
      };

      const source = ctx.createMediaStreamSource(mic.current);
      const capture = new AudioWorkletNode(ctx, "capture-processor");
      capture.port.onmessage = (e) => {
        const f = e.data as Float32Array;
        const pcm = new Int16Array(f.length);
        for (let i = 0; i < f.length; i++) {
          const v = Math.max(-1, Math.min(1, f[i]));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ type: "input_audio_buffer.append", audio: toBase64(pcm) }));
        }
      };
      source.connect(capture);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      capture.connect(mute).connect(ctx.destination);
    } catch (err) {
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access was denied. Everything else works without it."
          : String(err),
      );
      setState("error");
    }
  }, [send, commitVoice]);

  useEffect(() => stop, [stop]);

  return { state, error, caption, heard, turns, start, stop };
}
