# Signing in with an Anthropic API key

This is the public build (branch `synapse-public`, bug 270). Bots reach Claude with an **Anthropic API key** and nothing else, billed to an Anthropic Console account. Anthropic's terms don't allow a third-party product to sign people in with a Claude subscription or a Claude Code login, so there is no such option anywhere: not in the Sign in step, not in Settings → Account, not on the Mac, not in the box. (The owner's private build, on `feat-custom-mcp-composio-preset`, keeps dual auth.) Bots still run on Claude Code (the Agent SDK spawns the CLI); the CLI gets a proxy API-key token.

## How the key travels

1. Typed into the first-run "Input API Key" step or Settings → Account (a password field). The renderer passes it to the Electron main process over IPC (`auth:save-key`).
2. Main seals it to the box's pinned public key (`crypto_box_seal`, the same path as every Bot secret) and sends only the sealed form (`setApiKey`).
3. The host opens it and stores it AES-256-GCM-sealed with a vault subkey in `hostPrivate/anthropic-auth/auth.json` (0600). Only the save time is in the clear. Backups carry it in the `sealed/` part: it restores only onto the same box key.
4. Each model call gets a proxy token as `ANTHROPIC_API_KEY` in the Claude process's spawn env, applied in `host/usage/metered-query.ts` (every host model call goes through there). The CLI sends it as `x-api-key`; the proxy swaps in the real key.

It is never logged, never written in plaintext and never sent back: the app sees `sk-ant-…last4`.

A new key applies to every call that starts after it is saved. A warm Bot process respawns on its next turn, a running turn finishes on the key it started with, and the reviewer's prewarmed processes are recycled. With no usable key, calls fail with "No API key" (`AuthMissingError`); nothing falls back to anything.

Every other way the CLI could sign in is scrubbed from each spawn env, always (`CLAUDE_AUTH_SCRUB` in `host/auth/auth-env.ts`, applied in `buildBotEnv` and again per call: the OAuth token and its refresh / fd / scopes forms, the plan hints, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_REMOTE`, `ANTHROPIC_UNIX_SOCKET`, `ANTHROPIC_PROFILE`, the key-by-fd form). With `ANTHROPIC_API_KEY` set and no `CLAUDE_CODE_REMOTE`, Claude Code turns claude.ai OAuth off, so a stored login in a config dir or the keychain is never read. `ENABLE_CLAUDEAI_MCP_SERVERS=false` is set too. The Mac does the same for its wrapped claude runs (`app/src/coordinator/local-exec/login-scrub.ts`).

## An install that had the Claude subscription

An install from before (dual auth) may have saved the subscription. It is routed to the API-key sign-in and its old credentials are never used:

- `auth.json`'s old `mode` is ignored (and dropped on the next save). A key saved there is kept and used; with none, the app asks for one and Bots wait.
- The box's old login token (`hostPrivate/claude-oauth-token`) is deleted at host boot (`retireClaudeLogin`), only inside the host's private dir; a custom `CLAUDE_TOKEN_FILE` path is no longer read and is left alone.
- The Mac's old Claude-for-Bots token (`mac-claude-token.bin` in the app's userData) is deleted when the coordinator starts, only there.
- The Claude plan's data in usage.db and settings (the weekly window, plan windows, plan name, reset time) is dropped once (`planRetired`).

Nothing outside the app's own data is touched: never `~/.claude`, never the keychain.

**The app's own secrets left the keychain too (bug 279, ported from the private build).** Secrets on the Mac (the Bot secrets vault, the backup key, the vault's hash key, the push key) are sealed with AES-256-GCM under a key file, `keys/seal.key` in the app's data folder (userData). The only keychain read left is a one-time migration of the app's own "Bots … Safe Storage" item on the first launch after the update; it re-seals those files, archives the originals in `keychain-sealed-backup/` and writes `keychain-retired.json`; after that Chromium runs with `use-mock-keychain` and nothing asks the keychain. It never reads a Claude login: the Mac's old `mac-claude-token.bin` is not part of the migration and is still deleted by `retireMacClaudeLogin`. The key file and the archive live in the data root the command sandbox read- and write-denies in every mode: the whole …/Synapse (and …/Bots) folder, not only the profile, with ~/Library and ~/Library/Application Support locked against renaming so nothing above the key can be moved out from under the deny (bug 288; `app/test/coordinator/data-root-sandbox.test.ts` and `app/test/main/seal-key-sandbox.test.ts`, live under sandbox-exec with stand-in files). An exempt tool the user approves runs outside the sandbox and can read the key file; its card says so.

## What is gone (compared with dual auth)

- The "Claude subscription" choice and the mode switch (`setAuthMode`, `AuthMode`), Connect Claude and `claude setup-token` (`storeClaudeToken`, the token verifier, `box/set-token.sh`), the account probe.
- Claude for Bots on the Mac (`getMacClaudeStatus`, `macClaudeSignIn`, `macClaudeSignOut`) and its token injection.
- Proxying a Claude login (`BOTS_AUTH_PROXY_OAUTH`, Bearer grants in the proxy).
- Plan usage: plan windows, plan %, plan name, Manage plan; the usage ladder follows the weekly and monthly dollar budgets only. Settings → Usage shows API spend Today / This week / This month.
- claude.ai connectors (they come with a Claude login): no detection, no catalog entries, no "Your claude.ai connectors" section, and the claude.ai Gmail email-routine poll (a routine on that account now reports "no mailbox").

The monthly dollar budget prompt shows once after a key is saved. Evals and the conformance CLI use the box's saved key through a key proxy of their own (`useSavedAuth`, ephemeral loopback port, fail closed). A guard test (`host/test/auth/no-subscription-guard.test.ts`) fails if a subscription or OAuth sign-in path comes back into shipped code.

## Review round 2 (bugs 271, 272)

**No login on disk, no login by accident (S1–S6).**
- Every env built for a process that gets no key (a background Shell, an MCP server, a claude a Bot starts by hand, on the box or the Mac) carries a dead sentinel pair: `ANTHROPIC_API_KEY=sk-ant-api03-synproxy-none` and `ANTHROPIC_BASE_URL=http://127.0.0.1:9` (a closed loopback port). With an API key in its env the CLI keeps claude.ai OAuth off, so it never reads a stored `.credentials.json`; any call fails at once. A real spawn replaces both.
- `box/files/retire-claude-login` (run as root by `provision.sh`, every provision) removes `.credentials.json` from `/home/box/.claude` and every `/home/bots/<name>/.claude` (app accounts), the old token and its temp files, and writes `/etc/claude-code/managed-settings.json` with `"forceLoginMethod": "console"` (the CLI honours it only from managed settings; inferred from the 2.1.277 binary). `verify-box.sh` checks all three.
- The Mac refuses `claude auth login`, `claude /login` and `claude setup-token` in any wrapped command, and removes `.credentials.json` from its app-owned `~/.synapse/claude-mac` (never `~/.claude`).
- Both scrub lists also remove `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_HOST_AUTH_ENV_VAR`, `CLAUDE_CODE_HOST_CREDS_FILE` and `CLAUDE_CODE_CUSTOM_OAUTH_URL`.
- The Mac-side dev tools that start a real claude (the coding bench's CLI baseline, the routing eval, the perf probes) use `explicitKeyEnv`: `SYNAPSE_API_KEY` or `ANTHROPIC_API_KEY`, else the sentinel, never the developer's login.
- The guard test scans bench, evals, walk, scripts and `.md` prompts, joins split strings, and lists every excluded folder and every allowed file with a reason.

**Parity (P1–P5).**
- An API 429 ("Try again in N s", a retry-after) pauses background work for that long, a minute when no wait is given. No "Usage limit reached" tray, no degraded reviewer; the 5-hour default is only for a real "resets at/in" plan message.
- The box key proxy forwards only `POST /v1/messages` and `POST /v1/messages/count_tokens` (as the Mac's does), asks the budget before each model call (429 with the budget's message), meters JSON as well as streamed answers, cuts an upstream silent for 10 minutes (504), and reports tokens that went through a run's token but that its CLI never reported (a Bot's own call, a turn cut off) to usage.db at list price when the token is released.
- Which models the key can reach, and which have 1M context, is probed with free `count_tokens` calls straight from the host (after a key is saved, and on **Check models**). The picker hides models the key can't use; a Bot on one runs on a reachable model with a plain message; `[1m]` is not requested where the key has no 1M context.
- `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` was recorded against the fake with the real CLI (`host/test/auth/first-party-flag.cli.integration.test.ts`): it adds internal betas but brings neither eager tool-input streaming nor a different 1M path, so it is **not adopted**.
- A "web search is not enabled" error says so in plain words. CT-04 is n/a (usage metered) with an API key. The Mac's spend counts 1-hour cache writes (2x input) and web searches ($10 per 1,000). Dollars are labelled "API cost", not "API-equivalent".

## Review round 3 (bugs 273, 274)

**Fail closed where the credential lives, not by reading commands (S2).** A denylist of login commands can't win (quotes, `$c`, `cla""ude`, `base64 | sh`, an alias, a copied binary, `env -u ANTHROPIC_API_KEY` all get past one), so it is only a friendly early message now. The defence:
- The Mac command sandbox read-denies (and write-denies) `~/.claude/.credentials.json`, `~/.claude.json` and the app's `~/.synapse/claude-mac/.credentials.json`, in every mode including No limits. A wrapped claude runs with its own `CLAUDE_CONFIG_DIR`, so it doesn't need `~/.claude.json` (inferred; no live claude run confirmed it).
- The keychain deny (exec of `/usr/bin/security` and the Security server's mach-lookup) is in every sandboxed run's profile; a test builds the profile in every mode and checks both, and checks a stand-in item name against the fixed rules (no real keychain call).
- Every run's env is built by `macRunEnv` (the shared `claudeEnv`): the dead sentinel unless this run's proxy grant replaces it. Exempt, unsandboxed tools (swift, xcodebuild, electron, playwright, chromium) always get the sentinel and `CLAUDE_CONFIG_DIR` pointed at an empty app-owned dir (`userData/claude-empty`, 0700, emptied before each run).
- Exempt tools run outside the sandbox; the user approves each one.

**One helper starts every claude (S6).** `shared/src/claude-env.ts` holds the one list of login variables (now also `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_CUSTOM_HEADERS`), `claudeEnv` (deletes them all, sets the one key, checks) and `assertNoClaudeLogin`. On the host every claude starts through `host/claude/spawn.ts` (`startClaudeQuery` for the SDK's query, `spawnClaudeProcess` for spawn hooks, `claudeVersion`, `runClaudeCli` for the bench), which checks the env at runtime; on the Mac through `macRunEnv`. The guard test fails if another file starts claude, calls the SDK's query directly, hands a claude spawn `...process.env`, or if an env a declared file builds holds a login variable (checked at runtime).

**Other fixes.** `retire-claude-login` removes a Bot's stored login as that Bot (`runuser`), and unlinks a planted link instead of skipping it (D1). Model access has a key generation: a probe started under an older key never lands (D2). The Mac renames an old login file to a trash name before looking at it, then unlinks a link or removes a plain file, never following into `~/.claude` (D3). The box proxy counts web searches, and a key reset (`revokeAll`) still reconciles each ended grant's unreported spend when its process ends. The Mac's claude follows the Savings cache-TTL setting (sent with `macClaudeAuth`).

## Review round 3 re-review (bugs 275-278)

**The login dirs can't be moved (S2).** A literal read-deny matches the path at access time, so renaming a parent carried the login out from under it (`mv ~/.claude ~/.cx`, then `CLAUDE_CONFIG_DIR=~/.cx claude`). The command sandbox now write-locks `~/.claude`, `~/.synapse` and `~/.synapse/claude-mac` themselves, and every entry directly in `~/.synapse` (both spellings of home, either case below it), so none can be renamed, removed or replaced; files inside `~/.claude` and the app's config dir are untouched. A `.credentials.json` anywhere under home, in any case, is read- and write-denied, so a copy or a moved file stays unreadable. Every mode, No limits included. Tested live: sandbox-exec with the generated profile against a stand-in login in a temp home (never the real `~/.claude` or the keychain).

**No child gets process.env as is (S6).** The guard parses every code file that mentions claude (TypeScript AST) and fails on `env: process.env`, `Object.assign(…, process.env)`, and a spawn / exec / execFile / fork call with no `env` (the child would inherit process.env). Only `shared/src/claude-env.ts`, `host/claude/spawn.ts` and the Mac's `login-scrub.ts` are exempt, each with its reason. The call sites it found pass `scrubClaudeLogin(process.env)` (or `macExecEnv()` on the Mac).

**The migration renames before it looks (D3).** `retireMacClaudeLogin` no longer lstat's the app-owned config dir: it renames `~/.synapse/claude-mac` to a trash name first (a link moves as a link), then inspects the moved entry. A link or file is unlinked; a real dir has only its `.credentials.json` retired (renamed, then unlinked if a link or file) and is moved back to its name.

**Web searches are reconciled like tokens (P2).** The SDK's `total_cost_usd` already includes web searches, so `meteredQuery` reports the run's web searches (the `modelUsage` delta) with its tokens and the box proxy subtracts them the same way. A grant that ends with no report still records its web searches. Grants retired by a key reset are dropped after the idle TTL (7 days) or beyond 1,000 (oldest first) when their process never releases them, each settled once (its web searches recorded; tokens are never guessed without a report).

## The Mac key proxy (bug 263)

The Bots' `claude` on the Mac (a wrapped run in the command sandbox) uses the same key but never holds it. Main keeps a copy when the key is saved: AES-256-GCM with an HKDF subkey of `local-policy.key` (0600, `mac-anthropic-api-key.bin`, in the data root the sandbox read-denies; never the keychain), removed with the key. The coordinator runs a loopback key proxy (`app/src/coordinator/local-exec/mac-key-proxy.ts`). A run that uses claude gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and a token minted for that run (`sk-ant-api03-macproxy-…`), revoked when the run ends. The proxy checks the token, adds the real key and forwards only `POST /v1/messages` and `POST /v1/messages/count_tokens` to api.anthropic.com. If the proxy can't start, claude runs on the Mac are refused ("Couldn't start the key proxy on this Mac"); with no Mac copy they point at Settings → Account. Nothing falls back to a Claude login. Before every claude run the executor asks the host (`macClaudeAuth`, no cache): whether the host has a key saved, and whether this Bot may spend under its budgets. If the host can't be asked, the run is refused (never a guess). A run needs a key saved on the host and the budget's OK before any token is granted; over budget it is refused with the budget's message. The proxy reads `usage` from every `/v1/messages` answer (streamed or JSON) and reports it per Bot (`recordMacUsage`, priced at list price), so the spend view, the ladder and the monthly budget count the Mac's claude too. Upstream is always asked for an uncompressed answer so every one is metered, and a stream cut off mid-way still reports what `message_start` said (exactly once). Each `/v1/messages` request rechecks the budget with the host (cached about 30 s); once over, the request gets 429 with the budget message and is not forwarded. Usage is priced at list price (`host/usage/list-price.ts`; an unknown model at the highest known rate). A report the host can't take waits in `mac-usage-queue.json` in the data folder (bounded, 0600) and is retried with backoff, also after a restart. Request bodies are capped at 32 MB (413), a request must arrive within 5 minutes, and an upstream silent for 10 minutes ends with 504. The coordinator keeps the Mac copy (it owns `local-policy.key` and creates it on demand); main asks it over the parent port, and a failed copy is shown in Settings → Account.

A key saved on the box only (an older install) is asked for once, to save it on this Mac too.

What a Bot can and can't see: during its own run, anything in that run can read and use the run's proxy token (which spends on the key); the token dies with the run. It can never read the key itself, on the box or the Mac. Spend is bounded by the monthly budget and the usage ladder.

## The auth proxy (bug 113): no real credential in any Claude process

`host/auth/proxy.ts` runs inside bothost on `127.0.0.1:47802`. Every Claude process (Bot turns, children, coding agents, compaction, the reviewer and all helper calls) is started through `meteredQuery`. Each one gets `ANTHROPIC_BASE_URL=http://127.0.0.1:47802` and a random proxy token made for that one spawn (`sk-ant-api03-synproxy-…`). The token is revoked when the query ends or closes, and it expires after 7 days without use. The proxy then:

- checks the token (an `x-api-key` proxy token only; a Bearer token is refused) and strips it, then adds the real `x-api-key`;
- streams to `api.anthropic.com` with no buffering: SSE bytes are passed on as they arrive. The body and every other header (`anthropic-beta`, `anthropic-version`) pass through untouched, so the prompt cache sees the same request. A test compares the proxied body against a direct run: `system`, `tools` and the 1-hour `cache_control` markers are identical;
- forwards `/v1/*` only, answers the CLI's `HEAD /api/hello` itself, and answers a bad, revoked or expired token with the API's 401 `authentication_error` body. If Anthropic can't be reached it returns 502 `api_error`, which the CLI retries;
- counts each Bot's usage from `message_start` and `message_delta` as the stream passes (`proxy.usage(botId)`). This stays in memory: usage.db still gets its numbers from `meteredQuery`;
- comes back by itself on the same port if its listener dies, keeping its grants. A running CLI rides out the gap with its own retries (tested: the proxy is down when the turn starts and back 0.7 s later, and the turn completes). A host restart drops all grants, but the boot sweep has already reaped every process that held one.

Overhead: a median of 0.54 ms per request (200 streamed requests over keep-alive, fake upstream; the requirement is under 5 ms).

Access: the proxy listens on loopback only. `box/files/bots-auth-proxy.nft` (loaded by `bots-auth-proxy.service`, installed by `provision.sh`) limits the port to bothost, box and the per-Bot uids (60200-61099). Every other local user is refused. `verify-box.sh` checks both sides.

Verified with the real CLI (`host/test/auth/proxy.cli.integration.test.ts`). A Bot's Bash scans `env`, `ps -Eww` and every readable `/proc/*/environ` and `/proc/*/cmdline`, and finds no real key or Claude login, even with a login planted in the host env and a stored claude.ai login in the config dir. The Bash env holds the proxy token only.

`SYNAPSE_AUTH_PROXY=off` turns the proxy off in a test run only (`VITEST` set); a production host ignores it. If the proxy can't bind its port at boot, calls fail closed: every spawn throws `AuthProxyDownError` and a "Couldn't start the key proxy" tray offers Retry (bug 262).

## Errors

| Anthropic says | Synapse shows |
|---|---|
| 401 `authentication_error` | Reached Anthropic ✓ — key rejected |
| 402 `billing_error` / "credit balance is too low" | No API credits |
| 429 `rate_limit_error` (+ `retry-after`) | Rate limited by Anthropic: "Try again in N s" (the CLI already waited and retried) |
| 529 `overloaded_error` | Anthropic is overloaded. The CLI retries with backoff, then the host retries the turn |
| 403 `permission_error` | Key can't use this |
| 404 `not_found_error` | Model not available to this key |

## Verification without a real key

- `host/test/auth/fake-anthropic.ts` is a local Messages API that uses the real wire format: SSE streaming, `tool_use`, usage with cache tokens, an `x-api-key` check, and the documented error bodies. The real CLI accepts a non-Anthropic `ANTHROPIC_BASE_URL`. It also calls `GET /api/hello` without a key, which the fake answers.
- `RUN_CLAUDE=1 npx vitest run --project host host/test/auth/api-key.cli.integration.test.ts` runs Bot turns through the real bundled CLI against the fake. It checks that the key is sent as `x-api-key` and the OAuth token never is, that replies stream, that a Bash tool call round-trips, that usage (cache tokens included) is recorded, and that helper calls are metered. It also checks each error mapping, including the CLI's own 529 retry and its wait for 429 `retry-after`.
- A real bogus-key probe (run once on 2026-09-22) got `HTTP 401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}`. This is free.

## Replayed real API answers (bug 280)

`host/test/auth/fixtures/api-recordings/` holds 23 sanitized recordings of real Anthropic traffic (INDEX.md and NOTES.md there; `recordings.privacy.test.ts` re-scans them). `host/test/auth/replay-anthropic.ts` serves them, at their recorded timing, with the real API's key check and encodings. Against them:

- both key proxies (`replay-proxy.test.ts`, `app/test/coordinator/mac-key-proxy-replay.test.ts`): every answer passes byte for byte; upstream gets `x-api-key` and never an `Authorization` header or a Claude login's `oauth-*` beta (the CLI's other betas pass in order); metering equals the answer's own final usage, cache reads/writes, 1-hour writes and web searches included (message_delta's usage is cumulative: a web search call ends at 13,025 input tokens, not message_start's 2,984); count_tokens and the recorded errors pass unmetered; the 1M beta passes;
- the host's EventTranslator over every recorded event (`replay-stream.test.ts`): every event, block and delta type is known, text and thinking come out as recorded, every stop reason is documented;
- the errors (`replay-errors.test.ts`): the 404 unknown model is "Model not available to this key"; the 400 "prompt is too long" is "Chat too long for the model" with its two numbers, and stays BOT-E0404 so the compactor compacts and retries;
- the real bundled CLI over every single-turn recording, tool use and web search (`RUN_CLAUDE=1 npx vitest run --project host host/test/auth/replay.cli.integration.test.ts`).

## The API-key check (bug 281)

Runs after a key is saved and from **Check** in Settings → Account (a saved key; a key typed but not saved still has **Test connection**). On the host (`host/auth/key-check.ts`):

1. The free probes: count_tokens per model and with the 1M beta (`ModelAccess`), and one count_tokens call that declares web search (an organization with web search off refuses it).
2. The budget is asked (`budgetAllow`); over it, nothing is sent and the budget's words are shown.
3. ONE tiny real message through the box key proxy with a grant of its own: the cheapest model the key reaches (Haiku 4.5 when it can), `max_tokens` 8, streamed, "Hi", with the web search tool declared and `tool_choice: none` (no search runs). Its usage is recorded in usage.db as `key-check` at list price, and reported on the grant's release so the proxy doesn't count it again.
4. The answer, kept in `hostPrivate/anthropic-auth/key-check.json` (no secrets) and published on `key-check`: key works, the models it reaches, 1M context, web search on or off, or exactly what failed (key rejected, no credits, rate limited with the wait, overloaded, no permission, model not available, web search off, over budget, key proxy down, Anthropic unreachable), in the Errors table's words.

Tested against the replay upstream only (`host/test/auth/key-check.test.ts`: recorded answers, and Anthropic's documented error bodies where nothing was recorded). The web-search-off wording is inferred (`WEB_SEARCH_OFF_RE`); no real refusal was recorded.

## The one-cent real test (once you have a key)

Either click **Check** in Settings → Account (the key check above: one Haiku request, `max_tokens: 8`, metered), or **Test connection** on a typed key (one Haiku request, `max_tokens: 1`), or run:

```sh
SYNAPSE_LIVE_API_KEY=sk-ant-api03-… npx vitest run --project host host/test/auth/real-key.live.test.ts
```

That makes one Haiku call with `max_tokens: 5`, plus the Test connection request. Together they cost well under one cent. The same call as a one-liner:

```sh
curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":5,"messages":[{"role":"user","content":"Say OK."}]}'
```

A full Bot turn on a real key sends the Bot's system prompt and tools too, so it costs a few cents on Haiku, not one.
