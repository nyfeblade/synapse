import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BotSummary, CommandName, GatewayResponse, RoutineView, TranscriptEntry, Tray } from "@synapse/shared";

const live = !process.env.RUN_CLAUDE || !process.env.RUN_BOX;

function gateway() {
  const route = Object.fromEntries(fs.readFileSync(path.resolve(__dirname, "../../box/route.env"), "utf8").trim().split("\n").map((l) => l.split("=", 2)));
  const info = JSON.parse(execFileSync("orb", ["-m", "box", "-u", "root", "cat", "/home/box/.host/gateway.json"], { encoding: "utf8" }));
  const base = `http://${route.GATEWAY_HOST}:${info.port}`;
  const api = async <T>(cmd: CommandName, args: unknown): Promise<T> => {
    const j = (await (await fetch(`${base}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${info.token}` }, body: JSON.stringify(args) })).json()) as GatewayResponse<unknown>;
    if (!j.ok) throw new Error(j.error.message);
    return j.result as T;
  };
  return { api, webhookBase: `http://${route.GATEWAY_HOST}:47801` };
}
/** Security fix I1: a Bot creating a Bot with standing instructions (and routine writes) raise a card; the user approves once. */
async function approvePending(api: ReturnType<typeof gateway>["api"]): Promise<void> {
  for (const a of (await api<{ agents: BotSummary[] }>("listAgents", {})).agents) {
    for (const e of (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id: a.id, limit: 200 })).entries) {
      if (e.kind === "send-message" && e.message.type === "auto-review-approval" && e.message.approval.status === "pending") {
        await api("resolveAutoReviewApproval", { id: a.id, approvalId: e.message.approval.approvalId, choice: "once" }).catch(() => {});
      }
    }
  }
}
const until = async (f: () => Promise<boolean>, ms: number) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 2000)); } };

describe.skipIf(live)("Phase 4 journeys against the box (real Claude)", () => {
  const tail = async (api: ReturnType<typeof gateway>["api"], id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id, limit: 200 })).entries;

  it("control plane from chat (ORIG-17 §17.3): Bots spawn Bots, create a group, add a routine, archive — no process until a wake", async () => {
    const { api } = gateway();
    const { id } = await api<{ id: string }>("createAgent", { name: "Chief" });
    await api("sendPrompt", { id, clientNonce: `n-${Date.now()}`, text: "Create a Bot called Scout that researches competitors, give it a blue circle avatar and Haiku, create a Bot called Ledger for money questions, make a group with Scout and Ledger called Pricing, add a weekday 9 AM routine to Scout that says 'post one competitor headline', then archive Ledger." });
    // Chief's own bot-created event is one of its events, so wait for the group itself (and the archive), not a count.
    await until(async () => {
      await approvePending(api);
      const agents = (await api<{ agents: BotSummary[] }>("listAgents", {})).agents;
      return agents.some((a) => a.profile.name === "Pricing" && a.group) && agents.some((a) => a.profile.name === "Ledger" && a.archived);
    }, 480_000);
    const agents = (await api<{ agents: BotSummary[] }>("listAgents", {})).agents;
    const scout = agents.find((a) => a.profile.name === "Scout")!;
    const ledger = agents.find((a) => a.profile.name === "Ledger")!;
    const pricing = agents.find((a) => a.profile.name === "Pricing")!;
    expect(scout.profile).toMatchObject({ avatarShape: "pebble", avatarColor: "#3472d9", model: "claude-haiku-4-5-20251001" });
    expect(pricing.group?.memberIds.sort()).toEqual([scout.id, ledger.id].sort());
    expect(ledger.archived).toBe(true);
    // ORIG-17 §17.2: Scout's routine belongs to Scout, created by Scout itself or through Chief asking it
    await until(async () => { await approvePending(api); return (await api<{ routines: RoutineView[] }>("getAgentAutomations", { id: scout.id })).routines.length === 1; }, 480_000);
    const [routine] = (await api<{ routines: RoutineView[] }>("getAgentAutomations", { id: scout.id })).routines;
    expect(routine!.description).toMatch(/Weekdays at 9:00 AM/);
    for (const b of [id, scout.id, ledger.id, pricing.id]) await api("deleteAgent", { id: b });
  }, 900_000);

  it("bot-to-bot without a human in the loop: a thank-you loop costs one wake and raises nothing", async () => {
    const { api } = gateway();
    // Answerer first and no kickstarts: a kickstart spawns Asker at once, and a Bot mid-turn keeps the roster it spawned with.
    const b = (await api<{ id: string }>("createAgent", { name: "Answerer", description: "Answer requests from other Bots with one result. Always thank Bots that thank you.", isKickstartRequested: false })).id;
    const a = (await api<{ id: string }>("createAgent", { name: "Asker", description: "When the user asks, request data from Answerer with SendToAgent and thank it warmly when it replies.", isKickstartRequested: false })).id;
    const traysBefore = (await api<{ trays: Tray[] }>("getTrays", {})).trays.length;
    await api("sendPrompt", { id: a, clientNonce: `n-${Date.now()}`, text: "Ask Answerer what 17 × 23 is, then tell me." });
    await until(async () => (await tail(api, a)).some((e) => e.kind === "send-message" && e.message.type === "text" && /391/.test(e.message.content)), 480_000);
    await new Promise((r) => setTimeout(r, 60_000)); // let any thank-you ping-pong play out
    const inbound = (await tail(api, b)).filter((e) => e.kind === "message" && "fromAgent" in e);
    expect(inbound.length).toBe(1); // only the request reached Answerer; the thanks were dropped by the gate
    expect((await api<{ trays: Tray[] }>("getTrays", {})).trays.length).toBe(traysBefore);
    expect((await api<{ efficiency: { dropped: number } }>("getUsage", {})).efficiency.dropped).toBeGreaterThanOrEqual(1); // the thank-you
    for (const id of [a, b]) await api("deleteAgent", { id });
  }, 900_000);

  it("webhook trigger: auth matrix and a real run (RTN-11, ORIG-04 §04.2)", async () => {
    const { api, webhookBase } = gateway();
    const { id } = await api<{ id: string }>("createAgent", { name: "Hooky" });
    const { routine, key } = await api<{ routine: RoutineView; key: string }>("createAgentAutomation", { id, name: "Deploy hook", prompt: "Summarize the deploy event in one SendMessage.", trigger: { webhook: {} } });
    const url = `${webhookBase}/hooks/${new URL(routine.webhook!.url).pathname.split("/").pop()}`;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "deploy-1" }, body: JSON.stringify({ service: "api", version: "1.4.2" }) });
    expect(ok.status).toBe(200);
    const dup = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "deploy-1" }, body: "{}" });
    expect(await dup.json()).toMatchObject({ accepted: true, duplicate: true });
    await until(async () => (await api<{ routines: RoutineView[] }>("getAgentAutomations", { id })).routines[0]!.runs.some((r) => r.status === "ok"), 300_000);
    await api("deleteAgent", { id });
  }, 600_000);
});
