import { HANGUP_TONE } from "../renderer/voice/call-sounds-params";
import { synthesizeHangUp } from "../renderer/voice/call-sounds-synth";
import { fromInt16 } from "./resample";

/** The Bot's voice arrives as 16-bit 24 kHz mono. */
export const OUT_RATE = 24_000;
/** How far ahead of "now" a new stretch of the Bot's voice is scheduled: enough to ride out network jitter. */
export const LEAD_S = 0.12;

export interface AudioStats {
  micChunks: number;
  micPeak: number;
  audioChunks: number;
  /** Loudest sample received from the Mac (0..1). */
  audioPeak: number;
  /** Loudest sample seen at the output (after scheduling; 0..1) — proves it really played. */
  playedPeak: number;
  flushes: number;
  lastTone: string | null;
  tonePeak: number;
}

/**
 * Bug 198: the phone's call audio. Microphone: getUserMedia with the browser's own echo
 * cancellation → the capture worklet (16 kHz) → `onMic`. The Bot: chunks are scheduled back to back
 * on the page's AudioContext, a small lead ahead of now; `flush()` (a barge-in on the Mac) stops
 * everything already scheduled at once. The output passes an analyser, which drives the avatar's
 * mouth and proves the audio played.
 */
export class PhoneAudio {
  ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private outGain: GainNode | null = null;
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private meter: ReturnType<typeof setInterval> | null = null;
  private samples = new Float32Array(1024);
  level = 0;
  stats: AudioStats = { micChunks: 0, micPeak: 0, audioChunks: 0, audioPeak: 0, playedPeak: 0, flushes: 0, lastTone: null, tonePeak: 0 };

  /** Must run inside the tap that starts the call (iOS only lets audio start from a gesture). */
  async start(onMic: (pcm: ArrayBuffer) => void): Promise<void> {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error("audio");
    const ctx = new AC({ latencyHint: "interactive" });
    this.ctx = ctx;
    const resumed = ctx.resume().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.stream = stream;
    await resumed;
    await ctx.audioWorklet.addModule("/worklet.js");
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "mic-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
      this.stats.micChunks++;
      this.stats.micPeak = Math.max(this.stats.micPeak, e.data.peak);
      onMic(e.data.pcm);
    };
    // Safari only runs a worklet that is connected onward: through a silent gain, never to the ear.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    this.node = node;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.outGain = ctx.createGain();
    // Tests run muted (a page flag); the analyser sits before the gain, so it still hears everything.
    this.outGain.gain.value = (window as unknown as { __PHONE_TEST_MUTE?: boolean }).__PHONE_TEST_MUTE ? 0 : 1;
    this.analyser.connect(this.outGain);
    this.outGain.connect(ctx.destination);
    this.meter = setInterval(() => this.measure(), 50);
  }

  private measure(): void {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let peak = 0;
    for (const s of this.samples) peak = Math.max(peak, Math.abs(s));
    this.level = this.level * 0.6 + Math.min(1, peak * 2.2) * 0.4;
    if (this.stats.lastTone) this.stats.tonePeak = Math.max(this.stats.tonePeak, peak);
    else this.stats.playedPeak = Math.max(this.stats.playedPeak, peak);
  }

  /** One chunk of the Bot's voice. */
  play(chunk: ArrayBuffer): void {
    const ctx = this.ctx;
    if (!ctx || !this.analyser) return;
    const s = fromInt16(chunk);
    if (!s.length) return;
    this.stats.audioChunks++;
    for (const x of s) this.stats.audioPeak = Math.max(this.stats.audioPeak, Math.abs(x));
    const buf = ctx.createBuffer(1, s.length, OUT_RATE);
    buf.getChannelData(0).set(s);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    const at = Math.max(this.next, ctx.currentTime + LEAD_S);
    src.start(at);
    this.next = at + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** The Bot was cut off on the Mac: what is queued here goes too. */
  flush(): void {
    this.stats.flushes++;
    for (const s of this.sources) { try { s.stop(); } catch { /* already done */ } }
    this.sources.clear();
    this.next = 0;
  }

  get playing(): boolean { return this.sources.size > 0; }

  mute(muted: boolean): void {
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !muted;
  }

  /** The hang-up tone (the same one the Mac plays), then everything stops. */
  async hangUp(withTone: boolean): Promise<void> {
    this.flush();
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    const ctx = this.ctx;
    if (ctx && withTone && this.analyser) {
      this.stats.lastTone = "hangup";
      const pcm = synthesizeHangUp(HANGUP_TONE, ctx.sampleRate);
      const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
      buf.getChannelData(0).set(pcm);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.analyser);
      src.start();
      await new Promise((r) => setTimeout(r, buf.duration * 1000 + 150));
    }
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    this.analyser = null;
    this.ctx = null;
    await ctx?.close().catch(() => {});
  }
}
