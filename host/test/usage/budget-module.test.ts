import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptEntry, UsageDashboardView } from "@synapse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAuthSource } from "../../auth/auth-env";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { TurnUsage } from "../../brain/types";
import type { CommandHandlers } from "../../gateway/server";
import type { HostModule } from "../../phase5/types";
import { HostSettingsStore } from "../../store/host-settings";
import { createBudgetModule, suggestMonthlyBudget } from "../../usage/budget-module";
import { Budgets } from "../../usage/budgets";
import { UsageDashboard } from "../../usage/dashboard";
import { UsageStore } from "../../usage/usage-store";

const TZ = "America/New_York";
const NOW = Date.UTC(2026, 8, 17, 15, 0, 0);
const u = (x: Partial<TurnUsage>): TurnUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...x });

let store: UsageStore;
let budgets: Budgets;
let mod: HostModule;
let sent: string[];
let slot: unknown;
let visible: ((botId: string, e: TranscriptEntry) => void) | null;
let wrapped: CommandHandlers;

let hostSettings!: HostSettingsStore;
beforeEach(() => {
  sent = [];
  slot = null;
  visible = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-mod-"));
  const settings = new HostSettingsStore(path.join(dir, "settings.json"));
  settings.update({ userTimeZone: TZ });
  hostSettings = settings;
  const bots = {
    has: (id: string) => id === "a", ids: () => ["a"],
    summary: (id: string) => ({ id, profile: { name: "Planner" } }),
    onBeforeVisibleAppend: (fn: typeof visible) => { visible = fn; return () => {}; },
  } as never;
  store = new UsageStore({ file: path.join(dir, "usage.db"), metricsFile: path.join(dir, "m.db"), bots, settings, flags: () => DEFAULT_FLAGS, now: () => NOW });
  const dashboard = new UsageDashboard({ usage: store, bots, tz: () => TZ, now: () => NOW });
  budgets = new Budgets({ usage: store, query: dashboard, settings, bots, now: () => NOW, tz: () => TZ, trays: { add: (t) => t as never } });
  const ctx = { bots, settings, now: () => NOW, slot: () => slot, hub: { publish: () => {} } } as never;
  mod = createBudgetModule(ctx, { usage: store, budgets, dashboard });
  mod.start?.();
  wrapped = mod.wrapHandlers!({ sendPrompt: async (a: { text: string }) => { sent.push(a.text); return { entryId: "a_u1" }; } } as never) as CommandHandlers;
});

const send = (text: string) => (wrapped.sendPrompt as (a: unknown) => Promise<unknown>)({ id: "a", text, clientNonce: text });
const spend = (usd: number) => store.recordHelper("a", "turn", "claude-sonnet-5", u({ costUsd: usd }));

describe("the user's own messages go through the budget", () => {
  it("sends under budget", async () => {
    await send("hi");
    expect(sent).toEqual(["hi"]);
  });

  it("asks first (BUDGET_ASK), and sends once the user approves", async () => {
    budgets.setPolicy("a", { limits: [{ period: "day", unit: "usd", limit: 1 }], warnPct: 80, onLimit: "ask" });
    spend(1.5);
    await expect(send("more")).rejects.toMatchObject({ code: "BUDGET_ASK" });
    expect(sent).toEqual([]);
    await (mod.handlers.approveBudget as (a: unknown) => Promise<unknown>)({ botId: "a" });
    await send("more");
    expect(sent).toEqual(["more"]);
  });

  it("does not stop a live voice call to ask (nobody can press Continue mid-sentence); pause still holds", async () => {
    budgets.setPolicy("a", { limits: [{ period: "day", unit: "usd", limit: 1 }], warnPct: 80, onLimit: "ask" });
    spend(1.5);
    await (wrapped.sendPrompt as (a: unknown) => Promise<unknown>)({ id: "a", text: "spoken", clientNonce: "v1", voice: { durationMs: 900, call: true } });
    expect(sent).toEqual(["spoken"]);
    budgets.setPolicy("a", { limits: [{ period: "day", unit: "usd", limit: 1 }], warnPct: 80, onLimit: "pause" });
    await expect((wrapped.sendPrompt as (a: unknown) => Promise<unknown>)({ id: "a", text: "again", clientNonce: "v2", voice: { durationMs: 900, call: true } })).rejects.toMatchObject({ code: "BUDGET_PAUSED" });
  });

  it("refuses while paused (BUDGET_PAUSED) and says how to continue", async () => {
    budgets.setPolicy("a", { limits: [{ period: "day", unit: "usd", limit: 1 }], warnPct: 80, onLimit: "pause" });
    spend(1.5);
    await expect(send("more")).rejects.toMatchObject({ code: "BUDGET_PAUSED", message: expect.stringContaining("Settings → Usage") });
  });
});

describe("\"tell me before you spend more than X\", said in chat", () => {
  const sendRaw = (a: Record<string, unknown>) => (wrapped.sendPrompt as (a: unknown) => Promise<unknown>)({ id: "a", clientNonce: String(a.text), ...a });
  let seen: Record<string, unknown>[];
  beforeEach(() => {
    seen = [];
    wrapped = mod.wrapHandlers!({ sendPrompt: async (a: Record<string, unknown>) => { seen.push(a); return { entryId: "a_u1" }; } } as never) as CommandHandlers;
  });

  it("sets the task alert from the user's own words and tells the Bot in a hint (no tool, no prompt cost)", async () => {
    await sendRaw({ text: "Clean up the inbox, but tell me before you spend more than $2.50 on it", hints: ["@Gmail"] });
    expect(budgets.taskAlert("a")).toMatchObject({ limitUsd: 2.5 });
    expect(seen[0]!.hints).toEqual(["@Gmail", expect.stringContaining("asked before this task passes $2.50")]);
    expect(mod.botTools?.("a", () => null) ?? []).toEqual([]);
  });

  it("understands the usual phrasings, and clearing it", async () => {
    for (const [text, usd] of [["ask me before spending over 3 dollars", 3], ["Check with me before you spend more than $0.75.", 0.75], ["warn me if this costs more than $10", 10]] as const) {
      await sendRaw({ text });
      expect(budgets.taskAlert("a")?.limitUsd, text).toBe(usd);
    }
    await sendRaw({ text: "never mind the spend alert" });
    expect(budgets.taskAlert("a")).toBeNull();
    await sendRaw({ text: "spend more time on the intro" });
    expect(budgets.taskAlert("a")).toBeNull();
  });

  it("asks before the next message once the task passes it", async () => {
    await sendRaw({ text: "tell me before you spend more than $1" });
    spend(1.2);
    await expect(sendRaw({ text: "go on" })).rejects.toMatchObject({ code: "BUDGET_ASK" });
  });
});

describe("runs are labelled and linked for the dashboard", () => {
  it("names a routine run after its routine, and links the run to its first visible message", () => {
    slot = { requestId: "req1", context: { wake: { kind: "routine", routineId: "rt_1", routineName: "Morning brief" } } };
    for (const o of mod.observers ?? []) o.onEvent?.("a", { kind: "dispatched" });
    visible?.("a", { kind: "send-message", id: "a_s3_1", requestId: "req1", createdAt: NOW, message: { type: "text", text: "Done" } } as never);
    store.onSettled({ botId: "a", requestId: "req1", lane: "background", source: "routine", hidden: true, startedAt: NOW, endedAt: NOW + 1, model: "m", userText: null, sentTexts: [],
      result: { sentMessageCount: 1, reacted: false, aborted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false, quiesced: false, usage: u({ costUsd: 0.4 }), finalText: "", toolCallCount: 0, model: "m" } });
    const v = (mod.handlers.getUsageDashboard as (a: unknown) => { top: unknown[]; tasks: { label: string }[] })({ range: "day" });
    expect(v.top[0]).toMatchObject({ label: "Morning brief", link: { chatId: "a", entryId: "a_s3_1" } });
    expect(v.tasks[0]!.label).toBe("Morning brief");
  });
});

describe("dollars and the budget prompt (the API key is the only sign-in)", () => {
  const prompt = () => (mod.handlers.getBudgetPrompt as () => { show: boolean; suggestedUsd: number })();
  const dash = () => (mod.handlers.getUsageDashboard as (a: unknown) => UsageDashboardView)({ range: "week", botId: null });
  afterEach(() => setAuthSource(null));

  it("suggests the last 30 days rounded up to the next $5 (at least $5)", () => {
    expect([0, 0.4, 5, 5.01, 94.05].map(suggestMonthlyBudget)).toEqual([5, 5, 5, 10, 95]);
  });

  it("asks once a key is saved and no monthly budget is set; Save (a budget) or Not now ends it; no plan fields", () => {
    setAuthSource({ apiKey: () => null });
    expect(prompt().show).toBe(false); // no key yet
    setAuthSource({ apiKey: () => "sk-ant-api03-x" });
    spend(12.3);
    expect(prompt()).toEqual({ show: true, suggestedUsd: 15 });
    for (const k of ["subscription", "plan", "windows"]) expect(dash(), k).not.toHaveProperty(k);
    expect(dash().spend).toMatchObject({ today: 12.3, month: 12.3 });
    budgets.setPolicy(null, { limits: [{ period: "month", unit: "usd", limit: 15 }], warnPct: 80, onLimit: "ask" });
    expect(prompt().show).toBe(false);
    budgets.setPolicy(null, null);
    expect(prompt().show).toBe(true);
    (mod.handlers.dismissBudgetPrompt as () => unknown)();
    expect(prompt().show).toBe(false);
  });

  it("at the monthly budget new work asks first; near it the ladder's budget figure rises", () => {
    budgets.setPolicy(null, { limits: [{ period: "month", unit: "usd", limit: 10 }], warnPct: 80, onLimit: "ask" });
    spend(8.5);
    expect(budgets.accountMonthPct()).toBeCloseTo(85);
    spend(2);
    expect(budgets.check("a").verdict).toBe("ask");
  });
});

describe("review fixes: the Mac's claude asks before it spends, and its spend is counted", () => {
  type Auth = { keySaved: boolean; spend: { ok: boolean; message: string | null }; promptCacheTtl?: "5m" | "1h" };
  const ask = (botId = "a") => (mod.handlers.macClaudeAuth as (a: unknown) => Auth)({ botId });
  const record = (a: unknown) => (mod.handlers.recordMacUsage as (a: unknown) => unknown)(a);
  afterEach(() => setAuthSource(null));

  it("with a key: ok under budget; over the account's monthly budget it says no, with the budget message", () => {
    setAuthSource({ apiKey: () => "sk-ant-api03-x" });
    expect(ask()).toEqual({ keySaved: true, spend: { ok: true, message: null }, promptCacheTtl: "1h" });
    budgets.setPolicy(null, { limits: [{ period: "month", unit: "usd", limit: 1 }], warnPct: 80, onLimit: "ask" });
    spend(1.5);
    const r = ask();
    expect(r.spend.ok).toBe(false);
    expect(r.spend.message).toBeTruthy();
  });

  it("reports whether the host has a key (a stale Mac copy can't keep spending); there is no sign-in mode", () => {
    setAuthSource({ apiKey: () => null });
    expect(ask()).toEqual({ keySaved: false, spend: { ok: true, message: null }, promptCacheTtl: "1h" });
  });

  it("review round 3: carries the Savings cache-TTL setting, so the Mac's claude follows it", () => {
    setAuthSource({ apiKey: () => "sk-ant-api03-x" });
    hostSettings.update({ promptCacheTtl: "5m" } as never);
    expect(ask().promptCacheTtl).toBe("5m");
  });

  it("recordMacUsage prices the tokens and counts them in the spend view and the monthly budget", () => {
    budgets.setPolicy(null, { limits: [{ period: "month", unit: "usd", limit: 10 }], warnPct: 80, onLimit: "ask" });
    record({ botId: "a", model: "claude-sonnet-5", usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    const s = (mod.handlers.getUsageDashboard as (a: unknown) => UsageDashboardView)({ range: "week", botId: null }).spend;
    expect(s.today).toBeGreaterThan(2.9); // $2/MTok input + $10/MTok output at list price
    expect(budgets.accountMonthPct()).toBeGreaterThan(29);
  });

  it("recordMacUsage refuses nonsense (negative, non-numeric, huge) and an unknown Bot counts under the host", () => {
    expect(() => record({ botId: "a", model: "m", usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })).toThrow();
    expect(() => record({ botId: "a", model: "m", usage: { inputTokens: "x" } })).toThrow();
    expect(() => record({ botId: "a", model: "m", usage: { inputTokens: 1e12, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })).toThrow();
    record({ botId: "ghost", model: "claude-haiku-4-5", usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  });
});

describe("review fix: the monthly budget prompt keeps the rest of the account policy", () => {
  it("setMonthlyBudget merges the month $ limit into the existing account policy (other limits, onLimit, warnPct kept)", () => {
    budgets.setPolicy(null, { limits: [{ period: "day", unit: "usd", limit: 3 }, { period: "month", unit: "tokens", limit: 9_000_000 }], warnPct: 60, onLimit: "pause" });
    (mod.handlers.setMonthlyBudget as (a: unknown) => unknown)({ usd: 40 });
    expect(budgets.config().account).toEqual({ limits: [{ period: "day", unit: "usd", limit: 3 }, { period: "month", unit: "tokens", limit: 9_000_000 }, { period: "month", unit: "usd", limit: 40 }], warnPct: 60, onLimit: "pause" });
    (mod.handlers.setMonthlyBudget as (a: unknown) => unknown)({ usd: 55 });
    expect(budgets.config().account!.limits.filter((l) => l.period === "month" && l.unit === "usd")).toEqual([{ period: "month", unit: "usd", limit: 55 }]);
  });

  it("with no account policy it starts one that asks at the limit", () => {
    (mod.handlers.setMonthlyBudget as (a: unknown) => unknown)({ usd: 20 });
    expect(budgets.config().account).toEqual({ limits: [{ period: "month", unit: "usd", limit: 20 }], warnPct: 80, onLimit: "ask" });
    expect(() => (mod.handlers.setMonthlyBudget as (a: unknown) => unknown)({ usd: 0 })).toThrow();
  });
});
