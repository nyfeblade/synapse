#!/bin/sh
# Set up Synapse's own Python environment for cloned voices (F5), without touching
# anything the user already has (any Python or voice setup outside Synapse's own data).
#
#   install.sh <target-dir>       (default: ~/Library/Application Support/Synapse/f5)
#
# Costs, measured on an M1 Pro: about 330 MB for the environment, and about 1.7 GB of
# model weights fetched into ~/.cache/huggingface on the first line spoken
# (model_v1.safetensors 1.35 GB, model_v1_4b 232 MB, duration_v2 86 MB, vocoder 52 MB).
#
# mlx is pinned: f5-tts-mlx 0.2.6 builds a noise tensor with a shape that newer mlx
# rejects (mx.random.normal((C, dur)) where dur is a 0-d array), so it fails on the
# first synthesis with mlx 0.30+. 0.29.3 is the last release that accepts it.
set -eu

TARGET="${1:-$HOME/Library/Application Support/Synapse/f5}"
VENV="$TARGET/.venv"

PY=""
for c in python3.12 python3.11 python3; do
  if command -v "$c" >/dev/null 2>&1; then
    v=$("$c" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "")
    case "$v" in
      3.10|3.11|3.12|3.13) PY="$c"; break ;;
    esac
  fi
done
if [ -z "$PY" ]; then
  echo "Cloned voices need Python 3.10-3.13. Install one (for example: brew install python@3.12) and run this again." >&2
  exit 1
fi

free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
if [ "${free_gb:-99}" -lt 5 ]; then
  echo "Cloned voices need about 2 GB free; this disk has ${free_gb} GB." >&2
  exit 1
fi

echo "Creating $VENV with $PY"
mkdir -p "$TARGET"
"$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet "f5-tts-mlx==0.2.6" "mlx==0.29.3"

"$VENV/bin/python" - <<'PY'
import importlib.util as u
missing = [m for m in ("f5_tts_mlx", "vocos_mlx", "mlx", "soundfile", "numpy") if u.find_spec(m) is None]
assert not missing, "missing: " + ", ".join(missing)
import mlx.core as mx
print("f5-tts-mlx ready (mlx %s)" % mx.__version__)
PY

echo "Done. Record a voice in Settings → Voice; the weights (~1.7 GB) are fetched the first time it speaks."
