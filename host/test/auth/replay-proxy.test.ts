import { afterEach, describe, expect, it } from "vitest";
import { AuthProxy, type ReportedTokens } from "../../auth/proxy";
import { loadRecordings, recordedUsage, recording, sseBody, startReplayAnthropic, type Recording, type ReplayAnthropic } from "./replay-anthropic";

/**
 * Bug 280: the box key proxy against real recorded Anthropic answers (replay-anthropic.ts). Each recorded request is
 * sent as the CLI sent it (its headers, its betas, its body), with a proxy token in place of the OAuth login it was
 * recorded with. Checked: the answer reaches the CLI byte for byte; what went upstream is the key as x-api-key and
 * nothing of a Claude login (no Authorization, no oauth beta); the metering equals the answer's own final usage.
 */
const KEY = "sk-ant-api03-" + "R".repeat(80) + "rply";
const OAUTH_BETA = "oauth-2025-04-20";
let api: ReplayAnthropic | null = null;
let proxy: AuthProxy | null = null;
afterEach(async () => { await proxy?.stop(); proxy = null; await api?.close(); api = null; });

const unreported: Array<{ botId: string | null; model: string; u: ReportedTokens & { cacheWrite1hTokens: number; webSearchRequests: number } }> = [];
async function setup(queue: Recording[]) {
  unreported.length = 0;
  api = await startReplayAnthropic({ apiKey: KEY, queue });
  proxy = new AuthProxy({ upstream: api.url, port: 0, credential: () => KEY, onUnreported: (botId, model, u) => unreported.push({ botId, model, u }) });
  await proxy.start();
  return { api, proxy };
}

/** The recorded request, as the CLI sent it, with `token` instead of its login. */
function send(url: string, r: Recording, token: string): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.request.headers)) if (!["host", "content-length", "connection", "x-claude-code-session-id"].includes(k)) headers[k] = v;
  headers["x-api-key"] = token;
  return fetch(`${url}${r.request.path}`, { method: r.request.method, headers, body: JSON.stringify(r.request.body) });
}

const sse = loadRecordings().filter((r) => r.response.kind === "sse");
const zero: ReportedTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 };

describe("box key proxy × recorded streams", () => {
  it("the fixtures are all there: 23 recordings, 14 streamed", () => {
    expect(loadRecordings()).toHaveLength(23);
    expect(sse).toHaveLength(14);
  });

  it.each(sse.map((r) => [r.file, r] as const))("%s: streams through byte for byte, upstream gets only the key, metering equals the recorded usage", async (_f, r) => {
    const { api, proxy } = await setup([r]);
    const tok = proxy.issue({ botId: "b1" });
    const res = await send(proxy.url, r, tok);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("content-encoding")).toBeNull(); // the proxy asked for identity, so every byte was metered
    expect(await res.text()).toBe(sseBody(r));

    const up = api.requests.at(-1)!;
    expect(up.served).toBe(r.file);
    expect(up.apiKey).toBe(KEY);
    expect(up.authorization).toBeNull();
    expect(up.headers["accept-encoding"]).toBe("identity");
    // The recording was made with a Claude login, so its betas carry the OAuth one; the public proxy never sends it.
    expect(r.request.headers["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(up.beta ?? "").not.toContain(OAUTH_BETA);
    // Every other beta passes in order (the prompt cache and the features depend on them).
    expect(up.beta).toBe(r.request.headers["anthropic-beta"]!.split(",").filter((b) => b.trim() !== OAUTH_BETA).join(","));
    expect(JSON.stringify(up.headers)).not.toContain(tok);

    const want = recordedUsage(r);
    const got = proxy.usage("b1");
    expect({ requests: got.requests, input: got.inputTokens, output: got.outputTokens, read: got.cacheReadTokens, write: got.cacheWriteTokens })
      .toEqual({ requests: 1, input: want.inputTokens, output: want.outputTokens, read: want.cacheReadTokens, write: want.cacheWriteTokens });
    // Released with nothing reported: everything that went through is handed on, 1-hour cache writes and web searches included.
    proxy.revoke(tok, zero);
    expect(unreported).toEqual([{ botId: "b1", model: r.request.body.model, u: want }]);
  });

  it("web search (0020): the searches are counted once, and the input the search results added is metered", async () => {
    const r = recording("0020");
    expect(recordedUsage(r)).toMatchObject({ inputTokens: 13025, webSearchRequests: 1 });
    const { proxy } = await setup([r]);
    const tok = proxy.issue({ botId: "b1" });
    await (await send(proxy.url, r, tok)).text();
    expect(proxy.usage("b1").inputTokens).toBe(13025);
    proxy.revoke(tok, zero);
    expect(unreported[0]!.u).toMatchObject({ inputTokens: 13025, outputTokens: 391, webSearchRequests: 1 });
  });

  it("a gzip-accepting client still gets identity bytes from upstream (else nothing could be metered)", async () => {
    const r = recording("0002");
    const direct = await startReplayAnthropic({ apiKey: KEY, queue: [r] });
    try {
      const res = await fetch(`${direct.url}${r.request.path}`, { method: "POST", headers: { "x-api-key": KEY, "accept-encoding": "gzip" }, body: "{}" });
      expect(res.headers.get("content-encoding")).toBe("gzip"); // the replay honours encodings as the API does
      expect(await res.text()).toBe(sseBody(r)); // fetch decompresses
    } finally { await direct.close(); }
  });
});

describe("box key proxy × count_tokens and error recordings", () => {
  const counts = loadRecordings().filter((r) => r.request.path.startsWith("/v1/messages/count_tokens"));
  it.each(counts.map((r) => [r.file, r] as const))("%s: count_tokens passes through (br-recorded, served plain), is not metered, no OAuth beta upstream", async (_f, r) => {
    const { api, proxy } = await setup([r]);
    const tok = proxy.issue({ botId: "b1" });
    const res = await send(proxy.url, r, tok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(r.response.body);
    expect(proxy.usage("b1").requests).toBe(0);
    const up = api.requests.at(-1)!;
    expect(up.apiKey).toBe(KEY);
    expect(up.authorization).toBeNull();
    expect(up.beta ?? "").not.toContain(OAUTH_BETA);
    expect(up.beta).toContain("token-counting-2024-11-01");
  });

  it.each(["0037", "0038", "0046"])("%s: the recorded error reaches the CLI as Anthropic sent it, unmetered", async (id) => {
    const r = recording(id);
    const { proxy } = await setup([r]);
    const tok = proxy.issue({ botId: "b1" });
    const res = await send(proxy.url, r, tok);
    expect(res.status).toBe(r.response.status);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(await res.json()).toEqual(r.response.body);
    expect(proxy.usage("b1").requests).toBe(0);
  });

  it("1M context (0017): the context-1m beta passes, the model goes without the [1m] suffix", async () => {
    const r = recording("0017");
    const { api, proxy } = await setup([r]);
    const tok = proxy.issue({ botId: "b1" });
    await (await send(proxy.url, r, tok)).text();
    const up = api.requests.at(-1)!;
    expect(up.beta).toContain("context-1m-2025-08-07");
    expect(up.body.model).toBe("claude-sonnet-5");
  });
});
