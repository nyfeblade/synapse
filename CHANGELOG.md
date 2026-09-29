# Changelog

Every version of Synapse. The website's Changelog page is built from this file.
Newest first. A version headed `Unreleased` shows as "in progress".

## 0.1.2 — 2026-09-29

- **Updates are always checked.** Synapse looks for a new version by itself and shows it when there is one. The Automatic Updates switch now only decides whether it's downloaded for you; it's on unless you turned it off.
- **Good updates stay installed.** A new version counts as working once its window opens, so a slow Bots' computer no longer makes Synapse go back to the old one.
- **Coding agents start from the latest code.** They branch from the repo's current default branch, and say so if they can't fetch it instead of starting on old code.
- **Moving a file to the Trash asks first**, like any other delete.
- **Mac control handles unusual file names and inputs safely.** Adding a Finder tag keeps the file's other tags.
- **Editing a file on your Mac keeps `$` signs as written.**
- **No more settings that do nothing.** The security key switch, the Update Track menu and the placeholder Terms link are gone.
- **The docs are up to date** on running Synapse in two macOS accounts and on how updates work.

## 0.1.1 — 2026-09-29

- **Synapse in two macOS accounts on one Mac.** Each account gets its own connection to its own Bots' computer, and Synapse tells you clearly if it ever reaches another account's instead.
- **Sign-in never fails silently.** If adding, replacing or checking your API key fails, Synapse says what went wrong.
- **Your connection key stays yours.** Before Synapse sends its key to the Bots' computer, that computer has to prove it's yours, so another account on the same Mac can never pick it up.
- **Key changes happen in order.** Saving, testing and removing your API key run one at a time, so a slow save can't undo a removal.
- **Long jobs aren't cut off.** Restoring a backup or importing no longer stops after five minutes.

### Updating from 0.1.0

- The Bots' computer updates itself once, automatically, the first time 0.1.1 opens. If a Bot is mid-reply in a second macOS account at that moment, it may be interrupted once.

## 0.1.0 — 2026-09-28 — beta

The first public release.

### Bots

- A team of Bots, each with its own name, look, instructions, memory and skills, sharing a sandboxed Linux computer.
- Multi-step tasks with every step visible: files, commands, the web and the accounts you connect.
- Code work on its own branch in a separate copy of the repo, with tests run and a branch or pull request handed back.
- Voice calls, with speech transcribed and the voice generated on your Mac.
- Scheduled and triggered work.

### Your Mac and safety

- Bots use your Mac's apps and screen in a sandbox, and ask before anything risky: Allow once, Always allow or Deny.
- Secrets are sealed on your Mac with the app's own key, so there are no Keychain password prompts.
- Every model call is metered, and budgets pause or ask before a Bot overspends.

### Setup and updates

- Guided first run: OrbStack, the Bots' computer, your Anthropic API key, a short tour and your first Bot.
- The API key check tells you whether your key works, which models it can use, and whether web search is on.
- Signed updates: every update is verified before it's installed.
- The launch snap: two halves of a Bot click together as Synapse opens. You can turn it off in Settings → General.

### Known issues

- Running Synapse in two macOS accounts on one Mac at the same time doesn't work yet (fixed in 0.1.1).
- Synapse isn't notarized by Apple, so macOS asks once when you first open it.
