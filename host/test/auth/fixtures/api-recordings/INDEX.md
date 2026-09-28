# API recordings (sanitized)

Recorded 2026-09-25 with `tools/private/record-api.mjs` (Claude Code 2.1.283, `claude -p`, subscription OAuth login,
`ANTHROPIC_BASE_URL` pointed at the local recorder, `--strict-mcp-config`, run in an empty temp dir).

Each file is one request/response pair. Format:

- `request`: method, path, `auth` (credential style only, no value), remaining headers, `dropped_headers`, body.
  The body keeps all request configuration verbatim (model, max_tokens, stream, thinking, output_config,
  context_management, tool_choice, tool names and input schemas). Conversation text (system, messages,
  tool descriptions, metadata) is same-length filler.
- `response`: status, headers (identifiers dropped or `<redacted>`), `ttfb_ms`, `total_ms`, `chunk_timing`
  (arrival time and byte size of every network chunk as received, still gzip-compressed).
  - `kind: "sse"`: `sse` is the ordered list of events, each `{t_ms, raw}` where `raw` is the exact
    `event: ...\ndata: {...}\n\n` block and `t_ms` is when the chunk that completed it arrived. Concatenate the `raw`
    fields to get the stream body. Text, thinking, signatures, citations and tool-input strings are filler of the
    same length; `partial_json` fragments are filled so they still join into valid JSON.
  - `kind: "json"`: `body` is the parsed JSON body (count_tokens results, error bodies).
- Ids (`msg_`, `toolu_`, `srvtoolu_`) are replaced by stable fakes of the same length (for example `msg_0000000000000000000fake1`), consistent
  within a file.
- Error `message` fields are kept verbatim. The error body's `request_id` is filler.

Not kept as fixtures: `HEAD /api/hello` connectivity checks (one per run, all 200), and 8 proxy-side upstream
timeouts during s10 (a local IPv6 routing stall; fixed by forcing IPv4 in the recorder).

| File | Scenario | Model | Covers | Status | stop_reason |
|---|---|---|---|---|---|
| 0002-s01-text-sonnet5 | plain streamed text | claude-sonnet-5 | full default CLI request (22 tools, ~41.5k-token system prompt, 1h cache write), adaptive thinking, no thinking emitted | 200 SSE | end_turn |
| 0005-s02-tooluse-sonnet5 | tool-use turn 1 | claude-sonnet-5 | thinking block (display omitted, signature_delta), `tool_use` Bash with `input_json_delta`, cache read | 200 SSE | tool_use |
| 0006-s02-tooluse-sonnet5 | tool-use turn 2 | claude-sonnet-5 | request carries `tool_result` plus a `role: "system"` message (mid-conversation-system beta); final text | 200 SSE | end_turn |
| 0009-s03-thinking-sonnet5 | thinking request, not used | claude-sonnet-5 | `MAX_THINKING_TOKENS` ignored on Sonnet 5 (still adaptive); model chose no thinking; custom system prompt, no tools | 200 SSE | end_turn |
| 0011-s04-thinking-opus55 | extended thinking | claude-opus-5-5 | adaptive thinking actually used (96 thinking tokens), effort medium, max_tokens 128000, Opus-only betas | 200 SSE | end_turn |
| 0013-s05-thinking-budget-haiku45 | budget thinking | claude-haiku-4-5-20251001 | `thinking: {type: enabled, budget_tokens: 1024}`, thinking + signature deltas, no output_config | 200 SSE | end_turn |
| 0015-s06-text-fable51 | plain text | claude-fable-5-1 | Fable 5.1 model, effort high | 200 SSE | end_turn |
| 0017-s07-context1m-sonnet5 | 1M context | claude-sonnet-5 (`[1m]`) | `context-1m-2025-08-07` beta; model id sent without the `[1m]` suffix | 200 SSE | end_turn |
| 0019-s08-websearch-sonnet5 | web search, turn 1 | claude-sonnet-5 | main model calls the client-side `WebSearch` tool | 200 SSE | tool_use |
| 0020-s08-websearch-sonnet5 | web search, inner call | claude-sonnet-5 | CLI's own request with server tool `web_search_20250305`, forced `tool_choice`, thinking disabled; `server_tool_use`, `web_search_tool_result`, `citations_delta`, `usage.server_tool_use.web_search_requests: 1` | 200 SSE | end_turn |
| 0021-s08-websearch-sonnet5 | web search, turn 2 | claude-sonnet-5 | tool result back to the main model, final answer | 200 SSE | end_turn |
| 0023–0028-s09-count-tokens | count_tokens | claude-sonnet-5 | `POST /v1/messages/count_tokens?beta=true` x6 (from `/context`), `token-counting-2024-11-01` beta, br-encoded JSON `{input_tokens}` | 200 JSON | n/a |
| 0037-s10-error-404-unknown-model | 404, streaming | claude-nonexistent-9 | `not_found_error`, `x-should-retry: false`, no rate-limit headers | 404 JSON | n/a |
| 0038-s10-error-404-unknown-model | 404, non-streaming retry | claude-nonexistent-9 | CLI's fallback retry with `stream: false`, `x-stainless-timeout: 300` | 404 JSON | n/a |
| 0040-s11-haiku45-maxtokens-clamped | intended 400 (not triggered) | claude-haiku-4-5-20251001 | `CLAUDE_CODE_MAX_OUTPUT_TOKENS=900000` clamped by the CLI to 64000; default Haiku thinking budget = max_tokens - 1 | 200 SSE | end_turn |
| 0042-s12-haiku45-custom-betas-ignored | intended 400 (not triggered) | claude-haiku-4-5-20251001 | `--betas` ignored under OAuth ("only available for API key users") | 200 SSE | end_turn |
| 0044-s13-haiku45-bad-image-stripped | intended 400 (not triggered) | claude-haiku-4-5-20251001 | invalid base64 image sent via stream-json input was dropped by the CLI (request has only text blocks); thinking without `display` field | 200 SSE | end_turn |
| 0046-s14-error-400-prompt-too-long | 400 invalid request | claude-haiku-4-5-20251001 | `invalid_request_error` "prompt is too long: 207706 tokens > 200000 maximum" on a 1.3 MB prompt; body sent was ~1.3 MB | 400 JSON | n/a |

Not recorded:
- 413 oversize: the CLI refuses piped stdin over 10 MB locally ("piped stdin input exceeds 10MB"), so no request
  over the 32 MB API limit could be sent through `claude -p` without reading files. No fixture.
- claude-opus-5 (also in the app's model list, not in the requested set): not recorded to save usage.

Fixture count: 23 JSON files.

Copied into the repo on 2026-09-26 (synapse-public, bug 280) with one more scrub: every `anthropic-ratelimit-unified-*`
response header value (the owner's plan utilization, reset times and overage state) is `<redacted>`; the header
names are kept. `host/test/auth/replay-anthropic.ts` serves them; `recordings.privacy.test.ts` re-scans them.
