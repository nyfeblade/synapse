#!/usr/bin/env bash
# Builds the dictation helper with an embedded Info.plist (TCC needs the usage strings) and signs it ad hoc
# for dev; scripts/sign-app.mjs re-signs it with the app's identity when packaging (bug 96).
# Also installs the FUZZ=1 fake helper next to it so fuzz/e2e runs never touch Speech/mic permissions.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../dist/native"
REPO="$(cd "$HERE/../../.." && pwd)"
mkdir -p "$OUT"
# Portable install: the helper runs on macOS 14 and later (the app's LSMinimumSystemVersion), never
# only on the version of the SDK that built it. verify-bundle.mjs checks the minos it records.
MACOS_MIN="14.0"

# Bug 165: whisper.cpp, linked in when its libraries are there. Portable install: they come from the
# repo's own build cache (app/native/whisper/install.sh --libs-only), never from the builder's
# ~/Library, so what a package contains does not depend on what this Mac happens to have installed.
# A package build (PACKAGE_BUILD=1) builds them if they are missing and FAILS if it can't: a shipped
# helper without whisper would silently do nothing in Full mode. A dev build without them still gets
# the Apple-speech-only helper (Whisper.swift compiles to its stubs). WHISPER_ROOT overrides.
WHISPER_ROOT="${WHISPER_ROOT:-$REPO/.build-cache/whisper}"
have_whisper() { [ -f "$WHISPER_ROOT/lib/libwhisper.a" ] && [ -f "$WHISPER_ROOT/include/whisper.h" ] && grep -q " macos$MACOS_MIN .* prefix-map-2$" "$WHISPER_ROOT/version" 2>/dev/null; }
if ! have_whisper && [ "${PACKAGE_BUILD:-}" = "1" ]; then
  echo "building whisper.cpp for macOS $MACOS_MIN into $WHISPER_ROOT"
  bash "$HERE/../whisper/install.sh" --libs-only --root "$WHISPER_ROOT"
  have_whisper || { echo "whisper.cpp could not be built into $WHISPER_ROOT; a package build refuses to ship a helper without it" >&2; exit 1; }
fi
WHISPER_FLAGS=()
if have_whisper; then
  echo "linking whisper.cpp from $WHISPER_ROOT"
  WHISPER_FLAGS=(
    -D WHISPER
    -import-objc-header "$HERE/whisper-bridge.h"
    -I "$WHISPER_ROOT/include"
    -L "$WHISPER_ROOT/lib"
    -lwhisper -lggml -lggml-cpu -lggml-blas -lggml-metal -lggml-base
    -lc++ -framework Metal -framework MetalKit -framework Accelerate
  )
else
  echo "whisper.cpp not found in $WHISPER_ROOT; building without it (Apple speech only)"
fi

swiftc -O -target "arm64-apple-macos$MACOS_MIN" "$HERE/Dictation.swift" -o "$OUT/bots-dictation" \
  -framework Speech -framework AVFoundation \
  "${WHISPER_FLAGS[@]}" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$HERE/Info.plist"
codesign --force -s - "$OUT/bots-dictation"
cp "$HERE/fake-dictation.sh" "$OUT/fake-dictation.sh"
# Every voice sidecar ships as a script (portable install: Kokoro's runtime is bundled beside it in
# Contents/Resources/kokoro; the optional Qwen/F5 packs are downloaded by the app).
#   kokoro_server.py  bug 107, the default engine
#   f5_server.py      bug 163, cloned voices — this copy was missing, so registerF5's exists(script)
#                     check failed in every build and cloned voices reported "not in this build"
#   qwen_server.py    bug 164, the Qwen3 engine
for s in kokoro/kokoro_server.py f5/f5_server.py qwen/qwen_server.py; do
  cp "$HERE/../$s" "$OUT/$(basename "$s")"
  chmod +x "$OUT/$(basename "$s")"
done
# Portable install: the optional voice packs' pinned package locks (native/voice-packs.ts installs them).
cp "$HERE/../qwen/requirements.lock" "$OUT/qwen-requirements.lock"
cp "$HERE/../f5/requirements.lock" "$OUT/f5-requirements.lock"
cp "$HERE/../f5/requirements-sdist.lock" "$OUT/f5-requirements-sdist.lock"
chmod +x "$OUT/fake-dictation.sh"
echo "built $OUT/bots-dictation"
