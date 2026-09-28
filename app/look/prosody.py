#!/usr/bin/env python3
"""LOOK's measuring tape for the voice: does Kokoro actually ASK a question? (dev only)

Synthesizes matched pairs through the app's own Kokoro sidecar (native/kokoro/kokoro_server.py —
the runtime and model the app bundles) and measures the pitch contour in plain numpy:
autocorrelation F0, a 5-frame median filter, and an RMS silence track. No new dependencies.

  /usr/bin/arch -arm64 .build-cache/stage/kokoro/python/bin/python3.12 -s -E -B app/look/prosody.py \
      --model-dir .build-cache/stage/kokoro/model [--voices af_heart,bm_george] [--speeds 1.0]
      [--json out.json] [--wav-dir DIR] [--dsp]

Dev only: app/scripts/package.mjs ships an ALLOWLIST (dist, node_modules, package.json), so nothing
under look/ can reach the packaged build.
"""
import argparse
import importlib.util
import json
import math
import os
import statistics
import subprocess
import tempfile
import time
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.join(HERE, "..", "native", "kokoro", "kokoro_server.py")
SR = 24000

# The curated set from main/native/kokoro.ts (KOKORO_VOICES), in the same order.
CURATED = ["af_heart", "am_michael", "bf_emma", "bm_george", "af_bella", "am_fenrir", "af_nicole", "am_puck", "bm_fable"]

# Matched pairs: same words, only the punctuation differs.
CASES = [
    ("stmt", "You want me to send it."),
    ("ques", "You want me to send it?"),
    ("comma", "So, after that, we can send it."),
    ("nocomma", "So after that we can send it."),
    ("excl", "No way!"),
]

# The engine A/B set: what a call actually says. RAW text — the renderer's speechText() normalizes money
# and abbreviations before either engine sees them, so this measures what each engine does on its own.
AB_CASES = [
    ("stmt", "You want me to send it."),
    ("ques", "You want me to send it?"),
    ("comma", "So, after that, we can send it."),
    ("money", "The total was $1,240.50, up 12% from 2019."),
    ("abbrev", "Dr. Smith will see you at 3:30 p.m., e.g. after lunch."),
    ("twosent", "I sent it. Let me know what you think."),
]


# ---- measurement: plain numpy, no extra deps ----
def _pass(x, sr, fmin, fmax, frame, hop, rms_gate, peak_gate):
    lo, hi = max(2, int(sr / fmax)), int(sr / fmin)
    times, f0s, rmss, confs = [], [], [], []
    frames = []
    for start in range(0, max(0, len(x) - frame), hop):
        w = x[start:start + frame].astype(np.float64)
        frames.append((start, w, float(np.sqrt(np.mean(w * w))) if len(w) else 0.0))
    peak_rms = max([r for _, _, r in frames], default=0.0)
    for start, w, rms in frames:
        times.append(start * 1000.0 / sr)
        rmss.append(rms)
        # Kokoro pads with near-silence and ends on breath; both autocorrelate to nonsense, so a frame
        # has to carry real energy (relative to this line's own peak) before its lag peak is believed.
        if rms < max(3e-3, peak_rms * rms_gate):
            f0s.append(0.0)
            confs.append(0.0)
            continue
        w = w - w.mean()
        w = w * np.hanning(len(w))
        n = 1 << (2 * len(w) - 1).bit_length()
        spec = np.fft.rfft(w, n)
        ac = np.fft.irfft(spec * np.conj(spec), n)[:hi + 2]
        if ac[0] <= 0 or hi <= lo:
            f0s.append(0.0)
            confs.append(0.0)
            continue
        ac = ac / ac[0]
        seg = ac[lo:hi]
        k = int(np.argmax(seg)) + lo
        # Octave guard: a sub-harmonic at 2k that is nearly as strong is the real period.
        for mult in (2, 3):
            k2 = k * mult
            if k2 < hi and ac[k2] > 0.85 * ac[k]:
                k = k2
        peak = float(ac[k])
        if peak < peak_gate:
            f0s.append(0.0)
            confs.append(0.0)
            continue
        if 0 < k < len(ac) - 1:
            a, b, c = ac[k - 1], ac[k], ac[k + 1]
            d = a - 2 * b + c
            k = k + (0.5 * (a - c) / d if d != 0 else 0.0)
        f0s.append(sr / k if k > 0 else 0.0)
        confs.append(peak)
    return np.array(times), np.array(f0s), np.array(rmss), np.array(confs)


def f0_track(x, sr=SR, fmin=60.0, fmax=400.0, frame=1024, hop=240):
    """Autocorrelation F0 per 10 ms hop, in two passes: a confident pass fixes this voice's register,
    then the search is locked to [0.55x, 1.9x] of it. Without the lock, bm_fable's 145 Hz line reported
    a 1678 Hz "final syllable" — a trailing breath the first pass happily locked onto.
    Returns (times_ms, f0_hz, rms); f0 = 0 where unvoiced."""
    t, rough, rms, conf = _pass(x, sr, fmin, fmax, frame, hop, 0.15, 0.50)
    good = rough[(rough > 0) & (conf >= 0.55)]
    if len(good) < 5:
        t, f0, rms, _ = _pass(x, sr, fmin, fmax, frame, hop, 0.10, 0.40)
        return t, f0, rms
    med = float(np.median(good))
    t, f0, rms, _ = _pass(x, sr, max(fmin, med * 0.55), min(fmax * 2, med * 1.9), frame, hop, 0.10, 0.40)
    return t, f0, rms


def median5(f0):
    """Kills the odd octave jump without smearing a real ramp."""
    out = f0.copy()
    for i in range(len(f0)):
        w = [v for v in f0[max(0, i - 2):i + 3] if v > 0]
        out[i] = statistics.median(w) if w and f0[i] > 0 else f0[i]
    return out


def semitones(a, b):
    """a relative to b, in semitones (positive = a is higher)."""
    if a <= 0 or b <= 0:
        return float("nan")
    return 12.0 * math.log2(a / b)


def voiced_spans(f0):
    spans, s = [], None
    for i, v in enumerate(f0):
        if v > 0 and s is None:
            s = i
        elif v <= 0 and s is not None:
            spans.append((s, i))
            s = None
    if s is not None:
        spans.append((s, len(f0)))
    return [sp for sp in spans if sp[1] - sp[0] >= 3]  # >= 30 ms


def speech_bounds(rms, frac=0.05):
    """(first, last) frame index above `frac` of peak — Kokoro pads ~250 ms head and ~400 ms tail."""
    if not len(rms):
        return 0, 0
    t = float(np.max(rms)) * frac
    loud = [i for i, v in enumerate(rms) if v >= t]
    return (loud[0], loud[-1]) if loud else (0, len(rms) - 1)


def silences(rms, hop_ms=10.0, thresh=None, min_ms=30.0):
    """Internal silences (leading/trailing trimmed): [(start_ms, len_ms)]."""
    if not len(rms):
        return []
    peak = float(np.max(rms))
    t = thresh if thresh is not None else max(1e-3, peak * 0.05)
    loud = [i for i, v in enumerate(rms) if v >= t]
    if not loud:
        return []
    a, b = loud[0], loud[-1]
    out, s = [], None
    for i in range(a, b + 1):
        if rms[i] < t and s is None:
            s = i
        elif rms[i] >= t and s is not None:
            if (i - s) * hop_ms >= min_ms:
                out.append((s * hop_ms, (i - s) * hop_ms))
            s = None
    return out


def window_f0(x, end_sample, win_ms=160.0, sr=SR, lock=None):
    """Median F0 over a fixed clock window ending at `end_sample` — the apples-to-apples before/after
    measure, since the DSP moves the voicing boundaries the span-based one keys off. `lock` pins the
    search to one register (the original's median): on a 160 ms snippet of a creaky male tail the
    two-pass tracker otherwise picks a different octave before and after, and reports -12 st."""
    a = max(0, int(end_sample - sr * win_ms / 1000.0) - 512)
    b = min(len(x), int(end_sample) + 256)
    if b - a < 1200:
        return 0.0
    seg = x[a:b]
    if lock and lock > 0:
        _, f0, _, _ = _pass(seg, sr, lock * 0.62, lock * 1.7, 1024, 240, 0.10, 0.40)
    else:
        _, f0, _ = f0_track(seg)
    v = f0[f0 > 0]
    return round(float(np.median(v)), 1) if len(v) else 0.0


def contour(x):
    """The numbers the question lives or dies by."""
    t, raw, rms = f0_track(x)
    f0 = median5(raw)
    spans = voiced_spans(f0)
    audio_ms = len(x) * 1000.0 / SR
    a0, b0 = speech_bounds(rms)
    pauses = silences(rms)
    m = {
        "audioMs": round(audio_ms, 1),
        "leadMs": round(a0 * 10.0, 0),
        "trailMs": round(audio_ms - b0 * 10.0, 0),
        "speechMs": round((b0 - a0) * 10.0, 0),
        "voicedPct": round(100.0 * float(np.count_nonzero(f0)) / max(1, len(f0)), 1),
        "pauses": [(round(p, 0), round(q, 0)) for p, q in pauses],
        "maxPauseMs": round(max([q for _, q in pauses], default=0.0), 0),
    }
    voiced = f0[f0 > 0]
    m["medianF0"] = round(float(np.median(voiced)), 1) if len(voiced) else 0.0
    if not spans:
        m.update({"finalF0": 0.0, "finalRiseSt": float("nan"), "tailSlopeStPerS": float("nan"), "endMs": 0.0})
        return m
    # The final syllable = the last voiced span; its last 80 ms against its own first 80 ms,
    # and against the utterance's median, is what a listener hears as "asking".
    a, b = spans[-1]
    seg = f0[a:b]
    seg = seg[seg > 0]
    n = max(1, min(len(seg), 8))  # 8 frames = 80 ms
    head = float(np.median(seg[:n]))
    tail = float(np.median(seg[-n:]))
    m["finalSpanMs"] = round((b - a) * 10.0, 0)
    m["finalHeadF0"] = round(head, 1)
    m["finalF0"] = round(tail, 1)
    m["finalRiseSt"] = round(semitones(tail, head), 2)      # rise WITHIN the last syllable
    m["finalVsMedianSt"] = round(semitones(tail, m["medianF0"]), 2)
    # Slope over the last 300 ms of voiced speech, in semitones/second.
    tail_t, tail_f = [], []
    for i in range(len(f0) - 1, -1, -1):
        if f0[i] > 0:
            tail_t.insert(0, t[i])
            tail_f.insert(0, f0[i])
            if tail_t[-1] - tail_t[0] >= 300.0:
                break
    if len(tail_f) >= 5:
        ref = float(np.median(tail_f))
        y = [semitones(v, ref) for v in tail_f]
        sl = np.polyfit(np.array(tail_t) / 1000.0, np.array(y), 1)[0]
        m["tailSlopeStPerS"] = round(float(sl), 2)
        m["tailWindowMs"] = round(tail_t[-1] - tail_t[0], 0)
    else:
        m["tailSlopeStPerS"] = float("nan")
    return m


# ---- the sidecar ----
def load_engine(model_dir, voice):
    spec = importlib.util.spec_from_file_location("kokoro_server", os.path.abspath(SIDECAR))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["kokoro_server"] = mod
    spec.loader.exec_module(mod)
    mod.fast_start(None)
    eng = mod.Engine(model_dir, voice)
    eng.load()
    return eng


def synth(eng, text, voice, speed):
    return np.concatenate(list(eng.generate(text, voice, speed))).astype(np.float32)


def phonemes(eng, text, voice):
    """What the model is actually FED. If "." and "?" phonemize identically, the punctuation never
    reaches the model at all and no voice can ask a question."""
    p = eng._pipeline("b" if voice.startswith("b") else "a")
    return str(p.g2p(text)[0])


def write_wav(path, x):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


# ---- the DSP under test (mirrors main/native/kokoro.ts's questionRamp / commaPause) ----
def speech_end(x, sr=SR, frac=0.02):
    """Last sample carrying speech. Kokoro pads a median 575 ms of silence after the words, so "the
    last 350 ms of the buffer" is mostly that padding — the ramp has to end where the WORDS end."""
    n = int(sr * 0.01)
    if len(x) < n:
        return len(x)
    env = np.array([float(np.sqrt(np.mean(np.square(x[i:i + n])))) for i in range(0, len(x) - n, n)])
    if not len(env):
        return len(x)
    t = float(np.max(env)) * frac
    loud = np.nonzero(env >= t)[0]
    return int((loud[-1] + 1) * n) if len(loud) else len(x)


def voiced_end(x, sr=SR, hop=240, rms_frac=0.08, zcr_max=0.06):
    """Last sample with a PITCH in it. "You want me to send it?" ends in an unvoiced /t/ plus breath:
    ramping to the end of the *speech* puts the whole rise where there is no pitch to hear (measured:
    +0.2 st instead of +2). Energy plus zero-crossing rate finds the vowel's end within ~0-160 ms of a
    full F0 track, for a thousandth of the work."""
    n = len(x) // hop
    if n < 2:
        return len(x)
    fr = x[:n * hop].reshape(n, hop)
    rms = np.sqrt(np.mean(np.square(fr.astype(np.float64)), axis=1))
    zcr = np.mean(np.diff(np.signbit(fr), axis=1) != 0, axis=1)
    peak = float(np.max(rms))
    ok = np.nonzero((rms >= peak * rms_frac) & (zcr <= zcr_max))[0]
    return int((ok[-1] + 1) * hop) if len(ok) else len(x)


def question_ramp(x, sr=SR, semis=1.8, ms=350.0):
    """A smooth pitch ramp over the last `ms` OF SPEECH, +`semis` at the very end. Resample-in-place:
    the tail is read back at a slowly rising rate, so there is no phase break and no warble."""
    end = voiced_end(x, sr)
    n = int(sr * ms / 1000.0)
    # rate(u) rises 1 -> 2**(semis/12) over a raised cosine, reaching full lift at 70% of the window
    # and HOLDING — so the ~0-160 ms of slack in voiced_end still lands the vowel on the plateau.
    u = np.minimum(1.0, (np.arange(n) + 1.0) / (0.70 * n))
    rate = 1.0 + (2.0 ** (semis / 12.0) - 1.0) * (0.5 - 0.5 * np.cos(math.pi * u))
    pos = np.cumsum(rate) - rate[0]
    src = int(math.ceil(pos[-1])) + 2  # reading faster than we write: SOURCE more than we replace
    if n < 64 or end < src + 16:
        return x.copy()
    tail = x[end - src:end].astype(np.float64)
    out = x.copy()
    # Line the read head's last sample up with the tail's last sample, so the full rise lands on the
    # very end of the word. (Without this the ramp peaked ~18 ms early and measured +0.2 st, not +2.)
    pos = pos * ((src - 2) / pos[-1])
    i0 = np.clip(pos.astype(np.int64), 0, src - 2)
    frac = pos - i0
    warped = tail[i0] * (1 - frac) + tail[i0 + 1] * frac
    # Both seams are cross-faded rather than cut (the one at `end` too: the warped tail arrives at its
    # own phase and whatever follows carries on at the original's, which ticks). Mirrors
    # rampQuestionTail() in main/native/kokoro.ts — keep the two in step.
    join = min(n // 4, int(sr * 0.020))
    w = np.linspace(0.0, 1.0, join)
    warped[:join] = x[end - n:end - n + join] * (1 - w) + warped[:join] * w
    out2 = min(n // 8, int(sr * 0.004))
    w2 = np.linspace(1.0, 0.0, out2)
    warped[-out2:] = x[end - out2:end] * (1 - w2) + warped[-out2:] * w2
    out[end - n:end] = warped.astype(np.float32)
    return out


# ---- the other engine: Apple's own voices, for the A/B ----
# `say` renders to a file without playing, offline, at the sidecar's own 24 kHz — so both engines go
# through exactly the same measuring tape. Note Siri voices (com.apple.ttsbundle.siri_*) are NOT
# reachable this way: `say -v '?'` lists "Aaron (Enhanced)" but no Siri bundle.
APPLE_VOICES = ["Ava (Premium)", "Zoe (Premium)", "Serena (Premium)", "Matilda (Premium)", "Isha (Premium)",
                "Ava (Enhanced)", "Allison (Enhanced)", "Aaron (Enhanced)"]
# Apple's rate is words per minute (the default voice is ~175); our speeds map onto it.
APPLE_WPM = {0.95: 166, 1.0: 175, 1.05: 184}


def apple_synth(text, voice, speed, tmp):
    """(pcm, first_audio_ms, synth_ms). `say` is one shot, so "first audio" is the whole render."""
    wav = os.path.join(tmp, "say.wav")
    t = time.monotonic()
    subprocess.run(["say", "-v", voice, "-r", str(APPLE_WPM.get(speed, int(round(175 * speed)))),
                    "-o", wav, "--data-format=LEI16@24000", text],
                   check=True, capture_output=True)
    ms = (time.monotonic() - t) * 1000
    with wave.open(wav, "rb") as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    return x, ms, ms


def main(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--engine", default="kokoro", choices=("kokoro", "apple"))
    p.add_argument("--model-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".build-cache", "stage", "kokoro", "model"))
    p.add_argument("--voices", default=None)
    p.add_argument("--speeds", default="0.95,1.0,1.05")
    p.add_argument("--json", default=None)
    p.add_argument("--wav-dir", default=None)
    p.add_argument("--cases", default="pairs", choices=("pairs", "ab"), help="ab: the engine A/B set (numbers, money, abbreviations, two sentences)")
    p.add_argument("--dsp", action="store_true", help="also measure the question ramp applied to the statement/question")
    p.add_argument("--text", default=None, help="one-off: measure this text instead of the matched pairs")
    a = p.parse_args(argv)

    model_dir = os.path.expanduser(a.model_dir)
    voices = [v for v in (a.voices or (",".join(APPLE_VOICES) if a.engine == "apple" else ",".join(CURATED))).split(",") if v]
    speeds = [float(s) for s in a.speeds.split(",") if s]
    cases = [("one", a.text)] if a.text else (AB_CASES if a.cases == "ab" else CASES)

    tmp = tempfile.mkdtemp(prefix="prosody-")
    eng = load_engine(model_dir, voices[0]) if a.engine == "kokoro" else None
    rows = []
    for v in voices:
        for sp in speeds:
            for name, text in cases:
                if eng is not None:
                    t0 = time.monotonic()
                    x = synth(eng, text, v, sp)
                    first_ms = synth_ms = (time.monotonic() - t0) * 1000
                else:
                    x, first_ms, synth_ms = apple_synth(text, v, sp, tmp)
                m = contour(x)
                m.update({"voice": v, "speed": sp, "case": name, "text": text, "engine": a.engine,
                          "synthMs": round(synth_ms), "firstMs": round(first_ms),
                          "rtf": round(synth_ms / m["audioMs"], 3) if m["audioMs"] else 0.0})
                if eng is not None:
                    m["ps"] = phonemes(eng, text, v)
                if a.wav_dir:
                    tag = "%s-%s-%s-%s" % (a.engine, v.replace(" ", "").replace("(", "").replace(")", ""), str(sp).replace(".", ""), name)
                    write_wav(os.path.join(os.path.expanduser(a.wav_dir), tag + ".wav"), x)
                if a.dsp and eng is not None and name in ("ques", "stmt"):
                    y = question_ramp(x)
                    d = contour(y)
                    # Before/after over the SAME clock window (the last 120 ms of the original's voiced
                    # speech): comparing each one's own "last voiced span" lets the span change identity.
                    w, lock = voiced_end(x), m["medianF0"]
                    m["tailF0"] = window_f0(x, w, lock=lock)
                    m["dsp"] = {"finalF0": d["finalF0"], "finalRiseSt": d["finalRiseSt"],
                                "tailSlopeStPerS": d["tailSlopeStPerS"], "medianF0": d["medianF0"],
                                "tailF0": window_f0(y, w, lock=lock)}
                    if a.wav_dir:
                        write_wav(os.path.join(os.path.expanduser(a.wav_dir), "%s_%s_%s_dsp.wav" % (v, str(sp).replace(".", ""), name)), y)
                rows.append(m)
                print(json.dumps(m), flush=True)
    if a.json:
        with open(os.path.expanduser(a.json), "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
