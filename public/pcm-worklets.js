// AudioWorklet processors for the Inworld realtime bridge.
// Both run in a 24 kHz AudioContext, so no resampling is needed here.

/** Mic capture: batches ~40 ms of mono float samples and posts them to the main thread. */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = 960; // 40 ms @ 24 kHz
    this.buf = new Float32Array(this.chunk);
    this.i = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let n = 0; n < ch.length; n++) {
      this.buf[this.i++] = ch[n];
      if (this.i === this.chunk) {
        this.port.postMessage(this.buf.slice(0), []);
        this.i = 0;
      }
    }
    return true;
  }
}

/**
 * Playback: a jitter buffer fed with Float32 chunks from the server. Applies a
 * 48-sample fade at the head and tail of each queued chunk to avoid clicks, and
 * supports an instant flush for barge-in interruptions.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "chunk") {
        const f = msg.data;
        const fade = Math.min(48, f.length >> 1);
        for (let n = 0; n < fade; n++) {
          f[n] *= n / fade;
          f[f.length - 1 - n] *= n / fade;
        }
        this.queue.push(f);
      } else if (msg.type === "flush") {
        this.queue.length = 0;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let written = 0;
    while (written < out.length && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(out.length - written, head.length - this.offset);
      out.set(head.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (written < out.length) out.fill(0, written);

    const nowPlaying = this.queue.length > 0 || written > 0;
    if (nowPlaying !== this.playing) {
      this.playing = nowPlaying;
      this.port.postMessage({ type: "playing", value: nowPlaying });
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
registerProcessor("playback-processor", PlaybackProcessor);
