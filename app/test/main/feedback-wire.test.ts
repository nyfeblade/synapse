// Send feedback, main side: the payload check, the one network call, the GitHub link guard, the
// screenshot fitting and the local-only ratings store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPayload, fitPng, installFeedback, type ImageLike } from "../../src/main/feedback/wire";
import { RatingsStore } from "../../src/main/feedback/ratings";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fb-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup(over: Partial<Parameters<typeof installFeedback>[0]> = {}) {
  const handlers = new Map<string, (a: any) => unknown>();
  const dir = tmp();
  const log = path.join(dir, "main.log");
  fs.writeFileSync(log, ["info one", "warn key=sk-ant-api03-ABCDEFG0123456789abcdefghij", "info at /Users/jane/Library/x", "info mail jane@example.com"].join("\n") + "\n");
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const openExternal = vi.fn(async () => {});
  installFeedback({
    reg: (n, f) => handlers.set(n, f), userData: dir, home: "/Users/jane", appVersion: "0.1.2", macos: "15.1.0",
    logFiles: () => [log], secrets: () => [], crashText: (id) => (id === "latest" ? "Synapse problem report\nApp log (last lines):\ninfo crash at /Users/jane/x" : null),
    capture: async () => "iVBORw0KGgo=", openExternal, fetch: fetch as unknown as typeof globalThis.fetch, model: async () => "Mac14,2", ...over,
  });
  return { call: (n: string, a: unknown = {}) => Promise.resolve(handlers.get(n)!(a)), fetch, openExternal };
}

const ok = { type: "bug", message: "It broke", appVersion: "0.1.2", macos: "macOS 15.1.0", model: "Mac14,2" };

describe("feedback.context", () => {
  it("gives versions, the Mac model and the last log lines, scrubbed", async () => {
    const { call } = setup();
    const c = await call("feedback.context") as { appVersion: string; macos: string; model: string; logs: string };
    expect(c).toMatchObject({ appVersion: "0.1.2", macos: "macOS 15.1.0", model: "Mac14,2" });
    expect(c.logs).toContain("info one");
    expect(c.logs).not.toContain("sk-ant-");
    expect(c.logs).not.toContain("jane");
    expect(c.logs).toContain("~/Library/x");
  });

  it("uses a crash report as the logs for Send a report", async () => {
    const { call } = setup();
    const c = await call("feedback.context", { crash: "latest" }) as { logs: string };
    expect(c.logs).toContain("Synapse problem report");
    expect(c.logs).toContain("~/x");
  });
});

describe("feedback.send", () => {
  it("posts exactly the checked payload as JSON to the website's endpoint", async () => {
    const { call, fetch } = setup();
    await expect(call("feedback.send", { ...ok, logs: "info one" })).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/feedback$/);
    expect(JSON.parse(String(init.body))).toEqual({ source: "app", ...ok, logs: "info one" });
  });

  it("refuses a missing type or message before any network call", async () => {
    const { call, fetch } = setup();
    await expect(call("feedback.send", { ...ok, type: "rant" })).rejects.toThrow("Choose a type.");
    await expect(call("feedback.send", { ...ok, message: "  " })).rejects.toThrow("Write a message first.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says what went wrong when the server refuses", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "Too many at once." }), { status: 429 }));
    const { call } = setup({ fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(call("feedback.send", ok)).rejects.toThrow("Too many at once.");
  });
});

describe("feedback.openIssue", () => {
  it("opens only a new issue on the public repo, within the length limit", async () => {
    const { call, openExternal } = setup();
    await call("feedback.openIssue", { url: "https://github.com/nyfeblade/synapse/issues/new?title=x" });
    expect(openExternal).toHaveBeenCalledTimes(1);
    await expect(call("feedback.openIssue", { url: "https://evil.example/issues/new?" })).rejects.toThrow();
    await expect(call("feedback.openIssue", { url: `https://github.com/nyfeblade/synapse/issues/new?body=${"a".repeat(9000)}` })).rejects.toThrow();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});

describe("checkPayload and fitPng", () => {
  it("caps logs and screenshot sizes", () => {
    expect(() => checkPayload({ ...ok, logs: "x".repeat(70 * 1024) })).toThrow();
    expect(() => checkPayload({ ...ok, screenshot: "not base64!" })).toThrow();
    expect(checkPayload({ ...ok, extra: "dropped" })).toEqual({ source: "app", ...ok });
  });

  it("scales the window image down until it fits", () => {
    const sizes: number[] = [];
    const img = (width: number): ImageLike => ({
      getSize: () => ({ width, height: width / 2 }),
      resize: ({ width: w }) => img(w),
      toPNG: () => { sizes.push(width); return Buffer.alloc(width * 1000); },
    });
    const b64 = fitPng(img(2880), 1_100_000);
    expect(b64).not.toBeNull();
    expect(b64!.length).toBeLessThanOrEqual(1_100_000);
    expect(sizes[0]).toBe(1440);
  });
});

describe("ratings (local only)", () => {
  it("stores 👍/👎 per Bot and entry, toggles off with 0, and counts", () => {
    const s = new RatingsStore(path.join(tmp(), "feedback-ratings.json"));
    s.set("bot1", "e1", "reply", 1);
    s.set("bot1", "act-2", "task", -1);
    s.set("bot1", "e3", "reply", 1);
    expect(s.get("bot1")).toMatchObject({ up: 2, down: 1, ratings: { e1: 1, "act-2": -1, e3: 1 } });
    s.set("bot1", "e1", "reply", 0);
    expect(s.get("bot1")).toMatchObject({ up: 1, down: 1 });
    expect(s.get("other")).toEqual({ ratings: {}, up: 0, down: 0 });
    expect(() => s.set("../x", "e", "reply", 1)).toThrow();
  });

  it("never touches the network", async () => {
    const { call, fetch } = setup();
    await call("ratings.set", { botId: "b", entryId: "e", kind: "reply", value: 1 });
    expect(await call("ratings.get", { botId: "b" })).toMatchObject({ up: 1, down: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("review round 1", () => {
  it("scrubs the Mac's user name from the logs", async () => {
    const { call } = setup({ username: "jdoe", logFiles: () => { const d = tmp(); const f = path.join(d, "m.log"); fs.writeFileSync(f, "info hello jdoe from /opt/x\n"); return [f]; } });
    const c = await call("feedback.context") as { logs: string };
    expect(c.logs).not.toContain("jdoe");
  });
  it("sends to the endpoint it was given", async () => {
    const { call, fetch } = setup({ endpoint: "http://127.0.0.1:9/api/feedback" });
    await call("feedback.send", ok);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("http://127.0.0.1:9/api/feedback");
  });
});
