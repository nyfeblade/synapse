import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STR, type ApprovalCardView, type TranscriptEntry } from "@synapse/shared";

// Real Claude (Sonnet 5 Bot + Haiku reviewer) through the box gateway. Spends quota; run by hand.
describe.skipIf(!process.env.RUN_CLAUDE || !process.env.RUN_BOX)("Phase 1 journey against the box", () => {
  it("creates Piper, streams steps, raises a card for rm -rf, and replies via SendMessage", async () => {
    const route = Object.fromEntries(fs.readFileSync(path.resolve(__dirname, "../../box/route.env"), "utf8").trim().split("\n").map((l) => l.split("=", 2)));
    const info = JSON.parse(execFileSync("orb", ["-m", "box", "-u", "root", "cat", "/home/box/.host/gateway.json"], { encoding: "utf8" }));
    const base = `http://${route.GATEWAY_HOST}:${info.port}`;
    const api = async <T>(cmd: string, args: unknown): Promise<T> => {
      const j = (await (await fetch(`${base}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${info.token}` }, body: JSON.stringify(args) })).json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
      if (!j.ok) throw new Error(j.error!.message);
      return j.result as T;
    };
    const tail = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
    const until = async (f: () => Promise<boolean>, ms: number) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 1000)); } };
    // Always allow persists a rule on the live box; restore the lists afterwards so a leftover
    // "rm -rf /workspace/piper-demo" rule can't pre-approve the next run's command (no card → timeout).
    // The restore overwrites the whole lists: any rule the user edits on this box during the run is lost.
    const before = await api<{ allowInstructions: string[]; blockInstructions: string[] }>("getHostSettings", {});
    const { id } = await api<{ id: string }>("createAgent", { name: "Piper", isKickstartRequested: true });
    try {
      try {
        await until(async () => (await tail(id)).some((e) => e.kind === "send-message"), 120_000);
        await api("sendPrompt", { id, text: "Create the folder /workspace/piper-demo with a file notes.md saying hello, then delete the whole folder with rm -rf and tell me when done.", clientNonce: `n-${Date.now()}` });
        await until(async () => (await tail(id)).some((e) => e.kind === "tool-call"), 120_000);
        await until(async () => (await tail(id)).some((e) => e.kind === "send-message" && e.message.type === "auto-review-approval"), 240_000);
        const card = (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "auto-review-approval" ? [e.message.approval as ApprovalCardView] : [])).at(-1)!;
        expect(card.title).toBe("Your Bot would like to run a command");
        await api("resolveAutoReviewApproval", { id, approvalId: card.approvalId, choice: "always" });
        await until(async () => (await tail(id)).filter((e) => e.kind === "send-message" && e.message.type === "text").length >= 2, 240_000);
        // The settled card names the rule it added; that exact rule must now be in the allow list (not "count + 1",
        // which breaks at the 20-rule cap or when the rule was already there).
        const settled = (await tail(id)).flatMap((e) => (e.kind === "send-message" && e.message.type === "auto-review-approval" && e.message.approval.approvalId === card.approvalId ? [e.message.approval as ApprovalCardView] : [])).at(-1)!;
        const prefix = STR.ruleAdded("").slice(0, -1);
        expect(settled.ruleAddedText?.startsWith(prefix), String(settled.ruleAddedText)).toBe(true);
        const rule = settled.ruleAddedText!.slice(prefix.length, -1);
        expect((await api<{ allowInstructions: string[] }>("getHostSettings", {})).allowInstructions).toContain(rule);
      } finally {
        await api("setHostSettings", { allowInstructions: before.allowInstructions, blockInstructions: before.blockInstructions });
      }
    } finally {
      await api("deleteAgent", { id }); // runs even if the restore throws
    }
  }, 600_000);
});
