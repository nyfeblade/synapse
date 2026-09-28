#!/usr/bin/env python3
"""LOOK's probe for bug 190 — "Qwen3 voice still glitches at a question" (dev only).

Drives the REAL sidecar engine (native/qwen/qwen_server.py, imported, not copied) and records, for
every line, BOTH what the model produced (Engine._chunks, before any gain) and what the sidecar
hands the app (Engine.generate: gain, glide, rail) — chunk by chunk, from the same render. The app
side of the chain (tts-dsp.ts) is then run over the sidecar's output by qwen-question.mjs --probe.

  python qwen-question-probe.py --model-dir DIR --out DIR --levels levels.json [--voices vivian,ryan]

Writes <out>/raw/<quality>-<voice>-<n>.{model,sidecar}.f32 + .json (chunk sizes) and lines.json.
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "native", "qwen"))
import qwen_server as q  # noqa: E402

LINES = [
    "Hey, what's up?",
    "Hey, what's up.",
    "Should I send it now?",
    "Should I send it now.",
    "What can I do for you?",
    "What can I do for you.",
    "Do you want me to put the whole thing in a note for Thursday?",
    "Do you want me to put the whole thing in a note for Thursday.",
    "I pulled the numbers for last quarter. Do you want me to send them over?",
    "I pulled the numbers for last quarter. Do you want me to send them over.",
]


def arg(name, dflt=None):
    a = sys.argv
    return a[a.index("--" + name) + 1] if "--" + name in a else dflt


def main():
    model_dir = arg("model-dir")
    out = arg("out")
    voices = arg("voices", "vivian,ryan").split(",")
    raw = os.path.join(out, "raw")
    os.makedirs(raw, exist_ok=True)
    # The installed app's learned levels (bug 182), copied, so the probe starts each voice where the
    # app would and never writes to the user's own file.
    cache = tempfile.mkdtemp(prefix="qwen-probe-")
    if arg("levels") and os.path.isfile(arg("levels")):
        shutil.copy(arg("levels"), os.path.join(cache, "levels.json"))
    eng = q.Engine(model_dir, voices[0], q.DEFAULT_TARGET_RMS, cache_dir=cache)
    eng.load()
    q.Server(eng).warm()
    np = eng.np
    orig = eng._chunks
    try:
        for voice in voices:
            for n, text in enumerate(LINES):
                for quality in ("live", "full"):
                    model = []

                    def spy(*a, **k):
                        for c in orig(*a, **k):
                            model.append(np.array(c, dtype=np.float32))
                            yield c

                    eng._chunks = spy
                    side = [np.asarray(c, dtype=np.float32) for c in eng.generate(text, voice, 1.0, quality, 0.064, None)]
                    name = "%s-%s-%d" % (quality, voice, n)
                    for kind, parts in (("model", model), ("sidecar", side)):
                        a = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
                        a.astype("<f4").tofile(os.path.join(raw, "%s.%s.f32" % (name, kind)))
                        with open(os.path.join(raw, "%s.%s.json" % (name, kind)), "w") as f:
                            json.dump([int(len(p)) for p in parts], f)
                    sys.stderr.write("%s  %s\n" % (name, text))
    finally:
        eng._chunks = orig
        shutil.rmtree(cache, ignore_errors=True)
    with open(os.path.join(out, "lines.json"), "w") as f:
        json.dump({"voices": voices, "lines": LINES}, f, indent=1)


if __name__ == "__main__":
    main()
