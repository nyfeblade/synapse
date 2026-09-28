import { spawn, type ChildProcess } from "node:child_process";
import { emitNative, registerNative } from "../native";
import { PREVIEW_PHRASE, kokoroVoiceId, prosodyFrom, qwenProsody, withProsody, type NaturalTts } from "./kokoro";
import { qwenVoiceId, type QwenTts } from "./qwen";
import type { PhraseCache } from "./voice-cache";

/**
 * Bug 105: choosing the microphone and speaker for dictation and voice mode. The dictation helper
 * does the CoreAudio work (`--list-devices`, `--input-device` / `--output-device`, `--meter`,
 * `--test-speaker`); this module lists and caches devices, persists the choice, and hands it to
 * every session.
 */
export const TRANSPORTS = ["built-in", "usb", "bluetooth", "bluetooth-le", "hdmi", "displayport", "airplay", "thunderbolt", "pci", "firewire", "virtual", "aggregate", "continuity", "unknown"] as const;
export type Transport = (typeof TRANSPORTS)[number];
export interface AudioDevice { uid: string; name: string; input: boolean; output: boolean; transport: Transport; defaultInput: boolean; defaultOutput: boolean; /** Bug 151: the OS gave this device no name yet, so `name` is a label we made from its UID. */ unnamed?: true }
/** A device UID per direction; null = follow the system default. */
export interface AudioPrefs { input: string | null; output: string | null }
export type HelperUse = "dictation" | "call" | "meter" | "speaker";
export type DeviceKind = "input" | "output";

/** CoreAudio UIDs are printable strings; never a flag, never multi-line, bounded. */
export function validDeviceUid(u: unknown): u is string {
  return typeof u === "string" && u.length > 0 && u.length <= 256 && !u.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(u);
}

/**
 * Bug 151: a Bluetooth headset's name is often empty, or arrives seconds after the device does
 * ("00-00-5E-00-53-01:input" with name ""). A missing name says nothing about whether the device is
 * there, so it is never a reason to drop it or to fall back — it only decides what we call it.
 */
export function namedDevice(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0;
}

const MAC_UID = /^[0-9a-f]{2}([-:][0-9a-f]{2}){5}$/i;

/** What to show and say for a device the OS hasn't named: never blank, never used for matching. */
export function deviceLabel(d: { uid: string; name?: unknown; transport?: string }): string {
  if (namedDevice(d.name)) return d.name.trim();
  const id = d.uid.replace(/:(input|output)$/i, "").slice(0, 40);
  const bluetooth = d.transport === "bluetooth" || d.transport === "bluetooth-le" || MAC_UID.test(id);
  return bluetooth ? `Bluetooth device (${id})` : `Audio device (${id})`;
}

export function parseDeviceList(stdout: string): AudioDevice[] {
  for (const line of stdout.split("\n")) {
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    const rec = o as { type?: unknown; devices?: unknown };
    if (rec?.type !== "devices" || !Array.isArray(rec.devices)) continue;
    const out: AudioDevice[] = [];
    for (const d of rec.devices as Record<string, unknown>[]) {
      // Only a UID decides whether this is a device at all — an empty, blank or missing name doesn't.
      if (!d || !validDeviceUid(d.uid)) continue;
      const transport = (TRANSPORTS as readonly string[]).includes(d.transport as string) ? (d.transport as Transport) : "unknown";
      const named = namedDevice(d.name);
      const dev: AudioDevice = { uid: d.uid, name: deviceLabel({ uid: d.uid, name: d.name, transport }).slice(0, 200), input: d.input === true, output: d.output === true, transport, defaultInput: d.defaultInput === true, defaultOutput: d.defaultOutput === true };
      if (!named) dev.unnamed = true;
      out.push(dev);
    }
    return out;
  }
  return [];
}

/** The chosen device, matched by UID only — a device is gone only when it is not in this list. */
export function findDevice(devices: readonly AudioDevice[], kind: DeviceKind, uid: string | null): AudioDevice | null {
  if (!validDeviceUid(uid)) return null;
  return devices.find((d) => d.uid === uid && (kind === "input" ? d.input : d.output)) ?? null;
}

/** Bug 106: one installed text-to-speech voice, as `--list-voices` reports it. */
export type VoiceQuality = "premium" | "enhanced" | "default";
export interface TtsVoice { id: string; name: string; lang: string; quality: VoiceQuality; siri: boolean; personal: boolean }
const QUALITY_RANK: Record<VoiceQuality, number> = { premium: 3, enhanced: 2, default: 1 };
/** Where macOS downloads better voices: System Settings → Accessibility → Spoken Content (System voice → Manage Voices…). */
export const VOICE_DOWNLOADS_URL = "x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent";

/** A voice identifier (com.apple.voice.premium.en-US.Zoe) or name: printable, bounded, never a flag. */
export function validVoiceId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200 && !v.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(v);
}

export function parseVoiceList(stdout: string): TtsVoice[] {
  for (const line of stdout.split("\n")) {
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    const rec = o as { type?: unknown; voices?: unknown };
    if (rec?.type !== "voices" || !Array.isArray(rec.voices)) continue;
    const out: TtsVoice[] = [];
    for (const v of rec.voices as Record<string, unknown>[]) {
      if (!v || !validVoiceId(v.id) || typeof v.name !== "string" || typeof v.lang !== "string") continue;
      const quality: VoiceQuality = v.quality === "premium" || v.quality === "enhanced" ? v.quality : "default";
      out.push({ id: v.id, name: v.name.slice(0, 100), lang: v.lang.slice(0, 35), quality, siri: v.siri === true, personal: v.personal === true });
    }
    // Stable: the helper's own ranking within a quality.
    return out.map((v, i) => [v, i] as const).sort((a, b) => QUALITY_RANK[b[0].quality] - QUALITY_RANK[a[0].quality] || a[1] - b[1]).map(([v]) => v);
  }
  return [];
}

/** The device arguments a helper run needs: dictation and the meter only listen; the speaker test only plays. */
export function deviceArgs(p: AudioPrefs, use: HelperUse): string[] {
  const args: string[] = [];
  if (use !== "speaker" && validDeviceUid(p.input)) args.push("--input-device", p.input);
  if ((use === "call" || use === "speaker") && validDeviceUid(p.output)) args.push("--output-device", p.output);
  return args;
}

const LIST_TIMEOUT_MS = 8_000;
const SPEAKER_TIMEOUT_MS = 20_000;
const METER_MAX_MS = 120_000;
/** Bug 107: how long Preview waits for a cold Kokoro to load before it plays the Apple voice instead. */
const PREVIEW_WARM_MS = 20_000;
/** Bug 134: a voicemail plays for at most this long; a cold Kokoro gets this long to load for it. */
const VOICEMAIL_MAX_S = 60;
const VOICEMAIL_WARM_MS = 8_000;
const VOICEMAIL_TEXT_MAX = 600;
let previews = 0;

export function registerAudioDevices(o: {
  binary: string;
  spawnFn?: typeof spawn;
  readPrefs(): AudioPrefs;
  writePrefs(p: AudioPrefs): AudioPrefs;
  /** Apply a new choice to the running dictation / voice session, if there is one. */
  applyLive?(p: AudioPrefs): void;
  log?: (line: string) => void;
  /** Bug 164: the Qwen3 engine, for previewing a qwen3: voice. Absent = no Qwen preview. */
  qwen?: QwenTts;
  /** Bug 106: the voice chosen in Settings → Voice (null = the best installed). */
  readVoice?(): string | null;
  writeVoice?(v: string | null): string | null;
  openExternal?(url: string): Promise<void>;
  /** Bug 107: the natural (Kokoro) voice, for Preview. */
  tts?: NaturalTts;
  /** Bug 134: voicemail audio, rendered once in the Bot's voice and kept on this Mac (30 days). */
  voicemails?: PhraseCache;
}): { invalidate(): void; list(): Promise<AudioDevice[]> } {
  const run = (args: string[]) => (o.spawnFn ?? spawn)(o.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
  const log = o.log ?? (() => {});
  let cache: AudioDevice[] | null = null;
  let inflight: Promise<AudioDevice[]> | null = null;

  function list(): Promise<AudioDevice[]> {
    if (cache) return Promise.resolve(cache);
    if (inflight) return inflight;
    const p = new Promise<AudioDevice[]>((resolve, reject) => {
      const c = run(["--list-devices"]);
      let out = "";
      const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, LIST_TIMEOUT_MS);
      t.unref?.();
      c.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      c.on("error", (e) => { clearTimeout(t); reject(e); });
      c.on("close", (code: number | null) => {
        clearTimeout(t);
        if (code !== 0) { log(`audio-devices list failed (exit ${code})`); return reject(new Error("Couldn't list the audio devices.")); }
        const devices = parseDeviceList(out);
        reconcile(devices);
        resolve(devices);
      });
    });
    inflight = p;
    p.then((d) => { if (inflight === p) cache = d; }, () => {}).finally(() => { if (inflight === p) inflight = null; });
    return p;
  }
  const invalidate = () => { cache = null; inflight = null; };

  /**
   * Bug 151: what a fresh listing means for the chosen microphone and speaker. The choice itself is
   * never rewritten here — it is remembered right through a disappearance, so an unplugged (or
   * asleep) headset is re-selected the moment it is back, instead of stranding the call on the
   * built-in device. An unnamed device is present like any other; only absence counts as gone.
   */
  const gone: Record<DeviceKind, boolean> = { input: false, output: false };
  function reconcile(devices: readonly AudioDevice[]): void {
    const prefs = o.readPrefs();
    let back = false;
    for (const kind of ["input", "output"] as const) {
      const uid = prefs[kind];
      if (!validDeviceUid(uid)) { gone[kind] = false; continue; }
      const d = findDevice(devices, kind, uid);
      if (!d) {
        if (!gone[kind]) log(`audio-devices ${kind} ${uid} is gone from the device list — the system default takes over, the choice is kept`);
        gone[kind] = true;
        continue;
      }
      if (d.unnamed) log(`audio-devices ${kind} ${uid} is present but unnamed — keeping it as "${d.name}", no fallback`);
      if (gone[kind]) {
        gone[kind] = false;
        back = true;
        log(`audio-devices ${kind} ${uid} ("${d.name}") is back — re-selecting it`);
      }
    }
    if (back) o.applyLive?.(prefs);
  }

  registerNative("audio.devices.list", async (a: { refresh?: unknown }) => {
    if (a?.refresh === true) invalidate();
    return { devices: await list(), prefs: o.readPrefs() };
  });

  registerNative("audio.devices.set", (a: { input?: unknown; output?: unknown }) => {
    const next = { ...o.readPrefs() };
    for (const k of ["input", "output"] as const) {
      const v = a?.[k];
      if (v === undefined) continue;
      if (v !== null && !validDeviceUid(v)) throw new Error("That audio device isn't valid.");
      next[k] = v;
    }
    const saved = o.writePrefs(next);
    log(`audio-devices set input=${saved.input ?? "default"} output=${saved.output ?? "default"}`);
    o.applyLive?.(saved);
    return saved;
  });

  // ---- the input-level meter (Settings → Voice): one helper at a time, never left running ----
  let meter: ChildProcess | null = null;
  const stopMeter = () => {
    const m = meter;
    meter = null;
    if (!m) return;
    m.stdin?.end();
    const t = setTimeout(() => { try { m.kill("SIGKILL"); } catch { /* gone */ } }, 1500);
    t.unref?.();
    m.once?.("close", () => clearTimeout(t));
  };
  registerNative("audio.meter.start", () => {
    stopMeter();
    const m = run(["--meter", ...deviceArgs(o.readPrefs(), "meter")]);
    meter = m;
    let buf = "";
    const cap = setTimeout(() => { if (meter === m) stopMeter(); }, METER_MAX_MS);
    cap.unref?.();
    m.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (meter !== m) continue;
        try {
          const e = JSON.parse(line) as { type?: unknown; db?: unknown; message?: unknown };
          if (e.type === "level" && typeof e.db === "number" && Number.isFinite(e.db)) emitNative("audio-level", { type: "level", db: e.db });
          else if (e.type === "error" && typeof e.message === "string") { log(`audio-meter error: ${e.message}`); emitNative("audio-level", { type: "error", message: e.message }); }
        } catch { /* not a JSON line */ }
      }
      if (buf.length > 4096) buf = "";
    });
    m.stderr?.on("data", () => {});
    m.on("error", (e) => { log(`audio-meter spawn failed: ${e.message}`); if (meter === m) meter = null; });
    m.on("close", () => { clearTimeout(cap); if (meter === m) meter = null; });
    return {};
  });
  registerNative("audio.meter.stop", () => { stopMeter(); return {}; });

  // ---- Bug 106: the reply voice (Settings → Voice) ----
  registerNative("audio.voices.list", () => new Promise((resolve, reject) => {
    const c = run(["--list-voices"]);
    let out = "";
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, LIST_TIMEOUT_MS);
    t.unref?.();
    c.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    c.on("error", (e) => { clearTimeout(t); reject(e); });
    c.on("close", (code: number | null) => {
      clearTimeout(t);
      if (code !== 0) { log(`voices list failed (exit ${code})`); return reject(new Error("Couldn't list the voices.")); }
      resolve({ voices: parseVoiceList(out), chosen: o.readVoice?.() ?? null });
    });
  }));
  registerNative("audio.voice.set", (a: { voice?: unknown }) => {
    const v = a?.voice ?? null;
    if (v !== null && !validVoiceId(v)) throw new Error("That voice isn't valid.");
    const saved = o.writeVoice ? o.writeVoice(v) : v;
    log(`voice set ${saved ?? "auto"}`);
    return { voice: saved };
  });
  registerNative("audio.voices.openDownloads", async () => {
    // Only the one fixed settings URL; nothing the renderer sends is opened.
    await o.openExternal?.(VOICE_DOWNLOADS_URL);
    return {};
  });

  // ---- Test speaker / Preview: speak one short phrase through the chosen output ----
  registerNative("audio.testSpeaker", (a: { voice?: unknown } | undefined) => {
    if (a?.voice !== undefined && a.voice !== null && !validVoiceId(a.voice)) return Promise.reject(new Error("That voice isn't valid."));
    const voice = validVoiceId(a?.voice) ? a.voice : o.readVoice?.() ?? null;
    const natural = kokoroVoiceId(voice);
    // Bug 164: a Qwen3 voice previews the same way, streamed exactly as a call line would be — the
    // point of a preview is to be honest about what the Bot will sound like on a call.
    const qwen = qwenVoiceId(voice);
    if (qwen && o.qwen?.isReady()) return previewNatural(qwen, o.qwen, "qwen");
    // Bug 107: a natural voice previews through the same helper (chosen output), fed Kokoro's PCM.
    if (natural && o.tts?.isReady()) return previewNatural(natural, o.tts, "kokoro");
    // A prefixed value is never an Apple voice identifier: the helper would pick some other voice
    // and the preview would be a lie about which one was chosen.
    return speakerTest(["--test-speaker", ...(validVoiceId(voice) && !natural && !qwen ? ["--voice", voice] : []), ...deviceArgs(o.readPrefs(), "speaker")]);
  });

  async function previewNatural(voice: string, tts: NaturalTts, name: string): Promise<{ ok: boolean; message?: string; engine?: string }> {
    const warm = await (tts.whenWarm ? tts.whenWarm(PREVIEW_WARM_MS) : Promise.resolve(tts.isWarm()));
    let engine = name;
    const r = await speakerTest(["--test-speaker", "--pcm-stdin", ...deviceArgs(o.readPrefs(), "speaker")], (c) => {
      const fallback = (why: string) => { engine = "apple"; log(`audio-speaker ${name} preview fell back to Apple: ${why}`); c.stdin?.write(`pcm-fail ${JSON.stringify({ id: "test" })}\n`); };
      if (!warm) return fallback("not warm");
      // Bug 156: a preview is processed like a spoken line, so it is honest about the call.
      // Bug 181: like a spoken line OF ITS ENGINE — a Qwen preview was trimmed as a Kokoro one.
      tts.synth({ id: `preview-${++previews}`, text: PREVIEW_PHRASE, voice, speed: 1 }, withProsody(PREVIEW_PHRASE, {
        audio: (pcm) => c.stdin?.write(`pcm ${JSON.stringify({ id: "test", data: pcm.toString("base64") })}\n`),
        done: () => c.stdin?.write(`pcm-end ${JSON.stringify({ id: "test" })}\n`),
        error: fallback,
      }, name === "qwen" ? qwenProsody(prosodyFrom()) : prosodyFrom()));
    });
    return { ...r, engine };
  }

  // ---- Bug 134: a Bot's voicemail, played in its chat ----
  let voicemail: ChildProcess | null = null;
  registerNative("voicemail.play", async (a: { id?: unknown; text?: unknown; voice?: unknown; rate?: unknown }) => {
    if (typeof a?.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(a.id)) throw new Error("That voicemail isn't valid.");
    const text = typeof a.text === "string" ? a.text.replace(/\s+/g, " ").trim() : "";
    if (!text || text.length > VOICEMAIL_TEXT_MAX) throw new Error("That voicemail isn't valid.");
    if (a.voice !== undefined && a.voice !== null && !validVoiceId(a.voice)) throw new Error("That voice isn't valid.");
    try { voicemail?.kill("SIGTERM"); } catch { /* gone */ }
    const voice = validVoiceId(a.voice) ? a.voice : null;
    const natural = kokoroVoiceId(voice);
    const speed = typeof a.rate === "number" && Number.isFinite(a.rate) ? Math.min(2, Math.max(0.5, a.rate)) : 1;
    const tail = ["--phrase", text, "--max-seconds", String(VOICEMAIL_MAX_S), ...deviceArgs(o.readPrefs(), "speaker")];
    const cached = natural ? o.voicemails?.get(natural, speed, text) ?? null : null;
    const tts = o.tts;
    if (!natural || (!cached && !tts?.isReady())) {
      return speakerTest(["--test-speaker", ...(voice && !natural ? ["--voice", voice] : []), ...tail], (c) => { voicemail = c; }, (VOICEMAIL_MAX_S + 5) * 1000);
    }
    const warm = cached ? true : await (tts!.whenWarm ? tts!.whenWarm(VOICEMAIL_WARM_MS) : Promise.resolve(tts!.isWarm()));
    let engine = "kokoro";
    const r = await speakerTest(["--test-speaker", "--pcm-stdin", ...tail], (c) => {
      voicemail = c;
      const fallback = (why: string) => { engine = "apple"; log(`voicemail fell back to Apple: ${why}`); c.stdin?.write(`pcm-fail ${JSON.stringify({ id: "test" })}\n`); };
      if (cached) {
        for (let i = 0; i < cached.length; i += 48_000) c.stdin?.write(`pcm ${JSON.stringify({ id: "test", data: cached.subarray(i, i + 48_000).toString("base64") })}\n`);
        c.stdin?.write(`pcm-end ${JSON.stringify({ id: "test" })}\n`);
        return;
      }
      if (!warm) return fallback("not warm");
      const parts: Buffer[] = [];
      tts!.synth({ id: `vm-${a.id as string}-${++previews}`, text, voice: natural, speed }, withProsody(text, {
        audio: (pcm) => { parts.push(Buffer.from(pcm)); c.stdin?.write(`pcm ${JSON.stringify({ id: "test", data: pcm.toString("base64") })}\n`); },
        done: () => { o.voicemails?.put(natural, speed, text, Buffer.concat(parts)); c.stdin?.write(`pcm-end ${JSON.stringify({ id: "test" })}\n`); },
        error: fallback,
      }, prosodyFrom()));
    }, (VOICEMAIL_MAX_S + 5) * 1000);
    return { ...r, engine };
  });
  registerNative("voicemail.stop", () => {
    try { voicemail?.kill("SIGTERM"); } catch { /* gone */ }
    voicemail = null;
    return {};
  });

  function speakerTest(args: string[], feed?: (c: ChildProcess) => void, timeoutMs = SPEAKER_TIMEOUT_MS): Promise<{ ok: boolean; message?: string }> {
    return new Promise((resolve) => {
    const c = run(args);
    feed?.(c);
    let out = "";
    let message: string | null = null;
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    t.unref?.();
    c.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      for (const line of out.split("\n")) {
        try { const e = JSON.parse(line) as { type?: unknown; message?: unknown }; if (e.type === "error" && typeof e.message === "string") message = e.message; } catch { /* partial */ }
      }
      if (out.length > 16_384) out = out.slice(-4096);
    });
    c.stderr?.on("data", (d: Buffer) => log(`audio-speaker ${d.toString("utf8").trim().slice(0, 300)}`));
    c.on("error", (e) => { clearTimeout(t); resolve({ ok: false, message: e.message }); });
    c.on("close", (code: number | null) => {
      clearTimeout(t);
      resolve(code === 0 && !message ? { ok: true } : { ok: false, message: message ?? `The test sound didn't play (exit ${code}).` });
    });
    });
  }

  return { invalidate, list };
}
