import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIMITS5, buildSttContext } from "@synapse/shared";
import { emitNative, registerNative } from "../native";
import { deviceArgs, validVoiceId, type AudioPrefs } from "./audio-devices";
import { chimePcm } from "./chimes";
import { kokoroVoiceId, plainProsody, prosodyFrom, qwenProsody, withProsody, type KokoroHandlers, type NaturalTts, type Prosody } from "./kokoro";
import { f5VoiceId } from "./f5";
import { chooseEngine, qwenVoiceId, targetRmsFor, type QwenTts } from "./qwen";
import type { PhraseCache } from "./voice-cache";
import type { MicAccess } from "./privacy";
import type { LmCache } from "./stt-lm";
import type { LatencyHooks } from "./voice-latency";
import { WHISPER_STOP_WAIT_MS } from "./stt-whisper";

export type DictationEvent =
  | { type: "ready" }
  | { type: "audio" }
  | { type: "speech-start" }
  // Plan item 5 (call-behaviour): the utterance speech-start opened ended with no words (older helpers never send it).
  | { type: "speech-drop" }
  | { type: "barge-in" }
  | { type: "audio-restart"; reason: string }
  | { type: "speak-start"; id: string }
  | { type: "speak-end"; id: string; interrupted: boolean }
  // Voice calls: the first audio of a line went out (latency), and the call's levels (~10/s).
  | { type: "speak-audio"; id: string }
  | { type: "level"; mic: number; out: number | null }
  | { type: "muted"; muted: boolean }
  // Bug 105: which devices the session is really using, and changes to them.
  | { type: "devices"; input: DeviceRef | null; output: DeviceRef | null; echoCancellation: boolean }
  | { type: "device-fallback"; kind: "input" | "output"; uid: string; name: string; fallback: string }
  | { type: "device-restored"; kind: "input" | "output"; uid: string; name: string }
  | { type: "echo-unavailable"; reason: string }
  // Bug 134: the output couldn't run in stereo; spatial voices stay off (mono, as before).
  | { type: "spatial-unavailable"; reason: string }
  // Bug 213: where the call's voices are placed on the current output (the headset / speakers / centred),
  // and the microphone opened to keep a Bluetooth headset in stereo (input null = back to the usual one).
  | { type: "route"; mode: "headphones" | "speakers" | "centre"; stereo: boolean; output: DeviceRef | null; transport: string; channels: number }
  | { type: "mic-choice"; input: DeviceRef | null; instead: DeviceRef | null; reason: string }
  | { type: "partial"; text: string }
  // Bug 142: the utterance is probably complete (the reply may start early); the final still follows.
  | { type: "likely-end"; text: string }
  // Bug 165: which engine's words these are ("apple" | "whisper") and what the re-transcription cost.
  // 5.8: `sinceVoiceMs` — how long before this final the user's voice stopped (the end of speech, for the latency record).
  | { type: "final"; text: string; engine?: string; whisperMs?: number; sinceVoiceMs?: number }
  // Bug 165: whisper finished loading (or could not). Log only — dictation works either way.
  | { type: "whisper"; ok: boolean; ms?: number; model?: string; reason?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "end" };

export interface DeviceRef { uid: string; name: string }
/**
 * A device event as one voice-log line. Device names carry the user's name ("Jane's AirPods") and a
 * Bluetooth id carries the hardware address, so neither is written: each device is a short hash of
 * its id, stable for following one device through a session.
 */
export function deviceLogLine(e: Extract<DictationEvent, { type: "devices" | "device-fallback" | "device-restored" | "echo-unavailable" }>): string {
  const id = (d: { uid: string } | null) => (d ? `#${createHash("sha256").update(d.uid).digest("hex").slice(0, 6)}` : "none");
  switch (e.type) {
    case "devices": return `devices input=${id(e.input)} output=${id(e.output)} echo=${e.echoCancellation ? "on" : "off"}`;
    case "device-fallback": return `device-fallback ${e.kind} ${id(e)} → default`;
    case "device-restored": return `device-restored ${e.kind} ${id(e)}`;
    case "echo-unavailable": return `echo-unavailable ${e.reason.replace(/[^\w .,-]/g, "").slice(0, 80)}`;
  }
}

const deviceRef = (v: unknown): DeviceRef | null => {
  const d = v as { uid?: unknown; name?: unknown } | null;
  return d && typeof d.uid === "string" && typeof d.name === "string" ? { uid: d.uid, name: d.name } : null;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseDictationLine(line: string): DictationEvent | null {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    switch (e.type) {
      case "ready": case "end": case "audio": case "speech-start": case "speech-drop": case "barge-in": return { type: e.type };
      case "audio-restart": return typeof e.reason === "string" ? { type: e.type, reason: e.reason } : null;
      case "speak-start": return typeof e.id === "string" ? { type: e.type, id: e.id } : null;
      case "speak-end": return typeof e.id === "string" ? { type: e.type, id: e.id, interrupted: e.interrupted === true } : null;
      case "speak-audio": return typeof e.id === "string" ? { type: e.type, id: e.id } : null;
      case "level":
        if (typeof e.mic !== "number" || !Number.isFinite(e.mic)) return null;
        return { type: e.type, mic: e.mic, out: typeof e.out === "number" && Number.isFinite(e.out) ? e.out : null };
      case "muted": return { type: e.type, muted: e.muted === true };
      case "devices": return { type: e.type, input: deviceRef(e.input), output: deviceRef(e.output), echoCancellation: e.echoCancellation === true };
      case "device-fallback":
        if ((e.kind !== "input" && e.kind !== "output") || typeof e.uid !== "string") return null;
        return { type: e.type, kind: e.kind, uid: e.uid, name: str(e.name), fallback: str(e.fallback) };
      case "device-restored":
        if ((e.kind !== "input" && e.kind !== "output") || typeof e.uid !== "string") return null;
        return { type: e.type, kind: e.kind, uid: e.uid, name: str(e.name) };
      case "echo-unavailable": case "spatial-unavailable": return { type: e.type, reason: str(e.reason) };
      case "route":
        if (e.mode !== "headphones" && e.mode !== "speakers" && e.mode !== "centre") return null;
        return { type: e.type, mode: e.mode, stereo: e.stereo === true, output: deviceRef(e.output), transport: str(e.transport), channels: typeof e.channels === "number" && Number.isFinite(e.channels) ? e.channels : 0 };
      case "mic-choice": return { type: e.type, input: deviceRef(e.input), instead: deviceRef(e.instead), reason: str(e.reason) };
      case "partial": case "likely-end": return typeof e.text === "string" ? { type: e.type, text: e.text } : null;
      case "final": {
        if (typeof e.text !== "string") return null;
        // Bug 165: the engine and its cost ride along when whisper was in the session; a helper
        // without whisper sends neither, and the event is exactly what it was before.
        const out: DictationEvent = { type: "final", text: e.text };
        if (e.engine === "apple" || e.engine === "whisper") out.engine = e.engine;
        if (typeof e.whisperMs === "number" && Number.isFinite(e.whisperMs)) out.whisperMs = e.whisperMs;
        if (typeof e.sinceVoiceMs === "number" && Number.isFinite(e.sinceVoiceMs) && e.sinceVoiceMs >= 0) out.sinceVoiceMs = e.sinceVoiceMs;
        return out;
      }
      case "whisper": {
        const out: DictationEvent = { type: "whisper", ok: e.ok === true };
        if (typeof e.ms === "number" && Number.isFinite(e.ms)) out.ms = e.ms;
        if (typeof e.model === "string") out.model = e.model;
        if (typeof e.reason === "string") out.reason = e.reason;
        return out;
      }
      case "error":
        if (typeof e.message !== "string") return null;
        return typeof e.code === "string" ? { type: "error", code: e.code, message: e.message } : { type: "error", message: e.message };
      default: return null;
    }
  } catch {
    return null;
  }
}

/**
 * Bug 198: a call placed from the user's phone. While `active()`, a call-mode helper is started with
 * `--remote-audio`: it never opens this Mac's microphone or speaker. The phone's microphone reaches it
 * through `feedRemote`; its output (`out` lines) and what it hears and says go to the phone here.
 */
export interface RemoteAudio {
  active(): boolean;
  /** The helper's call audio for the phone (16-bit LE, 24 kHz mono). */
  out(pcm: Buffer): void;
  /** Every event of a remote session (the renderer gets them too). */
  event(e: DictationEvent, sessionId: string): void;
  /** A line was handed to the helper to speak (the phone's caption). */
  line(text: string): void;
  /** Speech was cut off (hush): the phone drops what it has buffered. */
  flush(): void;
}

/** Bug 198: the most phone-mic audio main will hold for a helper that isn't reading (~256 KB ≈ 6 s). */
export const REMOTE_MIC_MAX_BUFFERED = 256 * 1024;

/** Bug 198: the helper writes its call audio as exactly this, so the hot path never parses JSON. */
const OUT_PREFIX = '{"type":"out","data":"';

/** A cached line goes to the helper in 0.5 s chunks (24 kHz float32), like the sidecar's frames. */
const PCM_CHUNK_BYTES = 12_000 * 4;

/** Bug 101: dictation = one utterance into the composer; call = voice mode (continuous, spoken replies). */
export type DictationMode = "dictation" | "call";

/** Helper arguments for a session: voice mode adds echo cancellation and the end-of-turn silence. */
export function helperArgs(mode: DictationMode, locale: string | undefined, devices?: AudioPrefs, voice?: string | null, contextFile?: string, lmDir?: string, whisper?: string[], remote = false, spatial = false, allowServer = false): string[] {
  // Bug 198: a phone call has the phone's echo cancellation and no Mac devices at all.
  const args = mode === "call" ? ["--mode", "call", ...(remote ? ["--remote-audio"] : ["--voice-processing"]), "--silence-ms", String(LIMITS5.voiceSilenceMs)] : []; // the helper defaults to dictation
  // Bug 106: a call speaks, so it gets the chosen voice up front and warms it before the first reply.
  // Bug 107 / 164: a prefixed choice ("kokoro:", "qwen3:", "f5:") is never an Apple voice identifier.
  // Only `kokoro:` was stripped here, so a Settings → Voice choice of a Qwen or cloned voice started
  // the helper with `--voice qwen3:vivian` — an id AVSpeechSynthesizer has never heard of, which it
  // answers by quietly picking some other voice. The per-line guard below already checked all three;
  // it was only the session's own argv that did not.
  if (mode === "call" && validVoiceId(voice) && !/^(kokoro|qwen3|f5):/.test(voice)) args.push("--voice", voice);
  if (locale) args.push("--locale", locale);
  // Bug 162: the session's names go in a file, not argv — a few hundred contacts would blow the
  // argv size limit, and the helper reads the file once at start.
  if (contextFile) args.push("--context-file", contextFile);
  // Bug 162: the compiled model of those names, when one has already been built for this vocabulary.
  if (lmDir) args.push("--lm-dir", lmDir);
  // Bug 165: whisper re-transcribes each finished utterance. Passing nothing is how Light mode (and
  // a missing model, and a helper built without whisper) all arrive at the same place: no load, no
  // memory, no change to the path a word takes from the microphone to the screen.
  if (whisper?.length) args.push(...whisper);
  // Bug 213: a call that starts as a group call is stereo, with the seats, from its start. A 1:1 call
  // (and a phone call) stays exactly as it was: mono, voice processing, no mic swap.
  if (spatial && mode === "call" && !remote) args.push("--spatial");
  // 0.1.4 first-run: only the user's opt-in lets speech go to Apple's servers (Settings → Voice, or the notice).
  if (allowServer) args.push("--allow-server-speech");
  // Bug 105: the chosen microphone (and, for a call, speaker); system default passes nothing.
  return devices && !remote ? [...args, ...deviceArgs(devices, mode)] : args;
}

/**
 * Bug 162: write the session's contextual strings where the helper can read them. Returns the path,
 * or null if the list is empty or the write failed — a session with no bias still works, so this
 * never throws and never blocks the microphone.
 */
export function writeContextFile(strings: string[], dir: string, sessionId: string): string | null {
  if (strings.length === 0) return null;
  const file = path.join(dir, `synapse-stt-context-${sessionId}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ strings }), { encoding: "utf8", mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** P5 review minor: the dictation locale is a BCP-47-style tag (en-US, zh_Hans_CN), never a flag or free text. */
export function validLocale(l: unknown): l is string {
  return typeof l === "string" && l.length <= 35 && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(l);
}

/** Session ids are minted by the renderer, so keep them to a short, inert shape. */
export function validSessionId(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
}

export function registerDictation(o: {
  binary: string; spawnFn?: typeof spawn; micAccess?: () => Promise<MicAccess>; log?: (line: string) => void;
  /** Bug 105: the persisted device choice, read at every session start. */
  devices?: () => AudioPrefs;
  /** Bug 105: the helper saw the device set change (a device dropped out or came back). */
  onDeviceEvent?: () => void;
  /** Bug 106: the voice chosen in Settings → Voice, read at every call start (null = the best installed). */
  voice?: () => string | null;
  /** Bug 107: the natural (Kokoro) voice; its PCM is played by the helper. Absent = Apple only. */
  tts?: NaturalTts;
  /** Bug 162: where the session's contextual-strings file is written (tests point this at a sandbox). */
  tmpDir?: string;
  /** Bug 162: the cache of compiled custom language models. Absent = contextual strings only. */
  lm?: LmCache;
  /** Bug 165: the whisper arguments for a session, or []. Absent = whisper off, as in Light mode. */
  whisper?: (mode: DictationMode) => string[];
  /** The cloned-voice engine (F5). Absent until the user records a voice. */
  f5?: NaturalTts;
  /** Bug 164: the Qwen3 engine. Absent, or not allowed by the voice mode, and no Bot uses it. */
  qwen?: QwenTts;
  /** Wake word: dictation or a call has the microphone (true) / has let it go (false). */
  onActive?: (active: boolean) => void;
  /** Bug 134: pre-rendered call lines (greetings, fillers…) in each Bot's Kokoro voice, played from this Mac. */
  phrases?: PhraseCache;
  /** Bug 134: a line finished synthesizing (the pre-renderer may use the sidecar now). */
  onTtsIdle?: () => void;
  /** Bug 151: the question-intonation ramp (Kokoro's own is flat). Default: on, off with SYNAPSE_TTS_PROSODY=0. */
  prosody?: () => Prosody;
  /** Bug 198: a phone call's audio path (Phone access). Absent = every call uses this Mac. */
  remote?: RemoteAudio;
  /** 0.1.4 first-run: the user allowed Apple's servers for speech (read at every session start). Absent = never. */
  serverSpeech?: () => boolean;
  /** 5.8: a call's reply timings (voice-latency.ts). Absent = not recorded. */
  latency?: LatencyHooks;
}): { switchDevices(p: AudioPrefs): void; feedRemote(pcm: Buffer): boolean; remoteLive(): boolean; muteRemote(muted: boolean): void } {
  const log = o.log ?? ((line: string) => console.warn(line));
  const prosody = o.prosody ?? (() => prosodyFrom());
  let child: ChildProcess | null = null;
  /** Helpers we told to stop: their SIGTERM / SIGKILL exit is ours, not a crash. */
  const stopRequested = new WeakSet<ChildProcess>();
  /** Bug 185: helpers running whisper, whose stop may still be finishing a long turn's final. */
  const withWhisper = new WeakSet<ChildProcess>();
  /**
   * Bug 185: helpers told to stop that are still flushing their last final (with whisper on, up to
   * WHISPER_STOP_WAIT_MS). They are no longer `child`: a new session may start at once without
   * superseding them, and their remaining events still reach their OWN session until they close.
   */
  const flushing = new WeakSet<ChildProcess>();
  let session: string | null = null;
  /** Whether the current session has already told its consumer that it ended. */
  let sessionEnded = false;

  /**
   * Stop a helper for good. Graceful first — `stop\n` makes it flush its final transcript and
   * exit — but a helper that ignores stdin (or wedges inside Apple's recognizer) would otherwise
   * keep the microphone hot forever, so the stop escalates to SIGTERM and then SIGKILL.
   */
  function shutdown(c: ChildProcess, graceful: boolean): void {
    stopRequested.add(c);
    if (graceful) c.stdin?.write("stop\n");
    else c.stdin?.end();
    let killer: NodeJS.Timeout | undefined;
    // Bug 185: a graceful stop of a whisper session waits for its last final (bounded by the
    // helper's own budgets); a superseded helper's words belong to nobody, so it gets no extra time.
    const grace = LIMITS5.dictationStopGraceMs + (graceful && withWhisper.has(c) ? WHISPER_STOP_WAIT_MS : 0);
    const term = setTimeout(() => {
      if (typeof c.exitCode === "number" || typeof c.signalCode === "string") return; // already gone
      try { c.kill("SIGTERM"); } catch { /* already gone */ }
      killer = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* already gone */ } }, LIMITS5.dictationKillGraceMs);
      killer.unref?.();
    }, grace);
    term.unref?.();
    c.once("close", () => { clearTimeout(term); if (killer) clearTimeout(killer); });
  }

  /** Bumped by every start, so a start still waiting on the macOS prompt knows it was superseded. */
  let latestStart = 0;

  registerNative("dictation.start", (a: { locale?: string; sessionId?: string; mode?: DictationMode; context?: unknown; spatial?: unknown }) => {
    if (a.locale !== undefined && a.locale !== "" && !validLocale(a.locale)) throw new Error("That dictation language isn't valid.");
    if (a.mode !== undefined && a.mode !== "dictation" && a.mode !== "call") throw new Error("That dictation mode isn't valid.");
    const mode: DictationMode = a.mode ?? "dictation";
    // Bug 107: a call is about to speak — load and warm Kokoro in the background now (never awaited).
    // Bug 134: its voices' accents are built first; the greeting meanwhile plays from the PCM cache.
    if (mode === "call") o.tts?.warm(Array.isArray((a as { voices?: unknown }).voices) ? ((a as { voices: unknown[] }).voices).filter((v): v is string => typeof v === "string").slice(0, 8) : undefined);
    if (a.sessionId !== undefined && !validSessionId(a.sessionId)) throw new Error("That dictation session isn't valid.");
    const sessionId = a.sessionId ?? randomUUID();
    // Bug 162: the renderer knows the Bot names, the open chat's vocabulary and the contacts it has
    // seen; it sends them raw and the cap and tidying happen here, so a wild list can't reach argv.
    const context = buildSttContext({ botNames: Array.isArray(a.context) ? (a.context as unknown[]).filter((s): s is string => typeof s === "string") : [] });
    const ticket = ++latestStart;
    // Bug 198: a phone call never touches this Mac's microphone, so it never asks macOS for it.
    const remote = mode === "call" && o.remote?.active() === true;
    const spatial = a.spatial === true;
    if (!o.micAccess || remote) { begin(sessionId, a.locale, mode, context, remote, spatial); return { sessionId }; }
    // Bug 99: check the microphone BEFORE spawning the helper — ask when macOS never has (the
    // system prompt appears), and report denied / restricted as a permission fault the renderer
    // shows with a button to the Microphone pane. Never a silent dead microphone.
    return o.micAccess().then((access) => {
      if (ticket !== latestStart) {
        // A newer start arrived while this one waited on the prompt; the newest gesture wins.
        emitNative("dictation", { type: "end", sessionId });
      } else if (access !== "granted") {
        emitNative("dictation", { type: "error", message: `permission:microphone:${access}`, sessionId });
        emitNative("dictation", { type: "end", sessionId });
      } else {
        begin(sessionId, a.locale, mode, context, false, spatial);
      }
      return { sessionId };
    });
  });

  /** Bug 198: helpers running a phone call (their audio is the phone's). */
  const remoteHelpers = new WeakSet<ChildProcess>();
  /** Bug 198: phone-call helpers whose stdin is full; the phone's mic frames are dropped until it drains. */
  const remoteBlocked = new WeakSet<ChildProcess>();

  function begin(sessionId: string, locale: string | undefined, mode: DictationMode, context: string[] = [], remote = false, spatial = false): void {
    // One microphone, two possible consumers (the composer mic and the voice overlay): the newest
    // request wins, because it is the user's most recent gesture. The superseded consumer is told
    // its session ended — on its own session id — so its UI stops claiming to listen instead of
    // waiting for transcripts that now belong to somebody else.
    if (child) {
      const stale = child;
      const staleSession = session;
      const staleEnded = sessionEnded;
      child = null;
      session = null;
      // ... unless that session has already reported its own end (the helper flushed and is on its
      // way out); saying it twice would look like a second session ending.
      if (!staleEnded) emitNative("dictation", { type: "end", sessionId: staleSession });
      o.tts?.cancel(); // its lines died with it
      shutdown(stale, false);
    }
    o.onActive?.(true);
    // Bug 162: the names this session should expect. The file is this session's alone and goes when
    // the helper closes, so a crash leaves at most one small file behind.
    const contextFile = writeContextFile(context, o.tmpDir ?? os.tmpdir(), sessionId);
    // Bug 162: the compiled model of this vocabulary, if one is ready. Asking for it also starts the
    // build when it is not — in the background, so the microphone is never kept waiting.
    const lmDir = context.length ? o.lm?.dirFor(context, locale ?? "en-US") ?? null : null;
    const whisperArgs = o.whisper?.(mode) ?? [];
    const spawned = (o.spawnFn ?? spawn)(o.binary, helperArgs(mode, locale, o.devices?.(), o.voice?.(), contextFile ?? undefined, lmDir ?? undefined, whisperArgs, remote, spatial, o.serverSpeech?.() === true), { stdio: ["pipe", "pipe", "pipe"] });
    if (whisperArgs.length) withWhisper.add(spawned);
    if (remote) { remoteHelpers.add(spawned); log(`dictation[${sessionId.slice(0, 8)}] phone call: this Mac's microphone and speaker stay off`); }
    // A write to a helper that already exited must never take the main process down.
    if (remote) spawned.stdin?.on?.("error", () => { /* the close handler reports the exit */ });
    child = spawned;
    session = sessionId;
    sessionEnded = false;
    /** Whether this helper has already said what went wrong (an `error` line or a spawn error). */
    let reported = false;
    /** Whether this helper's own session has been told it ended (bug 185: it may outlive `child`). */
    let endedHere = false;
    let buf = "";
    // Bug 101: the helper narrates what it does on stderr. Log it (the field bug was invisible
    // without it) and keep the last line, so a helper that dies without an `error` event still
    // tells the user why.
    let errBuf = "";
    let lastErrLine = "";
    spawned.stderr?.on("data", (d: Buffer) => {
      errBuf += d.toString("utf8");
      let i: number;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (!line) continue;
        lastErrLine = line.replace(/^\[bots-dictation [^\]]*\]\s*/, "").slice(0, 300);
        log(`dictation[${sessionId.slice(0, 8)}] ${line.slice(0, 500)}`);
      }
      if (errBuf.length > 4096) errBuf = errBuf.slice(-4096);
    });
    spawned.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        // Bug 198: a phone call's audio goes to the phone — never to the renderer, never parsed as JSON.
        if (raw.startsWith(OUT_PREFIX)) {
          if (child === spawned && remoteHelpers.has(spawned)) o.remote?.out(Buffer.from(raw.slice(OUT_PREFIX.length, raw.lastIndexOf('"')), "base64"));
          continue;
        }
        const e = parseDictationLine(raw);
        // A stale child (superseded by a newer session) must never forward its own late-arriving
        // data onto the single shared "dictation" channel, and every event that is forwarded says
        // which session it belongs to, so the consumer that didn't ask for it can ignore it.
        if (e && (child === spawned || flushing.has(spawned))) {
          if (e.type === "end") { endedHere = true; if (child === spawned) sessionEnded = true; }
          if (e.type === "barge-in") o.tts?.cancel();
          // 5.8: a call's reply timings — the end of turn (and how long ago the voice stopped), and a line's first audio out.
          if (mode === "call" && child === spawned) {
            if (e.type === "final") o.latency?.final(e.sinceVoiceMs);
            else if (e.type === "speak-audio") o.latency?.audio(e.id);
          }
          if (e.type === "error") { reported = true; log(`dictation[${sessionId.slice(0, 8)}] error ${e.code ?? ""}: ${e.message}`); }
          if (e.type === "audio-restart") log(`dictation[${sessionId.slice(0, 8)}] audio restarted (${e.reason})`);
          if (e.type === "device-fallback" || e.type === "device-restored" || e.type === "echo-unavailable" || e.type === "devices") {
            log(`dictation[${sessionId.slice(0, 8)}] ${deviceLogLine(e)}`);
            if (e.type === "device-fallback" || e.type === "device-restored") o.onDeviceEvent?.();
          }
          if (remoteHelpers.has(spawned)) o.remote?.event(e, sessionId);
          emitNative("dictation", { ...e, sessionId });
        }
      }
    });
    spawned.on("error", (err) => {
      if (child !== spawned && !flushing.has(spawned)) return; // stale child; the active session owns the channel now
      reported = true;
      emitNative("dictation", { type: "error", message: String(err.message), sessionId });
    });
    spawned.on("close", (code: number | null, signal: string | null) => {
      // Bug 162: the helper read its names at start; the file has no further use. A stale child
      // cleans up its own file too, which is why this runs before the still-current check.
      if (contextFile) { try { fs.unlinkSync(contextFile); } catch { /* already gone */ } }
      // Only the still-current child may emit "end" and clear the shared ref — a stale close event
      // from a prior session must not be forwarded (it would be misread as the newer session ending)
      // and must not null out a newer, still-listening session's child.
      if (flushing.has(spawned)) {
        // Bug 185: a stopped helper that finished flushing. Its session ends now, on its own id;
        // the microphone is free only if no newer session has taken it meanwhile.
        if (!endedHere) emitNative("dictation", { type: "end", sessionId });
        endedHere = true;
        if (child === null) o.onActive?.(false);
        return;
      }
      if (child !== spawned) return;
      // Bug 99: a helper that dies without a word (macOS kills a process that touches the mic or
      // Speech without a usage string; a crash) must not look like a quiet end of dictation.
      if (!sessionEnded && !reported && !stopRequested.has(spawned) && (signal || (code ?? 0) !== 0)) {
        const why = lastErrLine || (errBuf.trim() ? errBuf.trim().slice(-300) : "");
        const how = signal ? `signal ${signal}` : `exit ${code}`;
        emitNative("dictation", { type: "error", code: "helper-exit", message: `The dictation helper stopped unexpectedly (${how})${why ? `: ${why}` : "."}`, sessionId });
      }
      if (!sessionEnded && !endedHere) emitNative("dictation", { type: "end", sessionId });
      sessionEnded = true;
      child = null;
      session = null;
      o.onActive?.(false);
    });
  }

  /** Only the current session's own consumer may drive its helper (voice mode vs the composer mic). */
  function own(sessionId: unknown): ChildProcess | null {
    return child && typeof sessionId === "string" && sessionId === session && !sessionEnded ? child : null;
  }

  // Bug 101: voice mode speaks the Bot's reply THROUGH the helper, so it plays out of the same
  // voice-processing audio unit the microphone uses and echo cancellation can subtract it.
  // `first`/`more`: where this line sits in its reply (bug 164). The renderer knows — it is what
  // split the reply into sentences — and the hybrid needs it to decide which engine opens.
  registerNative("dictation.speak", (a: { sessionId?: string; id?: unknown; text?: unknown; voice?: unknown; fallbackVoice?: unknown; rate?: unknown; lang?: unknown; queue?: unknown; pauseMs?: unknown; pauseMsQwen?: unknown; pan?: unknown; azimuth?: unknown; seat?: unknown; cache?: unknown; qwenBot?: unknown; reply?: unknown }) => {
    if (typeof a?.text !== "string" || a.text.length > LIMITS5.voiceSpeakMaxChars) throw new Error("That reply can't be spoken.");
    if (!validSessionId(a.id)) throw new Error("That speech id isn't valid.");
    const validPause = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000;
    if (a.pauseMs !== undefined && !validPause(a.pauseMs)) throw new Error("That pause isn't valid.");
    if (a.pauseMsQwen !== undefined && !validPause(a.pauseMsQwen)) throw new Error("That pause isn't valid.");
    const c = own(a.sessionId);
    if (!c?.stdin) return { spoken: false };
    if (remoteHelpers.has(c)) o.remote?.line(a.text);
    const id = a.id;
    // 5.8: a line of the Bot's reply (not the call's own "mm", filler or greeting): its first audio is the reply's.
    if (a.reply === true) o.latency?.line(id);
    const cmd: Record<string, unknown> = { id, text: a.text };
    const cloned = f5VoiceId(a.voice);
    const qwen = qwenVoiceId(a.voice);
    const natural = kokoroVoiceId(a.voice);
    if (typeof a.voice === "string" && a.voice.length <= 200 && !a.voice.startsWith("kokoro:") && !a.voice.startsWith("f5:") && !a.voice.startsWith("qwen3:")) cmd.voice = a.voice;
    if (typeof a.rate === "number" && Number.isFinite(a.rate) && a.rate > 0 && a.rate <= 4) cmd.rate = a.rate;
    if (validLocale(a.lang)) cmd.lang = a.lang;
    // Voice calls: the next sentence of a streamed reply plays after the one before, gaplessly.
    if (a.queue === true) cmd.queue = true;
    // Bug 107: a small pause after each sentence (the helper appends silence), so lines don't run together.
    if (typeof a.pauseMs === "number" && a.pauseMs > 0) cmd.pauseMs = a.pauseMs;
    // Bug 134: a group call places each Bot's lines at its seat in the stereo field.
    if (typeof a.pan === "number" && Number.isFinite(a.pan)) cmd.pan = Math.min(1, Math.max(-1, a.pan));
    // Bug 213: its seat as an angle (degrees, negative = left) and whose seat it is: on headphones each
    // Bot has its own HRTF player; on speakers the angle becomes the old gentle pan.
    if (typeof a.azimuth === "number" && Number.isFinite(a.azimuth)) cmd.azimuth = Math.min(90, Math.max(-90, a.azimuth));
    if (typeof a.seat === "string" && a.seat.length > 0) cmd.seat = a.seat.slice(0, 80);
    // Bug 107: a Kokoro voice. The helper opens a PCM line (it keeps the text, so it can still say it
    // with Apple's voice), Kokoro streams the audio in chunks, and every chunk goes to the helper as it
    // arrives — so the next sentence synthesizes while this one plays.
    const speed = typeof a.rate === "number" && Number.isFinite(a.rate) ? Math.min(2, Math.max(0.5, a.rate)) : 1;
    // A cloned voice renders a whole sentence before a word of it can play, so a live call
    // would start with a long silence. When F5 isn't warm yet, this line is said in the Bot's
    // Kokoro voice (the renderer passes it as `fallbackVoice`) and F5 warms for the next one.
    let engine = cloned ? o.f5 : qwen ? (o.qwen as NaturalTts | undefined) : o.tts;
    let voiceId = cloned ?? qwen ?? natural;
    // Decision 184: a Qwen voice speaks its WHOLE reply — never split. It falls back to the Bot's
    // Kokoro voice (the renderer passes it as `fallbackVoice`) only when Qwen is genuinely
    // unavailable, and then for the whole reply, so a call is never a mix of the two voices. Every
    // Qwen line is held to that same Kokoro voice's measured level, so a call that ever DOES fall
    // back mid-conversation (Qwen going unavailable) still sounds like the same Bot.
    let qwenTarget: number | undefined;
    // Bug 164: a pre-rendered line (a greeting, a filler) already exists in the Bot's OWN Qwen voice
    // — rendered at full quality when nothing was waiting on it — so it plays from the cache and the
    // check below never runs. Handing it to Kokoro instead would swap the voice on the one line the
    // user hears first, for no latency gained.
    // Bug 221: a Qwen take is keyed by the level it was held to — the Bot's own Kokoro voice's, as every live line of
    // it is — so a take at another level (±2.6 dB off the reply) is never played for it.
    const qwenLevel = qwen !== null ? targetRmsFor(a.fallbackVoice as string | null | undefined) : undefined;
    const qwenCached = qwen !== null && a.cache === true && o.phrases?.has(qwen, speed, a.text, qwenLevel) === true;
    if (qwen && !qwenCached) {
      // As early as the old opener warmed it: the first line of a reply that needs Qwen starts it
      // loading right away, so a cold call pays only Qwen's own first-audio time (bug 182: ~0.2-0.3 s
      // over the opener's, since Qwen is asked for even the opening line now).
      o.qwen?.warm([qwen]);
      const fb = kokoroVoiceId(a.fallbackVoice);
      const choice = chooseEngine({ qwenReady: o.qwen?.isReady() === true, fallback: fb !== null && o.tts !== undefined });
      if (choice.engine === "kokoro") {
        log(`dictation[${String(a.sessionId).slice(0, 8)}] Qwen is unavailable; ${id} said in the Bot's Kokoro voice`);
        engine = o.tts;
        voiceId = fb;
      } else {
        qwenTarget = targetRmsFor(a.fallbackVoice as string | null | undefined);
      }
    }
    // Bug 166: Qwen renders the beat after a sentence itself, and the chain now keeps it (tailMs), so
    // adding the Kokoro one on top of it was the double pause the user heard. The renderer sends both
    // and the engine that actually took the line picks — a Kokoro fallback line keeps the Kokoro pause.
    if (qwenTarget !== undefined && typeof a.pauseMsQwen === "number") {
      if (a.pauseMsQwen > 0) cmd.pauseMs = a.pauseMsQwen;
      else delete cmd.pauseMs;
    }
    if (cloned) {
      const ready = o.f5?.isReady() === true && o.f5.isWarm();
      if (!ready) {
        o.f5?.warm([cloned]);
        const fb = kokoroVoiceId(a.fallbackVoice);
        log(`dictation[${String(a.sessionId).slice(0, 8)}] cloned voice not warm; ${id} uses ${fb ? "the Bot's Kokoro voice" : "the Apple voice"}`);
        engine = fb ? o.tts : undefined;
        voiceId = fb;
      }
    }
    const tts = engine;
    // Bug 190: a Bot whose own voice is Qwen3 gets no question handling, whichever engine says the
    // line — its Qwen lines, and the lines its Kokoro stand-in says for a whole reply when Qwen is
    // unavailable (decision 184), or for the whole call once a short Mac drops it to Light mode, when
    // the renderer sends the Kokoro voice and says whose Bot it is with `qwenBot`). The stand-in's lines are never read from or
    // written to the phrase cache: a Kokoro Bot's take of the same words is ramped, under the same key.
    const qwenBot = qwen !== null || a.qwenBot === true;
    const standIn = qwenBot && qwenTarget === undefined && !qwenCached && tts === o.tts;
    // Bug 134: a line the call says by itself, already rendered in this Bot's voice: straight from the
    // cache — Kokoro needn't be loaded yet (an instant pick-up in the Bot's own voice).
    const cached = voiceId && a.cache === true && !standIn ? o.phrases?.get(voiceId, speed, a.text, voiceId === qwen ? qwenLevel : undefined) ?? null : null;
    if (voiceId && cached) {
      cmd.engine = "pcm";
      c.stdin.write(`speak ${JSON.stringify(cmd)}\n`);
      o.latency?.chunk(id);
      for (let i = 0; i < cached.length; i += PCM_CHUNK_BYTES) c.stdin.write(`pcm ${JSON.stringify({ id, data: cached.subarray(i, i + PCM_CHUNK_BYTES).toString("base64") })}\n`);
      c.stdin.write(`pcm-end ${JSON.stringify({ id })}\n`);
      return { spoken: true, cached: true };
    }
    if (voiceId && tts) {
      // Decision 184: Qwen is asked for even while cold — that is the whole point of dropping the
      // opener — so its line only needs `isReady()` (installed, probed, allowed); Kokoro and F5
      // still wait for `isWarm()`, since neither streams sensibly before then.
      if (tts.isReady() && (qwenTarget !== undefined || tts.isWarm())) {
        cmd.engine = "pcm";
        c.stdin.write(`speak ${JSON.stringify(cmd)}\n`);
        const sessionId = a.sessionId;
        const live = () => child === c && session === sessionId && !sessionEnded;
        // A call line asked to be kept (cache: true) is stored as it streams, for next time.
        const keep: Buffer[] | null = a.cache === true && o.phrases && !standIn ? [] : null;
        const text = a.text;
        // Bug 151: a Kokoro Bot's line that ENDS on a "?" gets the question ramp on its way to the
        // helper — Kokoro's own question intonation is flat (measured: 0.27 st from the statement, and
        // falling). Any other line, or the flag off, and these handlers are the ones below, untouched.
        // The cache keeps what the helper plays, so a cached question is already asked properly.
        // Bug 190: never for a Qwen Bot (see `qwenBot`).
        // Qwen needs two fields Kokoro has no use for: stream the codec (a live call is waiting on
        // it), and hold the line at this Bot's Kokoro level.
        const send = qwenTarget !== undefined && o.qwen
          ? (h: KokoroHandlers) => o.qwen!.synthQwen({ id, text, voice: voiceId!, speed, quality: "live", targetRms: qwenTarget }, h)
          : (h: KokoroHandlers) => tts.synth({ id, text, voice: voiceId!, speed }, h);
        send(withProsody(text, {
          audio: (pcm) => { keep?.push(Buffer.from(pcm)); if (live()) { o.latency?.chunk(id); c.stdin?.write(`pcm ${JSON.stringify({ id, data: pcm.toString("base64") })}\n`); } },
          done: () => {
            if (keep?.length) o.phrases!.put(voiceId, speed, text, Buffer.concat(keep), qwenTarget);
            if (live()) c.stdin?.write(`pcm-end ${JSON.stringify({ id })}\n`);
            o.onTtsIdle?.();
          },
          error: (message) => {
            log(`dictation[${String(sessionId).slice(0, 8)}] ${cloned ? "cloned voice" : qwenTarget !== undefined ? "qwen" : "kokoro"} failed on ${id}; fell back to Apple: ${message}`);
            o.onTtsIdle?.();
            if (!live()) return;
            c.stdin?.write(`pcm-fail ${JSON.stringify({ id })}\n`);
            emitNative("dictation", { type: "tts-fallback", message, sessionId });
          },
        }, qwenTarget !== undefined ? qwenProsody(prosody()) : qwenBot ? plainProsody(prosody()) : prosody()));
        return { spoken: true };
      }
      log(`dictation[${String(a.sessionId).slice(0, 8)}] ${cloned ? "cloned voice" : qwen ? "qwen" : "kokoro"} ${tts.isReady() ? "still warming up" : "unavailable"}; ${id} uses the Apple voice`);
      if (tts.isReady()) tts.warm();
    }
    // JSON.stringify escapes every newline, so the command is always exactly one stdin line.
    c.stdin.write(`speak ${JSON.stringify(cmd)}\n`);
    return { spoken: true };
  });
  // Bug 106: the renderer's side of a voice turn's latency (sent, first reply text…), in voice.log
  // next to the helper's own end-of-turn and first-audio-out lines, so a turn can be timed end to end.
  registerNative("dictation.mark", (a: { sessionId?: unknown; what?: unknown; ms?: unknown }) => {
    if (typeof a?.what !== "string" || !/^[a-z][a-z-]{0,31}$/.test(a.what)) throw new Error("Bad mark.");
    if (!validSessionId(a.sessionId)) throw new Error("That dictation session isn't valid.");
    const ms = typeof a.ms === "number" && Number.isFinite(a.ms) ? ` (+${Math.round(a.ms)} ms)` : "";
    log(`dictation[${a.sessionId.slice(0, 8)}] mark ${a.what}${ms}`);
    if (a.sessionId === session) o.latency?.mark(a.what);
    return {};
  });
  // Plan item 16 (call-behaviour): the Bot's last line asked something; the helper may end a short answer sooner.
  registerNative("dictation.expect", (a: { sessionId?: string }) => {
    own(a?.sessionId)?.stdin?.write("expect-answer\n");
    return {};
  });
  registerNative("dictation.hush", (a: { sessionId?: string }) => {
    const c = own(a?.sessionId);
    if (c) o.tts?.cancel();
    c?.stdin?.write("hush\n");
    if (c && remoteHelpers.has(c)) o.remote?.flush();
    return {};
  });
  // Bug 134: a group call's voices in stereo seats (2+ Bots), or back to mono.
  registerNative("dictation.spatial", (a: { sessionId?: string; on?: unknown }) => {
    if (typeof a?.on !== "boolean") throw new Error("Bad spatial.");
    own(a.sessionId)?.stdin?.write(a.on ? "spatial on\n" : "spatial off\n");
    return {};
  });
  // Bug 213 (review): the Bots on a group call, so a Bot that left gives its headphone seat back.
  registerNative("dictation.seats", (a: { sessionId?: string; ids?: unknown }) => {
    if (!Array.isArray(a?.ids)) throw new Error("Bad seats.");
    const ids = a.ids.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80).slice(0, 12);
    own(a.sessionId)?.stdin?.write(`seats ${JSON.stringify({ ids })}\n`);
    return {};
  });
  // Bug 134: the join / leave chime, on the helper's own sound player (never the speech queue).
  registerNative("dictation.chime", (a: { sessionId?: string; kind?: unknown }) => {
    if (a?.kind !== "join" && a?.kind !== "leave") throw new Error("Unknown sound.");
    own(a.sessionId)?.stdin?.write(`fx ${JSON.stringify({ data: chimePcm(a.kind).toString("base64") })}\n`);
    return {};
  });
  registerNative("dictation.mute", (a: { sessionId?: string; muted?: unknown }) => {
    if (typeof a?.muted !== "boolean") throw new Error("Bad mute.");
    own(a.sessionId)?.stdin?.write(a.muted ? "mute\n" : "unmute\n");
    return {};
  });

  registerNative("dictation.stop", (a: { sessionId?: string }) => {
    // Scoped: a consumer whose session was already superseded must not stop the session that took
    // the microphone from it.
    if (a?.sessionId !== undefined && a.sessionId !== session) return {};
    if (child) {
      o.tts?.cancel();
      const c = child;
      shutdown(c, true);
      // Bug 185: the helper is flushing, not superseded. Let go of it now, so a session started in
      // the next seconds (the mic again, a call) never SIGTERMs it and loses the speech's last final.
      if (!sessionEnded) flushing.add(c);
      child = null;
      session = null;
    }
    return {};
  });

  return {
    // Bug 105: a new device choice reaches the running session without ending it — the helper
    // rebuilds its audio path in place (voice mode stays in the call; dictation keeps its words).
    switchDevices(p: AudioPrefs): void {
      if (!child || sessionEnded || !child.stdin || remoteHelpers.has(child)) return;
      child.stdin.write(`devices ${JSON.stringify({ input: p.input, output: p.output })}\n`);
    },
    // Bug 198: one chunk of the phone's microphone (16-bit LE, 16 kHz mono) for the phone call's helper.
    // Between two helpers (the call brings a new one up after one exits) there is nobody to hear it.
    // Backpressure: a helper that isn't reading (busy, wedged) never makes main buffer the phone's
    // audio without bound — frames are dropped while its stdin is full (write() said so, or over
    // REMOTE_MIC_MAX_BUFFERED), until it drains. A dropped 100 ms of mic is a blip; a runaway buffer is not.
    feedRemote(pcm: Buffer): boolean {
      const c = child;
      if (!c || sessionEnded || !c.stdin || !remoteHelpers.has(c) || pcm.length === 0 || pcm.length % 2 !== 0) return false;
      if (remoteBlocked.has(c) || (c.stdin.writableLength ?? 0) > REMOTE_MIC_MAX_BUFFERED) return false;
      if (c.stdin.write(`mic ${pcm.toString("base64")}\n`) === false) {
        remoteBlocked.add(c);
        c.stdin.once?.("drain", () => remoteBlocked.delete(c));
      }
      return true;
    },
    remoteLive(): boolean {
      return child !== null && !sessionEnded && remoteHelpers.has(child);
    },
    /** Bug 198: the phone's mute button (the helper finishes the turn in progress and drops the audio). */
    muteRemote(muted: boolean): void {
      if (child && !sessionEnded && child.stdin && remoteHelpers.has(child)) child.stdin.write(muted ? "mute\n" : "unmute\n");
    },
  };
}
