import { afterEach, describe, expect, it } from "vitest";
import { STRS, type ApprovalCardView, type EventEntry, type RoutineView, type SendMessageEntry, type TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../app";
import { tmpConfig } from "./helpers";

const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function boot() {
  app = await createHostApp(tmpConfig({ WEBHOOK_PORT: "0", WEBHOOK_BIND: "127.0.0.1" }));
  const { webhookPort } = await app.services.phase4.start();
  const h = app.handlers;
  const make = async (name: string) => (await h.createAgent!({ name, isKickstartRequested: false })).id;
  const tail = async (id: string) => (await h.getAgentTranscriptTail!({ id, limit: 500 })).entries as TranscriptEntry[];
  const texts = async (id: string) => (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
  const events = async (id: string) => (await tail(id)).filter((e): e is EventEntry => e.kind === "event").map((e) => e.event);
  const card = async (id: string) => (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "auto-review-approval" ? [e.message.approval as ApprovalCardView] : [])).at(-1);
  /** A Bot's first schedule asks the user once (schedules-triggers-standup); approve it. */
  const approveFirstSchedule = async (id: string) => {
    await until(async () => (await card(id))?.status === "pending");
    expect(JSON.stringify(await card(id))).toContain(STRS.firstScheduleConfirm);
    await h.resolveAutoReviewApproval!({ id, approvalId: (await card(id))!.approvalId, choice: "once" });
  };
  return { h, make, tail, texts, events, webhookPort, card, approveFirstSchedule };
}

describe("Phase 4 on FakeBrain (in-process host)", () => {
  it("group: one member posts, the others pass, one aggregated pass row, and a sender preview (GRP-04/05/13/15)", async () => {
    const s = await boot();
    const [p, sc, l] = [await s.make("Planner"), await s.make("Scout"), await s.make("Ledger")];
    const { id: g, reused } = await s.h.createGroup!({ memberIds: [p, sc, l] });
    expect(reused).toBe(false);
    expect((await s.h.createGroup!({ memberIds: [l, sc, p] })).id).toBe(g);
    await s.h.sendPrompt!({ id: g, text: "@everyone plan a cheap weekend upstate", clientNonce: "g1" });
    await until(async () => (await s.events(g)).some((e) => e.type === "member-pass"));
    const posts = (await s.tail(g)).filter((e): e is SendMessageEntry => e.kind === "send-message" && Boolean(e.author));
    expect(posts.map((e) => [e.author!.name, (e.message as { content: string }).content])).toEqual([["Planner", "Here's a first take: plan a cheap weekend upstate"]]);
    const pass = (await s.events(g)).find((e) => e.type === "member-pass") as { botIds: string[] };
    expect(pass.botIds.sort()).toEqual([sc, l].sort());
    const row = (await s.h.listAgents!({})).agents.find((a) => a.id === g)!;
    expect(row.statusLine).toBe("Planner: Here's a first take: plan a cheap weekend upstate");
  });

  it("bot-to-bot: request → result → one wake with a wake-origin row, no trays (B2B-01, ORIG-09, CHAT-23)", async () => {
    const s = await boot();
    const [p, sc] = [await s.make("Planner"), await s.make("Scout")];
    await s.h.sendPrompt!({ id: p, text: "ask Scout: find three cabins near Hudson", clientNonce: "b1" });
    // Two real 5 s coalesce windows (LIMITS.coalesceWindowMs: the request to Scout, then the result to Planner) run before the relay.
    await until(async () => (await s.texts(p)).includes("Scout says: done — find three cabins near Hudson"), 16_000);
    expect((await s.events(p)).some((e) => e.type === "wake-origin" && e.source === "agent" && e.botIds?.includes(sc))).toBe(true);
    expect((await s.tail(sc)).some((e) => e.kind === "message" && "fromAgent" in e && e.fromAgent?.kind === "request")).toBe(true);
    expect((await s.h.getTrays!({})).trays).toHaveLength(0);
    const u = (await s.h.getUsage!({})).efficiency;
    expect(u.loopsEnded).toBe(0);
  });

  it("routines: created from chat, plain English with the raw tooltip, Test run records an ok run (RTN-02/03/05/17/18, C4)", async () => {
    const s = await boot();
    const p = await s.make("Planner");
    await s.h.sendPrompt!({ id: p, text: "routine: Morning sweep | every day at 8am | Sweep the inbox and summarize it", clientNonce: "r1" });
    await s.approveFirstSchedule(p);
    await until(async () => (await s.h.getAgentAutomations!({ id: p })).routines.length === 1);
    const [r] = (await s.h.getAgentAutomations!({ id: p })).routines as RoutineView[];
    expect(r).toMatchObject({ name: "Morning sweep", enabled: true, description: "Every day at 8:00 AM" });
    expect(r!.scheduleRaw).toMatch(/^CRON_TZ=\S+ 0 8 \* \* \*$/);
    expect((await s.events(p)).some((e) => e.type === "routine-created")).toBe(true);
    await s.h.runAgentAutomationNow!({ id: p, routineId: r!.id });
    await until(async () => (await s.texts(p)).includes("Routine ran: Morning sweep"));
    await until(async () => (await s.h.getAgentAutomations!({ id: p })).routines[0]!.runs[0]?.status === "ok");
    await s.h.setAgentAutomationEnabled!({ id: p, routineId: r!.id, enabled: false });
    expect((await s.h.getAgentAutomations!({ id: p })).routines[0]!.enabled).toBe(false);
  });

  it("routines: a Test run's history reaches the renderer over the automations SSE (RTN-18 through the UI, Task 48)", async () => {
    const s = await boot();
    const p = await s.make("Planner");
    const pushed: RoutineView[][] = [];
    const off = app!.hub.subscribe((e) => { if (e.channel === "automations" && e.payload.botId === p) pushed.push(e.payload.routines); });
    await s.h.sendPrompt!({ id: p, text: "routine: Morning sweep | every day at 8am | Sweep the inbox and summarize it", clientNonce: "r2" });
    await s.approveFirstSchedule(p);
    await until(async () => (await s.h.getAgentAutomations!({ id: p })).routines.length === 1);
    const [r] = (await s.h.getAgentAutomations!({ id: p })).routines as RoutineView[];
    await s.h.runAgentAutomationNow!({ id: p, routineId: r!.id });
    await until(() => pushed.some((rs) => rs[0]?.runs[0]?.status === "ok"));
    off();
  });

  it("webhook: 401 without the key, 200 with it, duplicate by Idempotency-Key, and a run (RTN-11, ORIG-04 §04.2)", async () => {
    const s = await boot();
    const p = await s.make("Hooky");
    const { routine, key } = await s.h.createAgentAutomation!({ id: p, name: "Deploy hook", prompt: "Summarize the deploy.", trigger: { webhook: {} } });
    const uuid = routine.webhook!.url.split("/").pop()!;
    const url = `http://127.0.0.1:${s.webhookPort}/hooks/${uuid}`;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "d1" }, body: '{"version":"1.4.2"}' });
    expect(ok.status).toBe(200);
    const dup = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "d1" }, body: "{}" });
    expect(await dup.json()).toMatchObject({ accepted: true, duplicate: true });
    await until(async () => (await s.h.getAgentAutomations!({ id: p })).routines[0]!.runs.some((x) => x.status === "ok"));
  });

  it("the routed sendPrompt keeps Phase 1's argument check for Bots and groups (BAD_ARGS)", async () => {
    const s = await boot();
    const [a, b] = [await s.make("A"), await s.make("B")];
    const { id: g } = await s.h.createGroup!({ memberIds: [a, b] });
    for (const id of [a, g]) await expect(Promise.resolve().then(() => s.h.sendPrompt!({ id, text: "hi" } as never))).rejects.toMatchObject({ code: "BAD_ARGS" });
  });

  it("deleting a Bot removes its routines and its group membership (BOT-09, RTN-23, GRP-01)", async () => {
    const s = await boot();
    const [a, b, c] = [await s.make("A"), await s.make("B"), await s.make("C")];
    const { id: g } = await s.h.createGroup!({ memberIds: [a, b, c] });
    await s.h.createAgentAutomation!({ id: c, name: "Ping", prompt: "Ping.", schedule: "every day at 9am" });
    await s.h.deleteAgent!({ id: c });
    expect((await s.h.listAllAutomations!({})).routines).toHaveLength(0);
    expect((await s.h.listAgents!({})).agents.find((x) => x.id === g)!.group!.memberIds.sort()).toEqual([a, b].sort());
  });
});
