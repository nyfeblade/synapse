# Portable install: building the DMG and proving it on a fresh Mac

## Build gate (the Mac with the "Synapse Local Signing" identity)

```bash
npm install
npm run dmg                      # package (bundled Kokoro, signed, every Mach-O verified) → app/dist-release/Synapse.dmg
npx playwright test -c app/e2e/packaged.config.ts kokoro-bundled   # the shipped app speaks, HOME = an empty folder
```

`npm run package` fails, rather than shipping something that only works here, when: the identity is missing
(it never signs ad hoc on its own; `SYNAPSE_ADHOC_SIGN=1` for a throwaway), a helper needs a newer macOS than
14.0, whisper isn't linked into the dictation helper, any Mach-O in Resources isn't signed by the identity, the
runtime, the model or an offered voice is missing, or a source map ships.

## The Bots' computer on a throwaway machine (this Mac)

```bash
RUN_FRESH_BOX=1 FRESH_BOX_MACHINE=synapse-accept-1 npx vitest run app/test/main/fresh-box.live.test.ts
```

Creates `synapse-accept-1` (never an existing name), provisions it through the setup screen's own resumable
steps, prints each step's time, runs again to prove nothing reruns, and deletes it. `FRESH_BOX_DEPLOY=1` also
deploys the host — only on a Mac with no other box running (two gateways fight over OrbStack's localhost forward).

## The voice packs, for real

```bash
RUN_VOICE_PACKS=1 PACK=qwen npx vitest run app/test/main/voice-packs.live.test.ts   # ~2.4 GB into a temp folder
```

## The full fresh-user run (a second macOS account or a second Mac)

1. Copy `Synapse.dmg` somewhere the new account downloads it from (so it is quarantined like a real download).
2. Check the account is clean: no voice setup outside Synapse's own data, no `~/.cache/huggingface`, no `~/Library/Application Support/Synapse` (a `…/Bots` folder is another build's data: the app never moves or reads it),
   no Homebrew Python.
3. Open the DMG, drag Synapse to Applications, open it once. It is not notarized by Apple, so Gatekeeper
   blocks the first open: right-click → Open, or System Settings → Privacy & Security → Open Anyway. A copy opened from the DMG offers to move itself to Applications.
4. The setup screen: Get OrbStack → install it → Synapse starts it → the Bots' computer builds on its own
   (a `synapse-box` machine; record the time) → Sign in to Claude → optional voices / phone / updates.
5. Check: a call speaks in Kokoro straight away (`~/Library/Logs/Synapse/voice.log` says `kokoro: probe ok … (bundled:
   /Applications/Synapse.app/…)`), `codesign --verify --deep --strict /Applications/Synapse.app` still passes after
   the call, and `orb list` shows `synapse-box`.
6. Turn Wi-Fi off during the Bots' computer step: a plain error and Retry; Wi-Fi on, Retry resumes. Quit mid-way and
   relaunch: it resumes, it doesn't start over.
