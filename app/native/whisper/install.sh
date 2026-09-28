#!/usr/bin/env bash
# Bug 165: build whisper.cpp with Metal into Synapse's OWN directory and fetch the model.
#
# Nothing here touches the user's shell environment: no Homebrew formula is installed, no
# /usr/local or /opt/homebrew path is written, nothing is put on PATH and no voice path outside
# Synapse's own data is read or written. Everything lands under <userData>/whisper:
#
#   <userData>/whisper/lib/            libwhisper.a + the ggml libraries (linked into the helper)
#   <userData>/whisper/include/        whisper.h + the ggml headers
#   <userData>/whisper/models/*.bin    the weights
#   <userData>/whisper/version         what was built, so a re-run is a no-op
#
# CMake is required and is NOT installed system-wide either: if it is missing the official
# universal tarball is unpacked into <userData>/whisper/tools and used from there.
#
# Usage: install.sh [--root DIR] [--model large-v3-turbo-q5_0|small.en] [--force] [--libs-only]
#
# Portable install: `--libs-only --root <repo>/.build-cache/whisper` is what the helper build uses
# (app/native/dictation/build.sh), so a packaged helper never links from the BUILDER's ~/Library.
# Every build targets macOS 14.0 (MACOS_MIN), the app's minimum, never the build SDK's own version.
set -euo pipefail

ROOT="${HOME}/Library/Application Support/Synapse/whisper"
MODEL="large-v3-turbo-q5_0"
FALLBACK="small.en"
FORCE=0
LIBS_ONLY=0
MACOS_MIN="14.0"
# Every Apple silicon Mac (M1 on) has these; -mcpu=native would bake the BUILDER's chip into the helper.
ARM_ARCH="armv8.2-a+dotprod+fp16"
WHISPER_TAG="v1.9.4"
# Bug 295: part of the version stamp, so libraries built before the prefix map (or before it covered Objective-C) are rebuilt once.
BUILD_ID="prefix-map-2"
CMAKE_VER="4.4.3"

while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --libs-only) LIBS_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { echo "[whisper-install] $*"; }
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$ROOT/models" "$ROOT/lib" "$ROOT/include" "$ROOT/tools" "$ROOT/build"

# ---------- 1. the libraries ----------
if [ "$FORCE" = "0" ] && [ -f "$ROOT/version" ] && grep -q "^whisper $WHISPER_TAG macos$MACOS_MIN $ARM_ARCH $BUILD_ID$" "$ROOT/version" 2>/dev/null && [ -f "$ROOT/lib/libwhisper.a" ]; then
  say "whisper.cpp $WHISPER_TAG already built in $ROOT"
else
  # cmake, from Synapse's own copy if the system has none.
  CMAKE="$(command -v cmake || true)"
  if [ -z "$CMAKE" ]; then
    CMAKE="$ROOT/tools/cmake-$CMAKE_VER-macos-universal/CMake.app/Contents/bin/cmake"
    if [ ! -x "$CMAKE" ]; then
      say "fetching cmake $CMAKE_VER (Synapse's own copy; nothing is installed system-wide)"
      curl -fsSL "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VER/cmake-$CMAKE_VER-macos-universal.tar.gz" \
        -o "$ROOT/tools/cmake.tar.gz"
      tar xzf "$ROOT/tools/cmake.tar.gz" -C "$ROOT/tools"
      rm -f "$ROOT/tools/cmake.tar.gz"
    fi
  fi

  SRC="$ROOT/build/whisper.cpp-${WHISPER_TAG#v}"
  if [ ! -d "$SRC" ]; then
    say "fetching whisper.cpp $WHISPER_TAG"
    curl -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$WHISPER_TAG.tar.gz" -o "$ROOT/build/src.tar.gz"
    tar xzf "$ROOT/build/src.tar.gz" -C "$ROOT/build"
    rm -f "$ROOT/build/src.tar.gz"
  fi

  # The Command Line Tools SDK on this machine is newer than its linker and cmake's probe picks it
  # by default, so the Xcode toolchain is named explicitly (see the bug log).
  SDK="$(xcrun --sdk macosx --show-sdk-path)"
  TC="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/bin"
  say "building whisper.cpp with Metal (embedded shader library)"
  # Bug 295: prefix-map.cmake maps the source and build folders out of __FILE__ (as compile options, not a flags
  # string, so a path with a space in it still works).
  "$CMAKE" -S "$SRC" -B "$ROOT/build/out" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_MIN" -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH="$ARM_ARCH" \
    -DCMAKE_OSX_SYSROOT="$SDK" \
    -DCMAKE_C_COMPILER="$TC/clang" \
    -DCMAKE_CXX_COMPILER="$TC/clang++" \
    -DCMAKE_PROJECT_INCLUDE="$HERE/prefix-map.cmake" \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_EXAMPLES=OFF -DWHISPER_BUILD_TESTS=OFF >/dev/null
  "$CMAKE" --build "$ROOT/build/out" --config Release --parallel "$(sysctl -n hw.ncpu)" >/dev/null

  find "$ROOT/build/out" -name "*.a" -exec cp {} "$ROOT/lib/" \;
  cp "$SRC/include/whisper.h" "$ROOT/include/"
  cp "$SRC/ggml/include/"*.h "$ROOT/include/"
  echo "whisper $WHISPER_TAG macos$MACOS_MIN $ARM_ARCH $BUILD_ID" > "$ROOT/version"
  say "libraries in $ROOT/lib"
fi

if [ "$LIBS_ONLY" = "1" ]; then say "libraries only (macOS $MACOS_MIN): $ROOT/lib"; exit 0; fi

# ---------- 2. the model ----------
fetch_model() {
  local name="$1" dest="$ROOT/models/ggml-$1.bin"
  [ -s "$dest" ] && { say "model ggml-$name.bin already here"; return 0; }
  say "downloading ggml-$name.bin"
  curl -fL --retry 2 "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$name.bin" -o "$dest.part" \
    && mv "$dest.part" "$dest" && return 0
  rm -f "$dest.part"
  return 1
}

if ! fetch_model "$MODEL"; then
  say "ggml-$MODEL.bin could not be fetched; falling back to $FALLBACK"
  MODEL="$FALLBACK"
  fetch_model "$MODEL" || { echo "[whisper-install] no model could be downloaded" >&2; exit 1; }
fi
echo "$MODEL" > "$ROOT/model"

# ---------- 3. warm Metal's shader cache ----------
# The FIRST process to build ggml's Metal pipelines on a machine pays ~21 s compiling them; after
# that the system cache serves them in ~15 ms. Paying it here, once, at install time, is the whole
# reason a live utterance never sees it. The helper must already be built for this to run.
HELPER="$(cd "$(dirname "$0")/../.." && pwd)/dist/native/bots-dictation"
if [ -x "$HELPER" ]; then
  SAMPLE="$ROOT/build/warm.wav"
  if [ ! -f "$SAMPLE" ]; then
    say "warming the Metal shader cache (about 20 s, once per machine)"
    /usr/bin/say -o "$ROOT/build/warm.aiff" "Synapse is ready" 2>/dev/null || true
    /usr/bin/afconvert -f WAVE -d LEI16@16000 -c 1 "$ROOT/build/warm.aiff" "$SAMPLE" 2>/dev/null || true
    rm -f "$ROOT/build/warm.aiff"
  fi
  if [ -f "$SAMPLE" ]; then
    "$HELPER" --whisper-bench "$SAMPLE" --whisper-model "$ROOT/models/ggml-$MODEL.bin" >/dev/null 2>&1 || true
    say "Metal shader cache warm"
  fi
else
  say "helper not built yet; run app/native/dictation/build.sh, then this script again to warm Metal"
fi

say "done — model ggml-$MODEL.bin, libraries $ROOT/lib"
