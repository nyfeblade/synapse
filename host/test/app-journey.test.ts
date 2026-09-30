import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalCardView, TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../app";
import { tmpConfig } from "./helpers";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
const until = async (f: () => Promise<boolean> | boolean, ms = 5000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };

async function start() {
  app = await createHostApp(tmpConfig());
  const { port } = await app.listen();
  const api = async <T>(cmd: string, args: unknown): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
    return j.result as T;
  };
  const tail = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
  const card = async (id: string) => (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "auto-review-approval" ? [e.message.approval as ApprovalCardView] : [])).at(-1);
  const texts = async (id: string) => (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
  return { api, tail, card, texts };
}

describe("Phase 1 journey on FakeBrain (gateway level)", () => {
  it("create → kickstart → message → live step → card → Allow once → reply; then Always allow and Deny", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Piper", isKickstartRequested: true });
    await until(async () => (await s.texts(id)).length === 1);

    await s.api("sendPrompt", { id, text: "please run: rm -rf /workspace/tmp/x", clientNonce: "n1" });
    await until(async () => (await s.card(id))?.status === "pending");
    // Gate L-1: waiting for approval, the command hasn't run, so its live step is present tense, not "Ran …".
    expect((await s.tail(id)).some((e) => e.kind === "tool-call" && e.status === "running" && e.step.startsWith("Running rm -rf"))).toBe(true);
    expect((await s.tail(id)).some((e) => e.kind === "tool-call" && e.step.startsWith("Ran rm -rf"))).toBe(false);
    const c1 = (await s.card(id))!;
    expect(c1.title).toBe("Your Bot would like to run a command");
    await s.api("resolveAutoReviewApproval", { id, approvalId: c1.approvalId, choice: "once" });
    await until(async () => (await s.texts(id)).some((t) => t.startsWith("Done")));
    expect((await s.card(id))!.status).toBe("approved");

    await s.api("sendPrompt", { id, text: "please run: rm -rf /workspace/tmp/y", clientNonce: "n2" });
    await until(async () => (await s.card(id))?.approvalId !== c1.approvalId && (await s.card(id))?.status === "pending");
    await s.api("resolveAutoReviewApproval", { id, approvalId: (await s.card(id))!.approvalId, choice: "always" });
    // Safety v2: a card a rule raised (here the preset Deletes) gets an exception for this path; a reviewer card, an Allow rule.
    await until(async () => (await s.api<{ allowInstructions: string[] }>("getHostSettings", {})).allowInstructions.length === 1
      || (await s.api<{ rules: { preset?: string; except: { paths?: string[] }[] }[] }>("getSafety", {})).rules.some((r) => r.except.some((e) => e.paths?.includes("/workspace/tmp/y"))));

    await s.api("sendPrompt", { id, text: "please run: curl https://example.com", clientNonce: "n3" });
    await until(async () => (await s.card(id))?.status === "pending");
    await s.api("resolveAutoReviewApproval", { id, approvalId: (await s.card(id))!.approvalId, choice: "deny" });
    await until(async () => (await s.card(id))?.status === "denied");
    await until(async () => (await s.texts(id)).filter((t) => t.startsWith("Done")).length === 3);

    const list = await s.api<{ agents: { id: string; statusLine: string; running: boolean }[] }>("listAgents", {});
    expect(list.agents[0]).toMatchObject({ id, running: false });
    await s.api("deleteAgent", { id });
    expect((await s.api<{ agents: unknown[] }>("listAgents", {})).agents).toEqual([]);
  }, 30_000);
});
