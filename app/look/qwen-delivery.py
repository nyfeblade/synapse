"""LOOK's bench for bug 183 — the Qwen voice "speaks like it's trying to sound lazy" (dev only).

Renders the same lines through the real Qwen3-TTS model with the sidecar's own seeding, once per
delivery setting, and MEASURES the delivery instead of judging it by ear:

  charsPerS / syllPerS  speaking rate over the speech (lead and tail silence excluded)
  pausesMs              every silence of 120 ms or more inside the line
  f0StdSt               how much the pitch moves (std of the voiced frames, in semitones)
  lowF0Pct              voiced frames under 0.7x the line's median F0 — creak / vocal fry
  firstAudioMs          live (streamed) render: time to the first audio, median of 3, per setting

  <qwen venv python> app/look/qwen-delivery.py [--voices vivian,ryan] [--out DIR] [--model-dir DIR]

Writes <out>/<setting>-<voice>-<n>.wav (24 kHz) and report.json. Dev only.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "native", "qwen"))
import qwen_server as qs  # noqa: E402  (the sidecar's own seeding, level and settings)

LINES = [
    "I pulled the numbers for last quarter, and they look better than we expected.",
    "Sure, I can move the meeting to Thursday afternoon and let everyone know.",
    "Do you want me to send the summary to the team now, or wait until tomorrow?",
]
SR = 24000


def settings():
    """Every delivery setting measured: the shipped one first, then the candidates."""
    crisp = getattr(qs, "DEFAULT_INSTRUCT", None) or "Speak clearly and crisply at a brisk, steady pace, in a confident, friendly, attentive tone."
    return [
        ("shipped", {}),
        ("instruct", {"instruct": crisp}),
        ("temp07", {"temperature": 0.7}),
        ("instruct-temp07", {"instruct": crisp, "temperature": 0.7}),
    ]


def rms_blocks(x, hop=240):
    n = len(x) // hop
    return np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1))


def f0_track(x, hop=240, win=960):
    out = []
    lo, hi = SR // 400, SR // 60
    for a in range(0, len(x) - win - hi, hop):
        w = x[a:a + win]
        e0 = float(np.dot(w, w))
        if np.sqrt(e0 / win) < 0.01:
            out.append(0.0)
            continue
        best, lag = 0.0, 0
        for L in range(lo, hi):
            v = x[a + L:a + L + win]
            c = float(np.dot(w, v)) / np.sqrt(e0 * float(np.dot(v, v)) + 1e-12)
            if c > best:
                best, lag = c, L
        out.append(SR / lag if best > 0.6 and lag else 0.0)
    return np.array(out)


def syllables(text):
    return sum(max(1, len(re.findall(r"[aeiouy]+", w.lower().rstrip("e")))) for w in re.findall(r"[A-Za-z']+", text))


def measure(x, text):
    r = rms_blocks(x)
    gate = max(0.003, r.max() * 10 ** (-40 / 20))
    loud = np.where(r >= gate)[0]
    if not len(loud):
        return None
    first, last = loud[0], loud[-1]
    speech_s = (last - first + 1) * 0.01
    pauses, run = [], 0
    for v in r[first:last + 1]:
        if v < gate:
            run += 1
        else:
            if run * 10 >= 120:
                pauses.append(run * 10)
            run = 0
    f0 = f0_track(x[first * 240:(last + 1) * 240])
    v = f0[f0 > 0]
    med = float(np.median(v)) if len(v) else 0.0
    st = 12 * np.log2(v / med) if med else np.zeros(0)
    return {
        "speechS": round(speech_s, 2),
        "charsPerS": round(len(text) / speech_s, 2),
        "syllPerS": round(syllables(text) / speech_s, 2),
        "pausesMs": pauses,
        "f0MedianHz": round(med, 1),
        "f0StdSt": round(float(np.std(st)), 2) if len(st) else None,
        "lowF0Pct": round(100.0 * float(np.mean(v < 0.7 * med)), 1) if med else None,
    }


def wav(path, x):
    import wave
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices", default="vivian,ryan")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "test-reports", "voice-sentence-tail", "qwen-delivery"))
    ap.add_argument("--model-dir", default=None)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    model_dir = a.model_dir
    if not model_dir:
        snaps = os.path.expanduser("~/.cache/huggingface/hub/models--mlx-community--Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit/snapshots")
        model_dir = os.path.join(snaps, sorted(os.listdir(snaps))[0])
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model
    model = load_model(model_dir)
    report = {"model": model_dir, "lines": LINES, "rows": []}
    for name, kw in settings():
        if a.only and name not in a.only.split(","):
            continue
        for voice in a.voices.split(","):
            for n, text in enumerate(LINES):
                mx.random.seed(qs.seed_for(text, voice))
                t = time.monotonic()
                parts = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in model.generate(text=text, voice=voice, **kw)]
                ms = (time.monotonic() - t) * 1000
                x = np.concatenate(parts)
                x = qs.apply_gain(x, qs.gain_for(qs.voiced_rms(x, np), 0.064), np)
                wav(os.path.join(a.out, "%s-%s-%d.wav" % (name, voice, n)), x)
                m = measure(x, text)
                m.update({"setting": name, "voice": voice, "n": n, "rtf": round(ms / (len(x) / SR * 1000), 3)})
                report["rows"].append(m)
                print(json.dumps(m), flush=True)
    # Per setting x voice: the means.
    summary = {}
    for r in report["rows"]:
        k = "%s/%s" % (r["setting"], r["voice"])
        s = summary.setdefault(k, {"charsPerS": [], "syllPerS": [], "f0StdSt": [], "lowF0Pct": [], "pauseMs": [], "rtf": []})
        for f in ("charsPerS", "syllPerS", "f0StdSt", "lowF0Pct", "rtf"):
            if r.get(f) is not None:
                s[f].append(r[f])
        s["pauseMs"].extend(r["pausesMs"])
    # First audio on the live (streamed) path, with and without the instruction: it adds a prefix.
    report["firstAudioMs"] = {}
    for name, kw in settings():
        if a.only and name not in a.only.split(","):
            continue
        for voice in a.voices.split(","):
            times = []
            for _ in range(3):
                mx.random.seed(qs.seed_for(LINES[0], voice))
                t = time.monotonic()
                for r in model.generate(text=LINES[0], voice=voice, stream=True, streaming_interval=qs.STREAM_INTERVAL, **kw):
                    mx.eval(r.audio)
                    times.append((time.monotonic() - t) * 1000)
                    break
            report["firstAudioMs"]["%s/%s" % (name, voice)] = round(sorted(times)[1])
    print("first audio (live):", report["firstAudioMs"])
    report["summary"] = {k: {f: (round(float(np.mean(v)), 2) if v else None) for f, v in s.items()} for k, s in summary.items()}
    for k, s in report["summary"].items():
        print(k, s)
    with open(os.path.join(a.out, "report.json"), "w") as f:
        json.dump(report, f, indent=2)


if __name__ == "__main__":
    main()
