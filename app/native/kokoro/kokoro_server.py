#!/usr/bin/env python3
"""Synapse's Kokoro sidecar: local neural text-to-speech for voice calls and previews (bug 107).

Long-running. Loads the Kokoro model once, warms it with a tiny synth, then serves requests.

stdin: one JSON object per line —
  {"op": "warm"}                                         reply: a "warm" frame (once warm)
  {"op": "synth", "id", "text", "voice", "speed"}      reply: "audio" frames, then "done" (or "error")
  {"op": "cancel", "id"}   drop that request (queued or mid-synth); no "id" = drop everything
stdin closing ends the process.

stdout: length-prefixed binary frames, nothing else —
  u32 big-endian N, then N bytes: u16 big-endian H, H bytes of UTF-8 JSON header, N-2-H bytes of
  mono float32 little-endian PCM at 24 kHz (audio frames only).
  Headers: ready {sampleRate, loadMs} | warm {ms} | audio {id, seq, samples} |
           done {id, seq, synthMs, audioMs, rtf, firstMs} | error {id?, message}
stderr: human-readable log lines, "[kokoro +<ms>] ...".

  {"op": "prime", "voices": [...]}   build those voices' accent pipelines and load their packs, ahead of use

Usage: kokoro_server.py --model-dir DIR [--voice af_heart] [--cache-dir DIR] [--self-test "text"]
Python and the model are the user's own (never bundled); the app finds them (main/native/kokoro.ts).

Bug 134 (cold start, measured on the owner's Mac): the load was dominated by Python work Kokoro never
uses, not by the weights. transformers + torch were imported only to parse config.json (~2.6 s): the
config is read directly and torch is never imported (spaCy's thinc imports it when present; our voices
load from safetensors). The venv's modules were recompiled on every start (bytecode writes are off
under -E): --cache-dir keeps compiled bytecode in Synapse's own cache folder, never in the user's venv.
Only the accent of the voice asked for is built at start; the other waits for a "prime" or first use.
"""
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
SAMPLE_RATE = 24000
FRAME_SAMPLES = SAMPLE_RATE // 2  # an audio frame carries at most 0.5 s
VOICE_RE = "abcdefghijklmnopqrstuvwxyz_"
_out = sys.stdout.buffer
_out_lock = threading.Lock()


def log(msg):
    sys.stderr.write("[kokoro +%dms] %s\n" % (int((time.monotonic() - T0) * 1000), msg))
    sys.stderr.flush()


def frame(header, pcm=b""):
    h = json.dumps(header, separators=(",", ":")).encode("utf-8")
    body = struct.pack(">H", len(h)) + h + pcm
    with _out_lock:
        _out.write(struct.pack(">I", len(body)) + body)
        _out.flush()


def valid_voice(v):
    return isinstance(v, str) and 3 <= len(v) <= 40 and all(c in VOICE_RE for c in v)


def fast_start(cache_dir):
    """Before any heavy import: compiled bytecode in our cache folder, and no torch (never needed here)."""
    if cache_dir:
        try:
            os.makedirs(os.path.join(cache_dir, "pycache"), exist_ok=True)
            sys.pycache_prefix = os.path.join(cache_dir, "pycache")
            sys.dont_write_bytecode = False
        except OSError as e:
            log("no bytecode cache (%s)" % e)
    # thinc (spaCy) imports torch when it is installed; Kokoro on MLX never uses it, and it costs ~1.6 s.
    sys.modules.setdefault("torch", None)
    short_espeak_path()


# espeak-ng keeps its data folder in a 160-byte buffer (N_PATH_HOME) and silently falls back to the path
# it was BUILT with when the real one is longer, so every out-of-vocabulary word failed. The bundled
# runtime sits deep inside Synapse.app, and deeper still when macOS translocates an app run from the
# download folder. espeak resolves links, so a COPY of the (English-only, ~2 MB) data in the temp
# folder stands in for the long path (portable install). It is re-copied when the source changes.
ESPEAK_PATH_MAX = 150


def short_espeak_path():
    try:
        import espeakng_loader
        real = espeakng_loader.get_data_path()
    except Exception:
        return
    if len(real.encode("utf-8")) < ESPEAK_PATH_MAX:
        return
    import shutil
    import tempfile
    root = os.path.join(tempfile.gettempdir(), "synapse-espeak-%d" % os.getuid())
    data = os.path.join(root, "espeak-ng-data")
    stamp = os.path.join(root, "source")
    want = "%s\n%d\n" % (real, int(os.stat(os.path.join(real, "phondata")).st_mtime))
    try:
        with open(stamp, encoding="utf-8") as f:
            current = f.read() == want and os.path.isfile(os.path.join(data, "phontab"))
    except OSError:
        current = False
    if not current:
        try:
            tmp = "%s.%d" % (root, os.getpid())
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.copytree(real, os.path.join(tmp, "espeak-ng-data"))
            with open(os.path.join(tmp, "source"), "w", encoding="utf-8") as f:
                f.write(want)
            shutil.rmtree(root, ignore_errors=True)
            os.replace(tmp, root)
        except OSError as e:
            log("espeak data path is %d bytes and no short copy could be made (%s)" % (len(real), e))
            return
    espeakng_loader.get_data_path = lambda: data


class Engine:
    def __init__(self, model_dir, default_voice):
        self.model_dir = model_dir
        self.default_voice = default_voice
        self.model = None
        self.voices = {}
        self.np = None

    def load(self):
        t = time.monotonic()
        import numpy as np
        import mlx_audio.tts.utils as utils
        slow_config = utils.load_config

        def local_config(model_path, **kwargs):
            # mlx_audio imports transformers (and with it torch) just to read this file.
            try:
                with open(os.path.join(str(model_path), "config.json"), encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, ValueError):
                return slow_config(model_path, **kwargs)

        utils.load_config = local_config
        from pathlib import Path
        self.np = np
        self.model = utils.load_model(Path(self.model_dir))
        ms = (time.monotonic() - t) * 1000
        log("model loaded in %d ms from %s" % (ms, self.model_dir))
        return ms

    def _voice_pack(self, name):
        """The voice's style pack, from the model dir's own voices/*.safetensors (never downloaded)."""
        if name not in self.voices:
            import mlx.core as mx
            path = os.path.join(self.model_dir, "voices", name + ".safetensors")
            if not os.path.isfile(path):
                raise ValueError("unknown voice %s" % name)
            d = mx.load(path)
            self.voices[name] = d["voice"] if "voice" in d else next(iter(d.values()))
        return self.voices[name]

    def _pipeline(self, lang):
        p = self.model._get_pipeline(lang)
        if not getattr(p, "_synapse_local", False):
            # The pipeline resolves a voice name through the Hugging Face hub; ours come from disk.
            p.load_single_voice = self._voice_pack
            p._synapse_local = True
        return p

    def generate(self, text, voice, speed):
        """Yields float32 numpy chunks as the model produces them (one per text segment)."""
        voice = voice if valid_voice(voice) else self.default_voice
        lang = "b" if voice.startswith("b") else "a"
        self._pipeline(lang)
        for result in self.model.generate(text=text, voice=voice, speed=speed, lang_code=lang):
            a = result.audio
            try:
                import mlx.core as mx
                mx.eval(a)
            except Exception:
                pass
            yield self.np.asarray(a, dtype=self.np.float32).reshape(-1)


class Server:
    def __init__(self, engine):
        self.engine = engine
        self.jobs = queue.Queue()
        self.lock = threading.Lock()
        self.cancelled = set()
        self.cancel_gen = 0  # bumped by a cancel-all: every job queued before it is dropped
        self.warm_ms = None
        self.warm_waiters = 0

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

    def warm(self):
        t = time.monotonic()
        # The default voice's accent only: the other one is built when a "prime" or a line asks for it.
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
        except Exception as e:  # a bad voice, a G2P failure, an MLX error: this line only
            log("synth %s failed: %s: %s" % (sid, type(e).__name__, e))
            frame({"type": "error", "id": sid, "message": "%s: %s" % (type(e).__name__, str(e)[:300])})
            return
        synth_ms = (time.monotonic() - t) * 1000
        audio_ms = samples * 1000.0 / SAMPLE_RATE
        rtf = synth_ms / audio_ms if audio_ms else 0.0
        log("synth %s: %d chars, voice=%s, %d ms for %d ms of audio (rtf %.3f), first chunk %d ms, queued %d ms" % (
            sid, len(job["text"]), job["voice"], synth_ms, audio_ms, rtf, first_ms or 0, (t - job["at"]) * 1000))
        frame({"type": "done", "id": sid, "seq": seq, "synthMs": round(synth_ms), "audioMs": round(audio_ms), "rtf": round(rtf, 4), "firstMs": round(first_ms or 0)})
        with self.lock:
            self.cancelled.discard(sid)

    def prime(self, voices):
        """The voices a call will use: each accent's pipeline (~0.7 s the first time) and each voice pack,
        built now so no Bot's first line is the slow one. Asked for by the app, never guessed."""
        for v in voices:
            if not valid_voice(v):
                continue
            t = time.monotonic()
            try:
                self.engine._pipeline("b" if v.startswith("b") else "a")
                self.engine._voice_pack(v)
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
    model_dir = None
    voice = "af_heart"
    self_test = None
    cache_dir = None
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
    if not model_dir or not os.path.isfile(os.path.join(model_dir, "config.json")):
        log("no model dir (--model-dir) with a config.json")
        frame({"type": "error", "message": "The Kokoro model folder wasn't found."})
        return 2
    if not valid_voice(voice):
        voice = "af_heart"
    fast_start(cache_dir)
    engine = Engine(model_dir, voice)
    try:
        load_ms = engine.load()
    except Exception as e:
        log("load failed: %s: %s" % (type(e).__name__, e))
        frame({"type": "error", "message": "Kokoro couldn't load: %s" % str(e)[:300]})
        return 1
    frame({"type": "ready", "sampleRate": SAMPLE_RATE, "loadMs": round(load_ms)})
    server = Server(engine)
    try:
        server.warm()
    except Exception as e:
        log("warm-up failed: %s: %s" % (type(e).__name__, e))
        frame({"type": "error", "message": "Kokoro couldn't warm up: %s" % str(e)[:300]})
        return 1
    if self_test is not None:
        server.synth({"id": "self-test", "text": self_test, "voice": voice, "speed": 1.0, "gen": server.cancel_gen, "at": time.monotonic()})
        return 0
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
