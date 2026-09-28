/**
 * fix-mac-gate-and-approval-expiry (Bug B): an approval card means the Bot has stopped and waits for the user's choice
 * before the turn goes on. Live, the Mac card expired after
 * 10 minutes ("The user didn't answer the request in time", three times in one hour on 2026-09-21).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { LocalAsks } from "../../local/asks";

let now = 0;
let entries: Map<string, { message: { card: { askId: string; status: string } } }>;
let file: string;
const bots = { appendEntry: (_b: string, e: never) => entries.set((e as { id: string }).id, e), updateEntry: (_b: string, e: never) => entries.set((e as { id: string }).id, e), getEntry: (_b: string, id: string) => entries.get(id) ?? null } as never;
const slot = () => ({ turnNo: 2, nextSendK: 0, requestId: "req_9", segment: 0 }) as never;
const status = (askId: string) => [...entries.values()].find((e) => e.message.card.askId === askId)?.message.card.status;

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000;
  entries = new Map();
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "asks-")), "local-asks.json");
});
afterEach(() => vi.useRealTimers());

describe("Mac cards wait for the answer (Bug B)", () => {
  it("a card answered 30 minutes later still works", async () => {
    const asks = new LocalAsks({ bots, now: () => now });
    const p = asks.ask("b1", slot(), { action: "run-command", target: "ls ~/Downloads" });
    now += 30 * 60_000;
    vi.advanceTimersByTime(30 * 60_000);
    const askId = [...entries.values()][0]!.message.card.askId;
    expect(status(askId)).toBe("pending");
    asks.resolve("b1", askId, "once");
    await expect(p).resolves.toEqual({ askId, outcome: "allowed" });
  });

  it("the session ending leaves the card answerable; the answer wakes the Bot, and its re-run carries the approval once", async () => {
    const wake = vi.fn();
    const asks = new LocalAsks({ bots, now: () => now, wake });
    const p = asks.ask("b1", slot(), { action: "run-command", target: "ls ~/Downloads" });
    asks.expireAll("b1"); // Stop / rollover / redirect
    const { askId, outcome } = await p;
    expect(outcome).toBe("detached");
    expect(status(askId)).toBe("pending"); // never "expired"
    now += 45 * 60_000;
    asks.resolve("b1", askId, "once");
    expect(status(askId)).toBe("allowed");
    expect(wake).toHaveBeenCalledWith("b1", STR5.localAskResumed("ls ~/Downloads"));
    expect(asks.takeLateApproval("b2", "run-command", "ls ~/Downloads")).toBeNull(); // bound to the Bot
    expect(asks.takeLateApproval("b1", "run-command", "ls /")).toBeNull();           // bound to the exact command
    expect(asks.takeLateApproval("b1", "run-command", "ls ~/Downloads")).toBe(askId);
    expect(asks.takeLateApproval("b1", "run-command", "ls ~/Downloads")).toBeNull(); // one-time
  });

  it("a declined late answer wakes the Bot with the decision and leaves no approval", async () => {
    const wake = vi.fn();
    const asks = new LocalAsks({ bots, now: () => now, wake });
    const p = asks.ask("b1", slot(), { action: "run-command", target: "brew upgrade" });
    asks.expireAll("b1");
    const { askId } = await p;
    asks.resolve("b1", askId, "deny");
    expect(wake).toHaveBeenCalledWith("b1", STR5.localAskDeclined("brew upgrade"));
    expect(asks.takeLateApproval("b1", "run-command", "brew upgrade")).toBeNull();
  });

  it("a host restart between the card and the answer: the card is still answerable and the answer wakes the Bot", async () => {
    const before = new LocalAsks({ bots, now: () => now, file });
    void before.ask("b1", slot(), { action: "read-file", target: "/Users/alex/Downloads" });
    const askId = [...entries.values()][0]!.message.card.askId;
    const wake = vi.fn();
    const after = new LocalAsks({ bots, now: () => now + 60_000, file, wake }); // a new host process
    expect(() => after.resolve("b2", askId, "once")).toThrow(/no longer waiting/); // another Bot can't answer it
    expect(after.resolve("b1", askId, "once")).toBe("allowed");
    expect(wake).toHaveBeenCalledWith("b1", STR5.localAskResumed("/Users/alex/Downloads"));
    const again = new LocalAsks({ bots, now: () => now + 120_000, file });
    expect(again.takeLateApproval("b1", "read-file", "/Users/alex/Downloads")).toBe(askId); // survives a second restart
    expect(() => again.resolve("b1", askId, "once")).toThrow(); // answered once only
  });

  it("an unanswered card is withdrawn after 7 days (hygiene) with a clear reason, never after 10 minutes", async () => {
    const asks = new LocalAsks({ bots, now: () => now });
    const p = asks.ask("b1", slot(), { action: "run-command", target: "ls" });
    vi.advanceTimersByTime(10 * 60_000 + 1);
    const askId = [...entries.values()][0]!.message.card.askId;
    expect(status(askId)).toBe("pending");
    vi.advanceTimersByTime(7 * 24 * 3_600_000);
    expect(status(askId)).toBe("expired");
    await expect(p).resolves.toMatchObject({ outcome: "expired" });
    expect(STR5.localOutcome.expired).toMatch(/7 days/);
  });
});

describe("fix-fullauto-adoption: one adoption card per Bot; bug #96: post() never blocks", () => {
  it("adopt() coalesces a Bot's requests onto one card, survives a restart, grants nothing and wakes once", () => {
    const wake = vi.fn();
    const asks = new LocalAsks({ bots, now: () => now, file, wake });
    const a = asks.adopt("b1", slot(), "full-auto", "ls ~/Downloads");
    const b = asks.adopt("b1", { turnNo: 3, nextSendK: 0, requestId: "req_10", segment: 0 } as never, "full-auto", "cat ~/Downloads/x.pdf");
    expect(a.created).toBe(true);
    expect(b).toEqual({ askId: a.askId, created: false });
    expect(entries.size).toBe(1);
    expect(asks.adoptionPending("b1")).toBe("full-auto");
    expect(asks.adoptionPending("b2")).toBeNull();
    const after = new LocalAsks({ bots, now: () => now, file, wake }); // host restart
    expect(after.adoptionPending("b1")).toBe("full-auto");
    after.resolve("b1", a.askId, "always");
    expect(status(a.askId)).toBe("allowed");
    expect(after.granted("b1", "run-command")).toBe(false); // an adoption answer is never a host grant
    expect(after.takeLateApproval("b1", "run-command", "ls ~/Downloads")).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith("b1", STR5.localAdoptAllowed("full-auto", ["ls ~/Downloads", "cat ~/Downloads/x.pdf"]));
    expect(after.adoptionPending("b1")).toBeNull();
  });

  it("post() returns at once with the card pending; the answer wakes the Bot and leaves the one-time approval", () => {
    const wake = vi.fn();
    const asks = new LocalAsks({ bots, now: () => now, wake });
    const askId = asks.post("b1", slot(), { action: "run-command", target: "ls" });
    expect(status(askId)).toBe("pending");
    asks.resolve("b1", askId, "once");
    expect(wake).toHaveBeenCalledWith("b1", STR5.localAskResumed("ls"));
    expect(asks.takeLateApproval("b1", "run-command", "ls")).toBe(askId);
  });
});
