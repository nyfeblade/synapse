#!/bin/sh
# Set up Synapse's own Python environment for the Qwen3 voice, without touching anything
# the user already has: a voice path outside Synapse's own data may carry an mlx-audio far too
# old for this model, and it must not be upgraded underneath whatever else depends on it.
#
#   install.sh [target-dir]       (default: ~/Library/Application Support/Synapse/qwen)
#
# An existing usable environment is detected and left alone, so running this twice is cheap.
#
# Costs, measured on an M-series Mac: about 600 MB for the environment, and 1.8 GB of model
# weights fetched into ~/.cache/huggingface the first time a line is spoken
# (mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit, plus its speech tokenizer).
#
# mlx-audio 0.5.5 is the floor: anything older does not know the `qwen3_tts` model type and
# fails the load with "Model type qwen3_tts not supported". Nothing is pinned above it —
# unlike F5, this model is served by current mlx-audio and current mlx.
set -eu

TARGET="${1:-$HOME/Library/Application Support/Synapse/qwen}"
VENV="$TARGET/.venv"
MIN_MLX_AUDIO="0.5.5"
MODEL="mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"

# The check the app itself runs: mlx-audio is importable AND new enough for this model type.
check_env() {
  "$1" - "$MIN_MLX_AUDIO" <<'PY' >/dev/null 2>&1
import importlib.util as u, sys
floor = tuple(int(p) for p in sys.argv[1].split("."))
for m in ("mlx", "mlx_audio", "numpy"):
    assert u.find_spec(m) is not None, m
import importlib.metadata as md
have = tuple(int(p) for p in md.version("mlx-audio").split(".")[:3])
assert have >= floor, "mlx-audio %s < %s" % (have, floor)
from mlx_audio.tts.utils import get_model_and_args
get_model_and_args("qwen3_tts", {})
PY
}

if [ -x "$VENV/bin/python" ] && check_env "$VENV/bin/python"; then
  echo "Qwen3 is already set up in $VENV; nothing to do."
  exit 0
fi

PY=""
for c in python3.13 python3.12 python3.11 python3; do
  if command -v "$c" >/dev/null 2>&1; then
    v=$("$c" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "")
    case "$v" in
      3.11|3.12|3.13|3.14) PY="$c"; break ;;
    esac
  fi
done
if [ -z "$PY" ]; then
  echo "The Qwen3 voice needs Python 3.11 or newer. Install one (for example: brew install python@3.13) and run this again." >&2
  exit 1
fi

free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
if [ "${free_gb:-99}" -lt 6 ]; then
  echo "The Qwen3 voice needs about 2.5 GB free (environment plus weights); this disk has ${free_gb} GB." >&2
  exit 1
fi

echo "Creating $VENV with $PY"
mkdir -p "$TARGET"
"$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet "mlx-audio>=$MIN_MLX_AUDIO"

if ! check_env "$VENV/bin/python"; then
  echo "The environment installed but still can't load a qwen3_tts model. Check the mlx-audio version in $VENV." >&2
  exit 1
fi
"$VENV/bin/python" -c 'import importlib.metadata as md, mlx.core as mx; print("mlx-audio %s ready (mlx %s)" % (md.version("mlx-audio"), mx.__version__))'

echo "Done. The weights (~1.8 GB) are fetched the first time a Bot set to a Qwen3 voice speaks:"
echo "  $VENV/bin/python -m mlx_audio.tts.generate --model $MODEL --text 'Hello.' --voice vivian"
echo "downloads them ahead of time if you would rather not wait on the first line."
