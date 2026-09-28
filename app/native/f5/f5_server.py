#!/usr/bin/env python3
"""Synapse's F5 sidecar: a cloned voice, rendered from the user's own reference clip.

Same wire protocol as the Kokoro sidecar (kokoro_server.py), so the app decodes both with
one FrameReader and runs both through one prosody chain. The difference is what a "voice"
is: Kokoro's voices are nine curated model voices, F5's are voice profiles the user
recorded, stored under <profiles-dir>/<id>/.

stdin: one JSON object per line —
  {"op": "warm"}                                       reply: a "warm" frame (once warm)
  {"op": "synth", "id", "text", "voice", "speed"}      reply: "audio" frames, then "done" (or "error")
  {"op": "cancel", "id"}   drop that request; no "id" = drop everything
  {"op": "prime", "voices": [...]}                     load and cache those profiles' conditioning
stdin closing ends the process.

stdout: length-prefixed binary frames, nothing else — identical to kokoro_server.py:
  u32 big-endian N, then N bytes: u16 big-endian H, H bytes of UTF-8 JSON header, N-2-H bytes of
  mono float32 little-endian PCM at 24 kHz (audio frames only).
  Headers: ready {sampleRate, loadMs} | warm {ms} | audio {id, seq, samples} |
           done {id, seq, synthMs, audioMs, rtf, firstMs} | error {id?, message}
stderr: human-readable log lines, "[f5 +<ms>] ...".

Usage: f5_server.py --profiles-dir DIR [--voice <id>] [--quant 4] [--self-test "text"]

A voice profile folder holds clip.wav (24 kHz mono), profile.json (the exact transcript,
the generation parameters and a fixed seed) and cond.npy (the reference mel, cached).

Why the cache exists: F5 is zero-shot, so it re-derives the voice from the reference on
every synthesis. Caching the mel does not make that much faster — the flow-matching pass
still runs over the reference and the new text together — but it makes the conditioning
bit-for-bit identical every time, which, with the profile's fixed seed, is what keeps a
saved voice sounding like the same person across sentences, restarts and app updates.

F5 renders whole sentences; it cannot stream inside one. Each sentence is emitted as soon
as it is finished, so a long reply starts playing before the whole reply is rendered, and
every sentence is normalised to the profile's loudness so sentence two does not arrive
louder or thinner than sentence one.
"""
import json
import os
import queue
import re
import struct
import sys
import threading
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

T0 = time.monotonic()
SAMPLE_RATE = 24000
FRAME_SAMPLES = SAMPLE_RATE // 2  # an audio frame carries at most 0.5 s
TARGET_RMS = 0.1
ID_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_out = sys.stdout.buffer
_out_lock = threading.Lock()


def log(msg):
    sys.stderr.write("[f5 +%dms] %s\n" % (int((time.monotonic() - T0) * 1000), msg))
    sys.stderr.flush()


def frame(header, pcm=b""):
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    body = struct.pack(">H", len(h)) + h + pcm
    with _out_lock:
        _out.write(struct.pack(">I", len(body)))
        _out.write(body)
        _out.flush()


def valid_voice(v):
    return isinstance(v, str) and bool(ID_OK.match(v))


def split_sentences(text):
    """Sentence-at-a-time is F5's only unit of streaming, so the split decides the latency."""
    parts = re.split(r"(?<=[.!?;:])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()] or [text.strip()]


class Engine:
    """Holds the model and the loaded voice profiles."""

    def __init__(self, profiles_dir, quant=None):
        self.profiles_dir = profiles_dir
        self.quant = quant
        self.model = None
        self.mx = None
        self.np = None
        self._profiles = {}
        self._lock = threading.Lock()

    def load(self):
        t = time.monotonic()
        import mlx.core as mx
        import numpy as np
        from f5_tts_mlx.cfm import F5TTS

        self.mx = mx
        self.np = np
        self.model = F5TTS.from_pretrained("lucasnewman/f5-tts-mlx", quantization_bits=self.quant)
        mx.eval(self.model.parameters())
        return (time.monotonic() - t) * 1000

    # ---------------------------------------------------------------- profiles

    def profile(self, voice):
        """Load a saved voice: its transcript, its parameters and its cached conditioning."""
        if not valid_voice(voice):
            raise ValueError("unknown voice %r" % (voice,))
        with self._lock:
            if voice in self._profiles:
                return self._profiles[voice]
        mx, np = self.mx, self.np
        base = os.path.join(self.profiles_dir, voice)
        with open(os.path.join(base, "profile.json"), "r") as f:
            meta = json.load(f)
        text = meta.get("transcript")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("voice %s has no transcript" % voice)

        cond_path = os.path.join(base, "cond.npy")
        cached = os.path.isfile(cond_path)
        if cached:
            mel = mx.array(np.load(cond_path))
        else:
            import soundfile as sf

            audio, sr = sf.read(os.path.join(base, "clip.wav"))
            if getattr(audio, "ndim", 1) > 1:
                audio = audio.mean(axis=1)
            if sr != SAMPLE_RATE:
                raise ValueError("reference clip must be 24 kHz mono, got %d Hz" % sr)
            a = mx.array(audio.astype("float32"))
            rms = mx.sqrt(mx.mean(mx.square(a)))
            if float(rms) < TARGET_RMS:
                a = a * TARGET_RMS / rms
            mel = self.model._mel_spec(a)
            mx.eval(mel)
            try:
                np.save(cond_path, np.array(mel))
                log("cached conditioning for %s" % voice)
            except OSError as e:
                log("could not cache conditioning for %s: %s" % (voice, e))

        if mel.ndim == 2:
            mel = mx.expand_dims(mel, axis=0)
        p = {
            "mel": mel,
            "text": text,
            "seed": int(meta.get("seed", 1234)),
            "steps": int(meta.get("steps", 8)),
            "cfg": float(meta.get("cfgStrength", 2.0)),
            "sway": float(meta.get("swaySampling", -1.0)),
            "speed": float(meta.get("speed", 1.0)),
            "refFrames": int(mel.shape[1]),
            "loudness": float(meta.get("loudness", 0.0)) or None,
        }
        with self._lock:
            self._profiles[voice] = p
        log("loaded voice %s (%s conditioning, %d ref frames)" % (voice, "cached" if cached else "fresh", p["refFrames"]))
        return p

    # ---------------------------------------------------------------- synthesis

    def generate(self, text, voice, speed):
        """Yield one float32 numpy chunk per sentence, each normalised to the profile's loudness."""
        from f5_tts_mlx.utils import convert_char_to_pinyin

        mx, np = self.mx, self.np
        p = self.profile(voice)
        ref_frames = p["refFrames"]
        rate = p["speed"] * (speed if 0.5 <= speed <= 2.0 else 1.0)
        target = p["loudness"] or TARGET_RMS

        for sentence in split_sentences(text):
            wave, _ = self.model.sample(
                p["mel"],
                text=convert_char_to_pinyin([p["text"] + " " + sentence]),
                duration=None,
                steps=p["steps"],
                method="rk4",
                cfg_strength=p["cfg"],
                sway_sampling_coef=p["sway"],
                speed=rate,
                seed=p["seed"],
            )
            # sample() returns the reference followed by the new speech; drop the reference.
            hop = self.model._mel_spec.hop_length
            wave = wave[ref_frames * hop:]
            mx.eval(wave)
            chunk = np.array(wave, dtype="float32")
            if chunk.size == 0:
                continue
            # Hold every sentence at the same loudness: without this, sentence two of a
            # reply can arrive noticeably louder or thinner than sentence one.
            r = float(np.sqrt(np.mean(chunk.astype("float64") ** 2)) + 1e-9)
            chunk = (chunk * (target / r)).astype("float32")
            peak = float(np.max(np.abs(chunk))) if chunk.size else 0.0
            if peak > 0.99:
                chunk = (chunk * (0.99 / peak)).astype("float32")
            yield chunk


class Server:
    def __init__(self, engine):
        self.engine = engine
        self.jobs = queue.Queue()
        self.lock = threading.Lock()
        self.cancelled = set()
        self.cancel_gen = 0
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
                with self.lock:
                    gen = self.cancel_gen
                self.jobs.put({"op": "synth", "id": sid, "text": text[:4000], "voice": cmd.get("voice"), "speed": speed, "gen": gen, "at": time.monotonic()})
            elif op == "warm":
                self.jobs.put({"op": "warm", "id": "", "gen": None})
            elif op == "prime":
                voices = cmd.get("voices")
                if isinstance(voices, list):
                    self.jobs.put({"op": "prime", "id": "", "gen": None, "voices": [v for v in voices[:8] if isinstance(v, str)]})
            else:
                log("unknown op %r" % (op,))
        self.jobs.put(None)

    def warm(self, voice=None):
        """Run the Metal kernels once so the first real line is not the slow one."""
        t = time.monotonic()
        if voice and valid_voice(voice):
            try:
                for _ in self.engine.generate("Okay.", voice, 1.0):
                    break
            except Exception as e:
                log("warm-up with %s failed: %s: %s" % (voice, type(e).__name__, e))
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
            for chunk in self.engine.generate(job["text"], job["voice"], job["speed"]):
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
        except Exception as e:
            log("synth %s failed: %s: %s" % (sid, type(e).__name__, e))
            frame({"type": "error", "id": sid, "message": "%s: %s" % (type(e).__name__, str(e)[:300])})
            return
        synth_ms = (time.monotonic() - t) * 1000
        audio_ms = samples * 1000.0 / SAMPLE_RATE
        rtf = synth_ms / audio_ms if audio_ms else 0.0
        log("synth %s: %d chars, voice=%s, %d ms for %d ms of audio (rtf %.3f), first sentence %d ms" % (
            sid, len(job["text"]), job["voice"], synth_ms, audio_ms, rtf, first_ms or 0))
        frame({"type": "done", "id": sid, "seq": seq, "synthMs": round(synth_ms), "audioMs": round(audio_ms), "rtf": round(rtf, 4), "firstMs": round(first_ms or 0)})
        with self.lock:
            self.cancelled.discard(sid)

    def prime(self, voices):
        """Load (and cache) the conditioning for the voices a call is about to use."""
        for v in voices:
            if not valid_voice(v):
                continue
            t = time.monotonic()
            try:
                self.engine.profile(v)
                ms = (time.monotonic() - t) * 1000
                if ms > 5:
                    log("primed %s in %d ms" % (v, ms))
            except Exception as e:
                log("priming %s failed: %s: %s" % (v, type(e).__name__, e))

    def run(self):
        threading.Thread(target=self.reader, daemon=True).start()
        while True:
            job = self.jobs.get()
            if job is None:
                log("stdin closed; exiting")
                return
            if job["op"] == "warm":
                frame({"type": "warm", "ms": round(self.warm_ms or 0)})
            elif job["op"] == "prime":
                self.prime(job["voices"])
            else:
                self.synth(job)


def main(argv):
    profiles_dir = None
    voice = None
    self_test = None
    quant = None
    it = iter(argv)
    for a in it:
        if a == "--profiles-dir":
            profiles_dir = next(it, None)
        elif a == "--voice":
            voice = next(it, None)
        elif a == "--quant":
            try:
                quant = int(next(it, ""))
            except ValueError:
                quant = None
        elif a == "--self-test":
            self_test = next(it, "Hello there.")
    if not profiles_dir or not os.path.isdir(profiles_dir):
        log("no profiles dir (--profiles-dir)")
        frame({"type": "error", "message": "No cloned voices were found."})
        return 2

    engine = Engine(profiles_dir, quant)
    try:
        load_ms = engine.load()
    except Exception as e:
        log("load failed: %s: %s" % (type(e).__name__, e))
        frame({"type": "error", "message": "The cloned voice couldn't load: %s" % str(e)[:300]})
        return 1
    frame({"type": "ready", "sampleRate": SAMPLE_RATE, "loadMs": round(load_ms)})
    server = Server(engine)
    server.warm(voice)
    if self_test is not None:
        server.synth({"id": "self-test", "text": self_test, "voice": voice, "speed": 1.0, "gen": server.cancel_gen, "at": time.monotonic()})
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
