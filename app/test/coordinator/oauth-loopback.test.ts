import { describe, expect, it } from "vitest";
import { startOAuthLoopback } from "../../src/coordinator/oauth-loopback";

describe("OAuth loopback (PLG-04)", () => {
  it("forwards code and state to the host and answers with a closing page", async () => {
    const got: unknown[] = [];
    const lb = await startOAuthLoopback({ port: 0, complete: async (a) => { got.push(a); return { status: "connected" }; } });
    const res = await fetch(`http://127.0.0.1:${lb.port}/mcp/oauth/callback?code=abc&state=s1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You can close this tab");
    expect(got).toEqual([{ state: "s1", code: "abc" }]);
    const bad = await fetch(`http://127.0.0.1:${lb.port}/other`);
    expect(bad.status).toBe(404);
    lb.close();
  });
});

// P5 review minor: when the usual loopback port is taken, the next fallback port is used.
describe("OAuth loopback port fallback", () => {
  it("falls back to the next listed port when the first is busy", async () => {
    const http = await import("node:http");
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const busy = (blocker.address() as { port: number }).port;
    const free = await new Promise<number>((r) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
    const lb = await startOAuthLoopback({ ports: [busy, free], complete: async () => ({}) });
    expect(lb.port).toBe(free);
    lb.close();
    blocker.close();
  });
});
