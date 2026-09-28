import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import type { McpServerView, TranscriptEntry, UsageView } from "@synapse/shared";

const env = Object.fromEntries(fs.readFileSync(path.resolve(__dirname, "../../box/route.env"), "utf8").split("\n").filter(Boolean).map((l) => l.split("=", 2) as [string, string]));
const base = `http://${env.GATEWAY_HOST ?? "127.0.0.1"}:${env.GATEWAY_PORT ?? "47800"}`;
const token = process.env.GATEWAY_TOKEN ?? "";
const api = async <T>(cmd: string, args: unknown = {}): Promise<T> => {
  const r = await fetch(`${base}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
  if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
  return j.result as T;
};
const until = async (f: () => Promise<boolean>, ms: number) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 1000)); } };

describe.skipIf(process.env.RUN_CLAUDE !== "1" || process.env.RUN_BOX !== "1")("Phase 5 acceptance (real Claude in the box)", () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const id of made) await api("deleteAgent", { id }).catch(() => {});
    await api("uninstallPlugin", { id: "curated:deepwiki" }).catch(() => {});
    execFileSync("orb", ["-m", "box", "-u", "root", "rm", "-rf", "/workspace/repos/p5demo", "/workspace/repos/p5demo.worktrees"]);
  });
  it("a no-auth curated connector works end to end, and the turn moves the usage bar", async () => {
    await api("installPlugin", { id: "curated:deepwiki" });
    await until(async () => (await api<{ servers: McpServerView[] }>("listMcpServers")).servers.some((s) => s.id === "deepwiki" && s.status === "connected"), 60_000);
    const { id } = await api<{ id: string }>("createAgent", { name: "Scout P5", isKickstartRequested: false });
    made.push(id);
    await api("sendPrompt", { id, text: "Use DeepWiki to tell me in two sentences what the repository anthropics/claude-agent-sdk-typescript is for.", clientNonce: `p5-${Date.now()}` });
    await until(async () => {
      const e = (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
      return e.some((x) => x.kind === "tool-call" && x.name.startsWith("mcp__deepwiki__")) && e.some((x) => x.kind === "send-message" && x.message.type === "text" && x.message.content.length > 40);
    }, 300_000);
    // the usage row is written when the turn's result lands, which can be just after the reply
    await until(async () => (await api<UsageView>("getUsage")).rows.some((r) => r.botId === id && r.tokens > 0), 60_000);
    const u = await api<UsageView>("getUsage");
    expect(u).not.toHaveProperty("weeklyPct"); // synapse-public: no Claude plan window
  }, 400_000);

  it("helper calls: avatar SVG, template draft, and the coding agent on a local repo", async () => {
    const { id } = await api<{ id: string }>("createAgent", { name: "Fixer P5", isKickstartRequested: false });
    made.push(id);
    expect((await api<{ svg: string }>("generateAgentAvatar", { id, prompt: "a calm green droplet" })).svg).toMatch(/^<svg[^>]*viewBox/);
    const { draft } = await api<{ draft: { profile: { name: string } } }>("draftTemplate", { id });
    expect(draft.profile.name).toBe("Fixer P5");
    await api("sendPrompt", { id, text: "Create a git repo at /workspace/repos/p5demo with a README containing 'hello', commit it, then launch a coding agent on repo 'p5demo' to add a second line 'from the coding agent' to the README and commit.", clientNonce: `p5c-${Date.now()}` });
    await until(async () => {
      // Auto-review may card a Bash step (the user approves once), as in the Phase 1 journey
      for (const e of (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id, limit: 200 })).entries) {
        if (e.kind === "send-message" && e.message.type === "auto-review-approval" && e.message.approval.status === "pending") await api("resolveAutoReviewApproval", { id, approvalId: e.message.approval.approvalId, choice: "once" }).catch(() => {});
      }
      return (await api<{ agents: { status: string }[] }>("listCodingAgents", { id })).agents.some((a) => a.status === "done");
    }, 900_000);
  }, 1_000_000);
});
