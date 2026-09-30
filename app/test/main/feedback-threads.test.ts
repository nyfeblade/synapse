// Replies to feedback, main side: the thread code is kept in a 0600 file and sent only as a header;
// the background check runs at launch and every 4 hours while a thread is open and under 30 days old;
// a new reply raises the notice.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFeedback } from "../../src/main/feedback/wire";
import { POLL_MS, ThreadStore, startThreadPolling, threadId } from "../../src/main/feedback/threads";

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fbt-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); });

const CODE = "3.AbCdEfGhIjKlMnOpQrStUv";
const ok = { type: "bug", message: "It broke", appVersion: "0.1.2", macos: "macOS 15.1.0", model: "Mac14,2" };

function setup(server: (url: string, init: RequestInit) => Response) {
  const handlers = new Map<string, (a: any) => unknown>();
  const dir = tmp();
  const fetch = vi.fn(async (url: string, init: RequestInit) => server(url, init));
  const onReply = vi.fn();
  const api = installFeedback({
    reg: (n, f) => handlers.set(n, f), userData: dir, home: "/Users/jane", appVersion: "0.1.2", macos: "15.1.0",
    logFiles: () => [], secrets: () => [], crashText: () => null, capture: async () => null, openExternal: async () => {},
    fetch: fetch as unknown as typeof globalThis.fetch, model: async () => "Mac14,2", endpoint: "https://site.test/api/feedback", onReply, firstPollMs: 60 * 60 * 1000,
  });
  return { dir, fetch, onReply, api, call: (n: string, a: unknown = {}) => Promise.resolve(handlers.get(n)!(a)) };
}

let replies: { from: string; text: string; at: string }[] = [];
let gone = false;
const server = (url: string, init: RequestInit) => {
  if (url.endsWith("/api/feedback")) return new Response(JSON.stringify({ ok: true, thread: CODE }));
  if (url.endsWith("/api/feedback/thread") && gone) return new Response(JSON.stringify({ ok: false }), { status: 404 });
  if (url.endsWith("/api/feedback/thread") && init.method === "GET") return new Response(JSON.stringify({ ok: true, status: "open", messages: [{ from: "you", text: "It broke", at: "2026-09-29T10:00:00.000Z" }, ...replies] }));
  if (url.endsWith("/api/feedback/thread")) return new Response(JSON.stringify({ ok: true }));
  return new Response("{}", { status: 404 });
};

describe("feedback threads (main)", () => {
  it("keeps the code in a 0600 file, gives the renderer only a short id, and sends the code only as a header", async () => {
    replies = [];
    const s = setup(server);
    await s.call("feedback.send", ok);
    const file = path.join(s.dir, "feedback-threads.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).threads[0]).toMatchObject({ code: CODE, seenReplies: 0, status: "open" });
    const list = await s.call("feedback.threads.list") as { threads: { id: string }[] };
    expect(JSON.stringify(list)).not.toContain(CODE);
    expect(list.threads[0]!.id).toBe(threadId(CODE));
    await s.call("feedback.threads.refresh");
    await s.call("feedback.threads.reply", { id: threadId(CODE), message: "Still broken" });
    for (const [url, init] of s.fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).not.toContain(CODE);
      if (url.endsWith("/thread")) expect((init.headers as Record<string, string>)["x-feedback-code"]).toBe(CODE);
    }
    s.api.stopPolling();
  });

  it("a new reply raises the notice once, and viewing marks it seen", async () => {
    replies = [];
    const s = setup(server);
    await s.call("feedback.send", ok);
    await s.api.checkThreads();
    expect(s.onReply).not.toHaveBeenCalled();
    replies = [{ from: "synapse", text: "Fixed in 0.1.3", at: "2026-09-29T12:00:00.000Z" }];
    await s.api.checkThreads();
    expect(s.onReply).toHaveBeenCalledWith(1);
    await s.api.checkThreads();
    expect(s.onReply).toHaveBeenCalledTimes(1);
    expect((await s.call("feedback.threads.list") as { unread: number }).unread).toBe(1);
    await s.call("feedback.threads.markSeen");
    expect((await s.call("feedback.threads.list") as { unread: number }).unread).toBe(0);
    s.api.stopPolling();
  });
});

describe("the poll schedule", () => {
  it("checks at launch, then every 4 hours, only while a thread is open and under 30 days old", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-29T10:00:00Z") });
    const store = new ThreadStore(path.join(tmp(), "t.json"));
    const check = vi.fn(async () => {});
    const idle = startThreadPolling({ store, check, firstDelayMs: 30_000 });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(check).not.toHaveBeenCalled(); // nothing to check: no timer at all
    store.add(CODE, "hi");
    idle.kick();
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(check).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    idle.stop();

    const launch = startThreadPolling({ store, check, firstDelayMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(3);
    // 31 days later nothing is active, so the checks stop by themselves.
    vi.setSystemTime(Date.parse("2026-10-31T10:00:00Z"));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const n = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(check.mock.calls.length).toBe(n);
    launch.stop();
  });

  it("a closed thread isn't checked", () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-29T10:00:00Z"), toFake: ["Date"] });
    const store = new ThreadStore(path.join(tmp(), "t.json"));
    store.add(CODE, "hi");
    vi.setSystemTime(Date.now() + 8 * 86400_000);
    store.notFound(CODE);
    expect(store.active()).toEqual([]);
  });

  it("a 404 within 7 days of sending is 'try again later': the thread stays open; after 7 days it closes", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-29T10:00:00Z"), toFake: ["Date"] });
    replies = []; gone = true;
    const s = setup(server);
    await s.call("feedback.send", ok);
    await s.api.checkThreads();
    expect((await s.call("feedback.threads.list") as { threads: { status: string }[] }).threads[0]!.status).toBe("open");
    vi.setSystemTime(Date.parse("2026-10-07T10:00:00Z"));
    await s.api.checkThreads();
    expect((await s.call("feedback.threads.list") as { threads: { status: string }[] }).threads[0]!.status).toBe("closed");
    gone = false;
    s.api.stopPolling();
  });
});
