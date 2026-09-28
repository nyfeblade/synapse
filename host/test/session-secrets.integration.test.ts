import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@synapse/shared";
import { sealTo } from "../secrets/crypto";

/**
 * Security review V9 (06:45): the CLI writes each tool call's raw `toolUseResult` into the session JSONL, and
 * withSecrets only replaces what the MODEL sees. This checks, on the real box with real Claude, whether the
 * parent's and a child subagent's session JSONLs keep a secret's value (raw, base64 or hex) after a
 * secret-bearing tool call. Written for T29; spends quota, so it needs RUN_BOX=1 and RUN_CLAUDE=1. Not run here.
 */
describe.runIf(process.env.RUN_BOX === "1" && process.env.RUN_CLAUDE === "1")("V9: session JSONLs never keep a secret's value (box)", () => {
  it("parent and child session files hold no raw/base64/hex secret after Shell, Bash and a Task print it", async () => {
    const route = Object.fromEntries(fs.readFileSync(path.resolve(__dirname, "../../box/route.env"), "utf8").trim().split("\n").map((l) => l.split("=", 2)));
    const info = JSON.parse(execFileSync("orb", ["-m", "box", "-u", "root", "cat", "/home/box/.host/gateway.json"], { encoding: "utf8" })) as { port: number; token: string };
    const base = `http://${route.GATEWAY_HOST}:${info.port}`;
    const api = async <T>(cmd: string, args: unknown): Promise<T> => {
      const j = (await (await fetch(`${base}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${info.token}` }, body: JSON.stringify(args) })).json()) as { ok: boolean; result?: unknown; error?: { message: string } };
      if (!j.ok) throw new Error(j.error!.message);
      return j.result as T;
    };
    const tail = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id, limit: 500 })).entries;
    const until = async (f: () => Promise<boolean>, ms: number) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 2000)); } };

    let lastSeen = "";
    const value = `v9_${randomBytes(12).toString("hex")}`;
    const forms = [value, Buffer.from(value).toString("base64").replace(/=+$/, ""), Buffer.from(value).toString("hex")];
    const { id } = await api<{ id: string }>("createAgent", { name: "V9 probe", isKickstartRequested: false });
    try {
      const { boxPublicKey } = await api<{ boxPublicKey: string }>("getBotSecretsStatus", { botId: id });
      await api("setBotSecrets", { botId: id, upserts: [{ name: "V9_SECRET", description: "test value for the V9 check", sealed: await sealTo(boxPublicKey, value), valueHash: "v9" }], removes: [] });
      // T29: the model won't print a variable it knows is a secret, so the value sits in a file it doesn't know about
      // (raw, base64 and hex); what is under test is what the CLI stores for Shell, Bash, Read and a child's Bash.
      const notes = `release notes\nbuild ref ${forms[0]}\nb64 ${Buffer.from(value).toString("base64")}\nhex ${forms[2]}\n`;
      execFileSync("orb", ["-m", "box", "-u", "root", "sh", "-c", "cat > /workspace/v9-notes.txt && chown box:bots /workspace/v9-notes.txt"], { input: notes });
      await api("sendPrompt", {
        id, clientNonce: `v9-${Date.now()}`,
        text: "Quick tool check. 1) Use the Shell tool to run `cat /workspace/v9-notes.txt`. 2) Use Bash to run `cat /workspace/v9-notes.txt`. 3) Use the Read tool on /workspace/v9-notes.txt. 4) Start a generalPurpose Task subagent whose prompt is: \"Run `cat /workspace/v9-notes.txt` with Bash and report only the word done.\" Wait for its result. Then tell me \"finished\" without repeating any output.",
      });
      await until(async () => {
        const last = (await tail(id)).slice(-6).map((e) => (e.kind === "tool-call" ? `tool ${e.name} ${e.status}` : e.kind === "send-message" ? `msg ${JSON.stringify(e.message).slice(0, 300)}` : e.kind));
        lastSeen = last.join(" | ");
        const entries = await tail(id);
        const card = entries.filter((e) => e.kind === "send-message" && e.message.type === "auto-review-approval" && e.message.approval.status === "pending").at(-1);
        if (card && card.kind === "send-message" && card.message.type === "auto-review-approval") await api("resolveAutoReviewApproval", { id, approvalId: card.message.approval.approvalId, choice: "once" });
        return entries.some((e) => e.kind === "send-message" && e.message.type === "text" && /finished/i.test(e.message.content));
      }, 600_000).catch((e: Error) => { throw new Error(`${e.message}; last entries: ${lastSeen}`); });
      // Every session file in the box project folder: the parent's and the child's (and any others) — search them all.
      const grep = (needle: string): string => {
        try {
          return execFileSync("orb", ["-m", "box", "-u", "root", "grep", "-rhF", "--include=*.jsonl", "--", needle, "/home/box/.claude/projects"], { encoding: "utf8", maxBuffer: 64 << 20 });
        } catch (e) {
          if ((e as { status?: number }).status === 1) return ""; // grep: no match
          throw e;
        }
      };
      const leaks = forms.flatMap((f) => grep(f).split("\n").filter(Boolean).map((line) => {
        let kind = "unparsed";
        try {
          const r = JSON.parse(line) as { type?: string; toolUseResult?: unknown };
          kind = r.toolUseResult !== undefined && JSON.stringify(r.toolUseResult).includes(f) ? "toolUseResult" : `record:${r.type ?? "?"}`;
        } catch { /* keep "unparsed" */ }
        return `${f === value ? "raw" : f.length === value.length * 2 ? "hex" : "base64"} in ${kind}`;
      }));
      expect(leaks, `secret forms found in session JSONLs: ${[...new Set(leaks)].join(", ")}`).toEqual([]);
    } finally {
      execFileSync("orb", ["-m", "box", "-u", "root", "rm", "-f", "/workspace/v9-notes.txt"]);
      await api("deleteAgent", { id });
    }
  }, 900_000);
});
