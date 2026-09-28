#!/usr/bin/env bash
# Builds the warm Mac-app helper with an embedded Info.plist (TCC needs the usage strings for Apple
# events, Contacts, Calendars and Reminders) and signs it ad hoc for dev; scripts/sign-app.mjs
# re-signs it with the app's identity when packaging, the same as the dictation helper.
# Also installs the FUZZ=1 fake next to it so fuzz/e2e runs never touch Accessibility or Automation.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../dist/native"
mkdir -p "$OUT"
# Portable install: macOS 14 and later, whatever SDK builds it (verify-bundle.mjs checks the minos).
swiftc -O -target arm64-apple-macos14.0 "$HERE/MacApps.swift" -o "$OUT/bots-mac" \
  -framework Cocoa -framework ApplicationServices -framework OSAKit -framework Contacts \
  -framework EventKit -framework CoreGraphics \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$HERE/Info.plist"
codesign --force -s - "$OUT/bots-mac"
cp "$HERE/fake-macapp.sh" "$OUT/fake-macapp.sh"
chmod +x "$OUT/fake-macapp.sh"
echo "built $OUT/bots-mac"
