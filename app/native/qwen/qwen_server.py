#!/usr/bin/env python3
"""Synapse's Qwen3-TTS sidecar: the "Qwen3 (natural)" voice engine (bug 164).

Speaks exactly the wire protocol of native/kokoro/kokoro_server.py, so the app's frame decoding,
idle shutdown, crash backoff, cancel and prosody chain (main/native/kokoro.ts, KokoroSidecar) are
the Kokoro ones, reused unchanged — this file only swaps the model behind them.

stdin: one JSON object per line —
  {"op": "warm"}                                            reply: a "warm" frame (once warm)
  {"op": "synth", "id", "text", "voice", "speed", "quality"[, "targetRms", "instruct"]}
                                                            reply: "audio" frames, then "done"
  {"op": "cancel", "id"}   drop that request (queued or mid-synth); no "id" = drop everything
  {"op": "prime", "voices": [...]}   accepted for interface parity (Qwen has no per-voice pipeline)
stdin closing ends the process.

stdout: length-prefixed binary frames, nothing else —
  u32 big-endian N, then N bytes: u16 big-endian H, H bytes of UTF-8 JSON header, N-2-H bytes of
  mono float32 little-endian PCM at 24 kHz (audio frames only).
  Headers: ready {sampleRate, loadMs} | warm {ms} | audio {id, seq, samples} |
           done {id, seq, synthMs, audioMs, rtf, firstMs} | error {id?, message}
stderr: human-readable log lines, "[qwen +<ms>] ...".

Two qualities, because the model can be driven either way (measured on the owner's M-series Mac):
  quality "live" (the default) streams the codec as it decodes — first audio in 0.23-0.45 s.
  quality "full" renders the whole utterance before emitting — first audio in 1.8-6.7 s, which is
  only acceptable for pre-rendered lines (greetings, fillers, voicemail, standup), where nothing
  is waiting. Both run at a real-time factor of about 0.43-0.48, so playback never catches up.

Loudness: Qwen and Kokoro do not come out at the same level, and a call switches between them
mid-reply (the hybrid path). Every utterance is scaled towards a target RMS, so the switch is
inaudible: a synth command may carry its own `targetRms` — the app sends the measured level of the
Bot's OWN Kokoro voice, which spans 0.049 to 0.087 across the nine (main/native/qwen.ts
KOKORO_LEVELS) — and --target-rms is the fallback for anything that names none. Live lines fix the
gain from the first voiced audio and hold it for the rest of the utterance (a per-chunk gain would
pump); full-quality lines measure the whole thing.

Usage: qwen_server.py --model-dir DIR [--voice vivian] [--cache-dir DIR] [--target-rms 0.064]
                      [--self-test "text"]
Python and the model are the user's own (never bundled); the app finds them (main/native/qwen.ts).
"""
import hashlib
import json
import os
import queue
import struct
import sys
import threading
import time

# Offline, always: every file comes from the model dir; never reach for the network.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

T0 = time.monotonic()
SAMPLE_RATE = 24000  # what the helper's player expects; Qwen's own rate is resampled to it
FRAME_SAMPLES = SAMPLE_RATE // 2  # an audio frame carries at most 0.5 s
VOICE_RE = "abcdefghijklmnopqrstuvwxyz_"
# The voices Qwen3-TTS CustomVoice ships with. A voice name is REQUIRED: this build has no
# default speaker, and generate() without one fails.
VOICES = ("serena", "vivian", "uncle_fu", "ryan", "aiden", "ono_anna", "sohee", "eric", "dylan")
DEFAULT_VOICE = "vivian"
# How often the streaming decoder hands back audio. 0.5 s measured lowest to first audio without
# raising the real-time factor (0.34 s vs 0.42 s at 1.0 s, same total).
STREAM_INTERVAL = 0.5
# The mean of the nine Kokoro voices' measured voiced RMS on the same phrases (0.049-0.087);
# see docs/decisions.md (bug 164). Only used when a synth command names no target of its own.
DEFAULT_TARGET_RMS = 0.064
# The band a target is allowed to fall in: outside it, the fallback is used instead.
MIN_TARGET_RMS, MAX_TARGET_RMS = 0.005, 0.5
# Bug 166: a live line's gain is fixed from its first third of a second and then refined once, over
# this much of the utterance, and glided to over GLIDE_S. MAX_REFINE caps the correction, so a bad
# measurement can move the level by at most 2.5 dB and never re-decides it.
REFINE_S = 1.6
# Bug 183: "it speaks like it's trying to sound lazy". Given no instruction, each speaker falls back
# to its own casual default (ryan measured 9.5 chars/s on real calls; Kokoro's voices 13-16). The
# 0.6B CustomVoice model follows `instruct`: this one measured +13-17% syllables/s on vivian and
# ryan (app/look/qwen-delivery.py), where a lower sampling temperature alone bought nothing. A synth
# command may carry its own (a per-Bot override); anything else gets this.
DEFAULT_INSTRUCT = "Speak clearly and crisply at a brisk, steady pace, in a confident, friendly, attentive tone."
MAX_INSTRUCT = 300
GLIDE_S = 0.5
MAX_REFINE = 1.33
_out = sys.stdout.buffer
_out_lock = threading.Lock()


def log(msg):
    sys.stderr.write("[qwen +%dms] %s\n" % (int((time.monotonic() - T0) * 1000), msg))
    sys.stderr.flush()


def frame(header, pcm=b""):
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    body = struct.pack(">H", len(h)) + h + pcm
    with _out_lock:
        _out.write(struct.pack(">I", len(body)) + body)
        _out.flush()


def valid_voice(v):
    return isinstance(v, str) and 3 <= len(v) <= 40 and all(c in VOICE_RE for c in v)


def seed_for(text, voice):
    """A fixed seed per (voice, line), so a line sounds the same every time it is said.

    Qwen samples at temperature, so without this the same greeting drifts between sessions and the
    phrase cache would hold one take while a live render produced another. Kokoro is deterministic;
    this makes Qwen behave the same way.
    """
    h = hashlib.sha256(("%s\x00%s" % (voice, text)).encode("utf-8")).digest()
    return int.from_bytes(h[:4], "big")


def generate_kwargs(text, voice, live, instruct=None):
    """What model.generate() is called with for one line (bug 183: always with a delivery instruction)."""
    own = instruct if isinstance(instruct, str) and 0 < len(instruct.strip()) <= MAX_INSTRUCT else None
    kw = {"text": text, "voice": voice, "instruct": own.strip() if own else DEFAULT_INSTRUCT}
    if live:
        kw["stream"] = True
        kw["streaming_interval"] = STREAM_INTERVAL
    return kw


def fast_start(cache_dir):
    """Compiled bytecode in our own cache folder, not in the user's venv (bug 134's finding)."""
    if cache_dir:
        try:
            os.makedirs(os.path.join(cache_dir, "pycache"), exist_ok=True)
            sys.pycache_prefix = os.path.join(cache_dir, "pycache")
            sys.dont_write_bytecode = False
        except OSError as e:
            log("no bytecode cache (%s)" % e)


def resample(a, src, dst, np):
    """Linear resample to the player's rate. A no-op when the model already emits `dst`.

    Qwen is 24 kHz on this build, the same as Kokoro, so this normally does nothing — but the rate
    is read from the model's own frames, and a future checkpoint at another rate must still play at
    the right pitch rather than be handed to the helper raw.
    """
    if src == dst or len(a) == 0 or src <= 0:
        return a
    n = int(round(len(a) * float(dst) / float(src)))
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    # Sample positions in the source, spanning the same wall-clock duration.
    x = np.arange(n, dtype=np.float64) * (float(src) / float(dst))
    return np.interp(x, np.arange(len(a), dtype=np.float64), a).astype(np.float32)


def voiced_rms(a, np, floor=0.01):
    """RMS over the audible part only: trailing and leading silence must not drag the level down."""
    v = a[np.abs(a) > floor]
    if len(v) < 32:
        return 0.0
    return float(np.sqrt(np.mean(v.astype(np.float64) ** 2)))


def gain_for(rms, target, lo=0.4, hi=2.5):
    """The scale that puts `rms` on `target`, clamped so a bad measurement can't wreck a line."""
    if rms <= 1e-6 or target <= 0:
        return 1.0
    return min(hi, max(lo, target / rms))


def refined_gain(gain, rms, target):
    """The gain a fuller measurement asks for, clamped so it is a correction, not a new decision.

    Bug 166: a live line fixes its gain from its first third of a second, which is often a breath or
    one quiet word. A reply is several renders in a row, so each one's guess was heard as the level
    stepping at the join (measured: 0.050 to 0.078 voiced RMS across the five renders of one reply,
    a 3.8 dB spread on lines that all asked for 0.064). Returns None when nothing needs changing.
    """
    if rms <= 1e-6 or gain <= 0:
        return None
    g = gain_for(rms, target)
    g = min(gain * MAX_REFINE, max(gain / MAX_REFINE, g))
    return None if abs(g - gain) <= gain * 0.03 else g


def glide(np, n, gain, target, left):
    """`n` per-sample gains walking `gain` toward `target`, reaching it after `left` samples.

    A glide, never a switch: the correction is spread over GLIDE_S so nothing pumps, and a chunk
    that ends before the glide does carries on from where it got to.
    """
    step = min(n, left)
    reached = gain + (target - gain) * (float(step) / left) if left > 0 else target
    ramp = np.full(n, reached, dtype=np.float32)
    if step > 0:
        ramp[:step] = np.linspace(gain, reached, step, dtype=np.float32)
    return ramp, reached, left - step


def rail(out, np):
    """Keep the peak inside the rail — a soft knee, so a loud vowel doesn't clip flat."""
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    if peak > 0.99:
        out = np.tanh(out * (0.99 / peak) * 1.1) * 0.9
    return out.astype(np.float32)


def apply_gain(a, g, np):
    """Scale, then keep the peak inside the rail."""
    if g == 1.0:
        return a
    return rail(a * g, np)


# Bug 182: how much a voice's remembered level moves towards each new line it says, and how much
# voiced audio (samples over the floor) a line needs before it may move it at all.
LEVEL_EMA = 0.3
LEVEL_MIN_VOICED_S = 0.4


class Engine:
    def __init__(self, model_dir, default_voice, target_rms, cache_dir=None):
        self.model_dir = model_dir
        self.default_voice = default_voice
        self.default_target_rms = target_rms
        self.model = None
        self.np = None
        self.mx = None
        # Bug 182: each voice's raw level (voiced RMS before any gain), learned from the lines it
        # has said and kept in the cache folder, so a live line can start at the right gain.
        self.levels_file = os.path.join(cache_dir, "levels.json") if cache_dir else None
        self.levels = {}
        try:
            with open(self.levels_file) as f:
                self.levels = {k: float(v) for k, v in json.load(f).items() if k in VOICES and 1e-4 < float(v) < 1.0}
        except (TypeError, OSError, ValueError, AttributeError):
            pass

    def learn_level(self, voice, sumsq, n):
        """Folds one line's raw voiced level into the voice's remembered one (and saves it)."""
        if n < SAMPLE_RATE * LEVEL_MIN_VOICED_S:
            return
        rms = (sumsq / n) ** 0.5
        old = self.levels.get(voice)
        self.levels[voice] = rms if old is None else old + (rms - old) * LEVEL_EMA
        if self.levels_file:
            try:
                tmp = self.levels_file + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(self.levels, f)
                os.replace(tmp, self.levels_file)
            except OSError as e:
                log("couldn't keep the voice levels (%s)" % e)

    def load(self):
        t = time.monotonic()
        import numpy as np
        import mlx.core as mx
        from mlx_audio.tts.utils import load_model

        self.np = np
        self.mx = mx
        self.model = load_model(self.model_dir)
        ms = (time.monotonic() - t) * 1000
        log("model loaded in %d ms from %s" % (ms, self.model_dir))
        return ms

    def _chunks(self, text, voice, speed, live, instruct=None):
        """Raw model output, resampled to the player's rate. Yields float32 numpy arrays."""
        # `speed` is not passed on: CustomVoice's generate ignores it (mlx-audio 0.5.5).
        kw = generate_kwargs(text, voice, live, instruct)
        self.mx.random.seed(seed_for(text, voice))
        for result in self.model.generate(**kw):
            a = result.audio
            try:
                self.mx.eval(a)
            except Exception:
                pass
            a = self.np.asarray(a, dtype=self.np.float32).reshape(-1)
            rate = int(getattr(result, "sample_rate", SAMPLE_RATE) or SAMPLE_RATE)
            yield resample(a, rate, SAMPLE_RATE, self.np)

    def target_for(self, target_rms):
        """The level this line is held to: the one the app asked for, or the engine's default."""
        if isinstance(target_rms, (int, float)) and MIN_TARGET_RMS <= target_rms <= MAX_TARGET_RMS:
            return float(target_rms)
        return self.default_target_rms

    def generate(self, text, voice, speed, quality="live", target_rms=None, instruct=None):
        """Yields level-matched float32 chunks at SAMPLE_RATE.

        "live": the gain is fixed from the first chunk that carries real audio and held, so the
        level never moves inside one utterance. "full": the whole line is measured, then scaled.
        """
        voice = voice if valid_voice(voice) and voice in VOICES else self.default_voice
        target = self.target_for(target_rms)
        live = quality != "full"
        # Bug 182: the remembered levels are of the DEFAULT delivery; a line with its own instruct
        # neither uses them nor moves them (another delivery can sit at another level).
        default = generate_kwargs(text, voice, False, instruct)["instruct"] == DEFAULT_INSTRUCT
        if not live:
            parts = list(self._chunks(text, voice, speed, live=False, instruct=instruct))
            a = self.np.concatenate(parts) if parts else self.np.zeros(0, dtype=self.np.float32)
            v = a[self.np.abs(a) > 0.01]
            if default:
                self.learn_level(voice, float(self.np.sum(v.astype(self.np.float64) ** 2)), len(v))
            a = apply_gain(a, gain_for(voiced_rms(a, self.np), target), self.np)
            for i in range(0, len(a), FRAME_SAMPLES):
                yield a[i:i + FRAME_SAMPLES]
            return
        # Bug 182: a voice that has spoken before starts at the gain its own level asks for — its
        # opening third of a second (a breath, a soft first syllable) put ryan's live lines 5-11 dB
        # over target. The refinement below still corrects the line to its own measurement.
        known = self.levels.get(voice) if default else None
        gain = gain_for(known, target) if known else None
        line_sumsq = 0.0
        line_n = 0
        held = []
        held_len = 0
        # Bug 166: the first third of a second is not a fair sample of a line — it is often a breath,
        # or one quiet word — and a reply is several renders in a row, so each one locking in its own
        # guess is heard as the level stepping at every join (measured: 0.050 to 0.078 voiced RMS
        # across the five renders of one reply, a 3.8 dB spread on a line that asked for 0.064).
        # So the gain is REFINED once, over the first REFINE_S of the utterance, and glided to over
        # GLIDE_S rather than switched — slow enough that nothing pumps, and it costs no latency at
        # all, because the audio before it went out at the first estimate exactly as before.
        seen = []
        seen_len = 0
        refined = False
        target_gain = None
        glide_left = 0
        for chunk in self._chunks(text, voice, speed, live=True, instruct=instruct):
            v = chunk[self.np.abs(chunk) > 0.01]
            line_sumsq += float(self.np.sum(v.astype(self.np.float64) ** 2))
            line_n += len(v)
            if gain is None:
                # Wait for about a third of a second of audio before fixing the gain: the first
                # chunk of a line often opens on a breath, which measures far quieter than speech.
                held.append(chunk)
                held_len += len(chunk)
                if held_len < SAMPLE_RATE // 3:
                    continue
                head = self.np.concatenate(held)
                r = voiced_rms(head, self.np)
                if r <= 1e-6 and held_len < SAMPLE_RATE:
                    continue  # still silence; keep listening rather than lock in a wild gain
                gain = gain_for(r, target)
                held = []
                seen.append(head)
                seen_len += len(head)
                yield apply_gain(head, gain, self.np)
                continue
            seen.append(chunk)
            seen_len += len(chunk)
            if not refined and seen_len >= int(SAMPLE_RATE * REFINE_S):
                refined = True
                g = refined_gain(gain, voiced_rms(self.np.concatenate(seen), self.np), target)
                if g is not None:
                    target_gain = g
                    glide_left = int(SAMPLE_RATE * GLIDE_S)
            if target_gain is not None and glide_left > 0:
                ramp, gain, glide_left = glide(self.np, len(chunk), gain, target_gain, glide_left)
                if glide_left <= 0:
                    gain = target_gain
                    target_gain = None
                yield rail(chunk * ramp, self.np)
                continue
            yield apply_gain(chunk, gain, self.np)
        if held:  # a line shorter than the measuring window
            head = self.np.concatenate(held)
            yield apply_gain(head, gain_for(voiced_rms(head, self.np), target), self.np)
        if default:
            self.learn_level(voice, line_sumsq, line_n)


class Server:
    def __init__(self, engine):
        self.engine = engine
        self.jobs = queue.Queue()
        self.lock = threading.Lock()
        self.cancelled = set()
        self.cancel_gen = 0  # bumped by a cancel-all: every job queued before it is dropped
        self.warm_ms = None

    def is_cancelled(self, job):
        with self.lock:
            return job["gen"] != self.cancel_gen or job["id"] in self.cancelled

    def reader(self):
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except ValueError:
                log("bad command (not JSON)")
                continue
            op = cmd.get("op")
            if op == "cancel":
                with self.lock:
                    if isinstance(cmd.get("id"), str):
                        self.cancelled.add(cmd["id"])
                    else:
                        self.cancel_gen += 1
                        self.cancelled.clear()
                log("cancel %s" % (cmd.get("id") or "all"))
            elif op == "synth":
                sid, text = cmd.get("id"), cmd.get("text")
                if not isinstance(sid, str) or not isinstance(text, str):
                    log("bad synth command")
                    continue
                speed = cmd.get("speed")
                speed = float(speed) if isinstance(speed, (int, float)) and 0.5 <= speed <= 2.0 else 1.0
                quality = cmd.get("quality") if cmd.get("quality") in ("live", "full") else "live"
                with self.lock:
                    gen = self.cancel_gen
                self.jobs.put({"op": "synth", "id": sid, "text": text[:4000], "voice": cmd.get("voice"),
                               "speed": speed, "quality": quality, "targetRms": cmd.get("targetRms"),
                               "instruct": cmd.get("instruct"),
                               "gen": gen, "at": time.monotonic()})
            elif op == "warm":
                self.jobs.put({"op": "warm", "id": "", "gen": None})
            elif op == "prime":
                # Interface parity with Kokoro. Qwen has no per-voice pipeline or voice pack to
                # build: once the model is loaded every voice is ready, so there is nothing to do.
                voices = cmd.get("voices")
                if isinstance(voices, list):
                    log("prime %s (no-op: the model serves every voice)" % ",".join(str(v)[:20] for v in voices[:8]))
            else:
                log("unknown op %r" % (op,))
        self.jobs.put(None)

    def warm(self):
        t = time.monotonic()
        for _ in self.engine.generate("Okay.", self.engine.default_voice, 1.0):
            pass
        self.warm_ms = (time.monotonic() - t) * 1000
        log("warm in %d ms" % self.warm_ms)
        frame({"type": "warm", "ms": round(self.warm_ms)})

    def synth(self, job):
        sid = job["id"]
        if self.is_cancelled(job):
            log("dropped %s (cancelled before it started)" % sid)
            return
        t = time.monotonic()
        seq = 0
        samples = 0
        first_ms = None
        try:
            for chunk in self.engine.generate(job["text"], job["voice"], job["speed"], job["quality"], job.get("targetRms"), job.get("instruct")):
                if self.is_cancelled(job):
                    log("cancelled %s mid-synth after %d samples" % (sid, samples))
                    return
                if first_ms is None:
                    first_ms = (time.monotonic() - t) * 1000
                for i in range(0, len(chunk), FRAME_SAMPLES):
                    part = chunk[i:i + FRAME_SAMPLES]
                    frame({"type": "audio", "id": sid, "seq": seq, "samples": int(len(part))}, part.astype("<f4").tobytes())
                    seq += 1
                    samples += len(part)
        except Exception as e:  # a bad voice, an MLX error, a codec failure: this line only
            log("synth %s failed: %s: %s" % (sid, type(e).__name__, e))
            frame({"type": "error", "id": sid, "message": "%s: %s" % (type(e).__name__, str(e)[:300])})
            return
        synth_ms = (time.monotonic() - t) * 1000
        audio_ms = samples * 1000.0 / SAMPLE_RATE
        rtf = synth_ms / audio_ms if audio_ms else 0.0
        log("synth %s: %d chars, voice=%s, quality=%s, %d ms for %d ms of audio (rtf %.3f), first chunk %d ms, queued %d ms" % (
            sid, len(job["text"]), job["voice"], job["quality"], synth_ms, audio_ms, rtf, first_ms or 0, (t - job["at"]) * 1000))
        frame({"type": "done", "id": sid, "seq": seq, "synthMs": round(synth_ms), "audioMs": round(audio_ms),
               "rtf": round(rtf, 4), "firstMs": round(first_ms or 0)})
        with self.lock:
            self.cancelled.discard(sid)

    def run(self):
        threading.Thread(target=self.reader, daemon=True).start()
        while True:
            job = self.jobs.get()
            if job is None:
                log("stdin closed; exiting")
                return
            if job["op"] == "warm":
                frame({"type": "warm", "ms": round(self.warm_ms or 0)})
            else:
                self.synth(job)


def main(argv):
    model_dir = None
    voice = DEFAULT_VOICE
    self_test = None
    cache_dir = None
    target_rms = DEFAULT_TARGET_RMS
    it = iter(argv)
    for a in it:
        if a == "--model-dir":
            model_dir = next(it, None)
        elif a == "--voice":
            voice = next(it, voice)
        elif a == "--self-test":
            self_test = next(it, "Hello there.")
        elif a == "--cache-dir":
            cache_dir = next(it, None)
        elif a == "--target-rms":
            try:
                target_rms = float(next(it, target_rms))
            except (TypeError, ValueError):
                pass
    if not model_dir or not os.path.isfile(os.path.join(model_dir, "config.json")):
        log("no model dir (--model-dir) with a config.json")
        frame({"type": "error", "message": "The Qwen3 voice model folder wasn't found."})
        return 2
    if not (valid_voice(voice) and voice in VOICES):
        voice = DEFAULT_VOICE
    if not (MIN_TARGET_RMS <= target_rms <= MAX_TARGET_RMS):
        target_rms = DEFAULT_TARGET_RMS
    fast_start(cache_dir)
    engine = Engine(model_dir, voice, target_rms, cache_dir=cache_dir)
    try:
        load_ms = engine.load()
    except Exception as e:
        log("load failed: %s: %s" % (type(e).__name__, e))
        frame({"type": "error", "message": "Qwen3 couldn't load: %s" % str(e)[:300]})
        return 1
    frame({"type": "ready", "sampleRate": SAMPLE_RATE, "loadMs": round(load_ms)})
    server = Server(engine)
    try:
        server.warm()
    except Exception as e:
        log("warm-up failed: %s: %s" % (type(e).__name__, e))
        frame({"type": "error", "message": "Qwen3 couldn't warm up: %s" % str(e)[:300]})
        return 1
    if self_test is not None:
        server.synth({"id": "self-test", "text": self_test, "voice": voice, "speed": 1.0,
                      "quality": "live", "gen": server.cancel_gen, "at": time.monotonic()})
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
