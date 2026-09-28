# Headers, betas and OAuth-vs-key differences (Claude Code 2.1.283, subscription OAuth)

## Request headers sent on every /v1 call

`accept: application/json`, `content-type: application/json`, `user-agent: claude-cli/2.1.283 (external, sdk-cli)`,
`x-app: cli`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`, `anthropic-beta`,
`x-claude-code-session-id` (per-run UUID, redacted), `x-stainless-arch: arm64`, `x-stainless-lang: js`,
`x-stainless-os: MacOS`, `x-stainless-package-version: 0.112.1`, `x-stainless-retry-count: 0`,
`x-stainless-runtime: node`, `x-stainless-runtime-version: v26.3.0`, `x-stainless-timeout: 600`
(300 on the non-streaming fallback; absent on count_tokens), `accept-encoding: gzip, deflate, br, zstd`,
`connection: keep-alive`, `content-length`, and `authorization` carrying the OAuth access token (dropped from fixtures).
No `x-api-key`, no `cookie`. `host` in fixtures is the local recorder's address (the recorder rewrote it upstream).
All Messages calls go to `/v1/messages?beta=true`; token counting to `/v1/messages/count_tokens?beta=true`.
Each run also sends one `HEAD /api/hello` first (connectivity check, 200, not kept).

## anthropic-beta per scenario

Base set on Sonnet 5 / Fable 5.1 Messages calls:
`claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13,
context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07,
effort-2025-11-24, extended-cache-ttl-2025-04-11`

| Scenario | Difference from the base set |
|---|---|
| s01 text, s02 tool use, s03, s08 main turns (Sonnet 5) | base set |
| s04 Opus 5.5 | + `per-turn-control-2026-07-01`, `mid-conversation-tool-changes-2026-07-01` |
| s06 Fable 5.1 | + `per-turn-control-2026-07-01`, `mid-conversation-tool-changes-2026-07-01` |
| s07 Sonnet 5 `[1m]` | + `context-1m-2025-08-07` (model field stays `claude-sonnet-5`) |
| s08 web search inner call | − `extended-cache-ttl-2025-04-11` (no cache_control there); tools = `[{type: web_search_20250305, name: web_search, max_uses: 8}]`, `tool_choice: {type: tool, name: web_search}`, `thinking: {type: disabled}` |
| s05/s11/s12/s13 Haiku 4.5 | − `mid-conversation-system-2026-04-07`, − `effort-2025-11-24`; no `output_config`; `thinking: {type: enabled, budget_tokens}` (default budget = max_tokens − 1; 1024 with `MAX_THINKING_TOKENS=1024`) |
| s14 Haiku 4.5, 1.3 MB prompt | reordered: `oauth-2025-04-20, interleaved-thinking…, thinking-token-count…, context-management…, prompt-caching-scope…, claude-code-20250219, extended-cache-ttl…` |
| s10 unknown model | + `mid-conversation-tool-changes-2026-07-01` (CLI treats unknown models like the newest family) |
| s09 count_tokens | `claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14, context-management-2025-06-27, token-counting-2024-11-01`; body only `model, messages, tools` |

## Request body shape

- Keys: `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream`.
- `max_tokens`: 64000 Sonnet 5 / Fable 5.1, 128000 Opus 5.5, 32000 Haiku 4.5 and unknown models.
- `thinking`: `{type: adaptive, display: omitted}` on Sonnet 5 / Opus 5.5 / Fable 5.1 regardless of `MAX_THINKING_TOKENS`
  or `alwaysThinkingEnabled`; thinking blocks arrive with `thinking_delta` + `signature_delta` (content omitted).
  With `--input-format stream-json` the `display` field is absent (s13).
- `output_config: {effort: high}` (Sonnet 5, Fable 5.1), `{effort: medium}` (Opus 5.5 default).
- `context_management: {edits: [{type: clear_thinking_20251015, keep: all}]}`.
- `system`: 3 text blocks: (1) `x-anthropic-billing-header: cc_version=…; cc_entrypoint=…;` (no cache_control),
  (2) the identity line "You are a Claude agent, built on Anthropic's Claude Agent SDK." style line with
  `cache_control {ephemeral, ttl 1h}`, (3) the main prompt with `cache_control {ephemeral, ttl 1h}`.
- `metadata.user_id`: a JSON string `{device id, account id, session id}` (filler in fixtures).
- Tool results come back with a trailing `role: "system"` message (needs `mid-conversation-system-2026-04-07`).
- 404 with streaming makes the CLI retry once with `stream: false` (and `x-stainless-timeout: 300`).

## Response headers

- Success (OAuth): `anthropic-ratelimit-unified-*` family (status, 5h/7d utilization and reset, representative-claim,
  fallback-percentage, overage-status, overage-disabled-reason, 7d-surpassed-threshold), `anthropic-workspace-id`
  (redacted), `traceresponse` (redacted), `content-encoding: gzip` on SSE, `br` on JSON, `server: cloudflare`,
  `x-robots-tag: none`, CSP. Dropped: `request-id`, `anthropic-organization-id`, `cf-ray`.
- Errors (404/400): no rate-limit headers; `x-should-retry: false`; body `{type: error, error: {type, message}, request_id}`.

## Differences that can matter when an API key is used instead

Observed = seen in these recordings. Expected = from API docs/CLI behaviour, not verifiable here (no key).

1. (Observed) Auth header: OAuth sends the access token in `authorization`; a key build must send `x-api-key` and no `authorization`.
2. (Observed on every call) `oauth-2025-04-20` beta. (Expected) it is OAuth-only; a key build should not send it.
3. (Observed) `--betas` / custom betas are ignored under OAuth ("Custom betas are only available for API key users"); with a key
   they will be forwarded, so a key build can send betas the subscription recording never exercised.
4. (Observed) OAuth returns `anthropic-ratelimit-unified-*` (plan utilization). API keys return the
   per-key (Expected) `anthropic-ratelimit-requests-*`, `-input-tokens-*`, `-output-tokens-*`, `-tokens-*` headers and
   `retry-after` on 429. Any UI that reads unified utilization must not expect it with a key.
5. (Observed) the billing-header and identity system blocks. (Expected) a key build is not required to send them; replay
   should not depend on them.
6. (Observed) Account identifiers: `metadata.user_id` carries the account id under OAuth; (Expected) with a key it differs. Replay should not assert on its contents.
7. (Observed) `anthropic-workspace-id` and `anthropic-organization-id` response headers; (Expected) also returned for keys, with per-workspace values.
8. (Expected, API contract) Error bodies, status codes, SSE event order, usage fields (`output_tokens_details.thinking_tokens`,
   `server_tool_use.web_search_requests`), stop reasons and model ids are auth-independent.
