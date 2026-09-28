import { afterEach, describe, expect, it } from "vitest";
import { MacKeyProxy, type MacUsageReport } from "../../src/coordinator/local-exec/mac-key-proxy";
import { loadRecordings, recordedUsage, recording, sseBody, startReplayAnthropic, type Recording, type ReplayAnthropic } from "../../../host/test/auth/replay-anthropic";

/**
 * Bug 280: the Mac key proxy against real recorded Anthropic answers (host/test/auth/replay-anthropic.ts). Each recorded
 * request goes in as the CLI sent it, with a run's proxy token in place of the OAuth login it was recorded with.
 * Checked: the answer reaches the CLI byte for byte; upstream gets the key as x-api-key and nothing of a Claude login;
 * the usage reported to the host equals the answer's final usage (1-hour cache writes and web searches included).
 */
const KEY = "sk-ant-api03-" + "M".repeat(80) + "rply";
const OAUTH_BETA = "oauth-2025-04-20";
let api: ReplayAnthropic | null = null;
let proxy: MacKeyProxy | null = null;
afterEach(async () => { await proxy?.stop(); proxy = null; await api?.close(); api = null; });

async function setup(queue: Recording[]) {
  const reports: MacUsageReport[] = [];
  api = await startReplayAnthropic({ apiKey: KEY, queue });
  proxy = new MacKeyProxy({ key: () => KEY, upstream: api.url, onUsage: (u) => reports.push(u) });
  const g = await proxy.grant({ botId: "b1" });
  if (!("token" in g)) throw new Error("no grant");
  return { api, proxy, g, reports };
}
function send(url: string, r: Recording, token: string): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.request.headers)) if (!["host", "content-length", "connection", "x-claude-code-session-id"].includes(k)) headers[k] = v;
  headers["x-api-key"] = token;
  return fetch(`${url}${r.request.path}`, { method: r.request.method, headers, body: JSON.stringify(r.request.body) });
}
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

const sse = loadRecordings().filter((r) => r.response.kind === "sse");

describe("Mac key proxy × recorded streams", () => {
  it.each(sse.map((r) => [r.file, r] as const))("%s: byte for byte, only the key upstream, the reported usage equals the recorded usage", async (_f, r) => {
    const { api, g, reports } = await setup([r]);
    const res = await send(g.baseUrl, r, g.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(sseBody(r));
    const up = api.requests.at(-1)!;
    expect(up.served).toBe(r.file);
    expect(up.apiKey).toBe(KEY);
    expect(up.authorization).toBeNull();
    expect(up.headers["accept-encoding"]).toBe("identity");
    expect(up.beta ?? "").not.toContain(OAUTH_BETA);
    expect(up.beta).toBe(r.request.headers["anthropic-beta"]!.split(",").filter((b) => b.trim() !== OAUTH_BETA).join(","));
    await until(() => reports.length > 0);
    const want = recordedUsage(r);
    expect(reports).toEqual([{
      botId: "b1", model: r.request.body.model,
      usage: {
        inputTokens: want.inputTokens, outputTokens: want.outputTokens, cacheReadTokens: want.cacheReadTokens, cacheWriteTokens: want.cacheWriteTokens,
        ...(want.cacheWrite1hTokens ? { cacheWrite1hTokens: want.cacheWrite1hTokens } : {}),
        ...(want.webSearchRequests ? { webSearchRequests: want.webSearchRequests } : {}),
      },
    }]);
  });

  it("web search (0020): the input the search results added (13,025, not message_start's 2,984) and the one search", async () => {
    const { g, reports } = await setup([recording("0020")]);
    await (await send(g.baseUrl, recording("0020"), g.token)).text();
    await until(() => reports.length > 0);
    expect(reports[0]!.usage).toMatchObject({ inputTokens: 13025, outputTokens: 391, webSearchRequests: 1 });
  });
});

describe("Mac key proxy × count_tokens and errors", () => {
  const counts = loadRecordings().filter((r) => r.request.path.startsWith("/v1/messages/count_tokens"));
  it.each(counts.map((r) => [r.file, r] as const))("%s: passes, not reported as spend, no OAuth beta", async (_f, r) => {
    const { api, g, reports } = await setup([r]);
    const res = await send(g.baseUrl, r, g.token);
    expect(await res.json()).toEqual(r.response.body);
    expect(api.requests.at(-1)!.beta ?? "").not.toContain(OAUTH_BETA);
    await new Promise((x) => setTimeout(x, 20));
    expect(reports).toEqual([]);
  });

  it.each(["0037", "0038", "0046"])("%s: the recorded error passes as sent, nothing reported", async (id) => {
    const r = recording(id);
    const { g, reports } = await setup([r]);
    const res = await send(g.baseUrl, r, g.token);
    expect(res.status).toBe(r.response.status);
    expect(await res.json()).toEqual(r.response.body);
    await new Promise((x) => setTimeout(x, 20));
    expect(reports).toEqual([]);
  });
});
