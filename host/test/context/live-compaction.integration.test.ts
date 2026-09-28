import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ORIG-07 §07.8 live checks (Task 38). Real Claude through the box gateway; spends quota; run by hand.
// Runs either inside the box (reads /home/box/.host/gateway.json directly) or from the Mac, where the
// gateway info, the pad files and the proof file go through `orb -m box` (no shared folders).
const live = process.env.RUN_CLAUDE === "1" && process.env.RUN_BOX === "1";
const inBox = fs.existsSync("/home/box/.host");
const orb = (user: string, args: string[], input?: string) => execFileSync("orb", ["-m", "box", "-u", user, ...args], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
const gateway = (): { base: string; token: string } => {
  if (!live) return { base: "", token: "" };
  if (inBox) {
    const g = JSON.parse(fs.readFileSync("/home/box/.host/gateway.json", "utf8")) as { token: string; port?: number };
    return { base: process.env.GATEWAY_URL ?? `http://127.0.0.1:${g.port ?? 47800}`, token: g.token };
  }
  const route = Object.fromEntries(fs.readFileSync(path.resolve(__dirname, "../../../box/route.env"), "utf8").trim().split("\n").map((l) => l.split("=", 2)));
  const g = JSON.parse(orb("root", ["cat", "/home/box/.host/gateway.json"])) as { token: string; port: number };
  return { base: process.env.GATEWAY_URL ?? `http://${route.GATEWAY_HOST}:${g.port}`, token: g.token };
};
const { base, token } = gateway();
const writeBoxFile = (p: string, content: string) => {
  if (inBox) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return; }
  orb("box", ["sh", "-c", `mkdir -p "${path.dirname(p)}" && cat > "${p}"`], content);
};
const readBoxFile = (p: string): string => (inBox ? fs.readFileSync(p, "utf8") : orb("root", ["cat", p]));

const api = async <T>(cmd: string, args: unknown): Promise<T> => {
  const r = await fetch(`${base}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
  const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
  if (!j.ok) throw new Error(`${j.error!.code}: ${j.error!.message}`);
  return j.result as T;
};
const idle = async (id: string, ms = 600_000) => { const t = Date.now() + ms; for (;;) { const a = await api<{ agents: { id: string; running: boolean }[] }>("listAgents", {}); if (!a.agents.find((x) => x.id === id)?.running) return; if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 3000)); } };
const say = async (id: string, text: string) => { await api("sendPrompt", { id, text, clientNonce: crypto.randomUUID() }); await new Promise((r) => setTimeout(r, 1500)); await idle(id); };

const SEEDS = [
  ["Open task: draft the Q3 board memo for Dana Ruiz, due 2026-10-02.", "When is the Q3 board memo due and for whom?", ["10-02", "dana"]],
  ["The garden-app repo is at /workspace/repos/garden-app on branch trunk.", "Where is the garden-app repo and which branch?", ["/workspace/repos/garden-app", "trunk"]],
  ["I promised Sam I'd review PR #41 by Friday 2026-09-25.", "What did I promise Sam and by when?", ["41", "09-25"]],
  ["The lease renewal email thread subject is 'Unit 4B lease 2027'.", "What's the lease thread subject?", ["unit 4b"]],
  ["Budget cap for the offsite is $4,800.", "What's the offsite budget cap?", ["4,800"]],
  ["We decided on Lisbon for the offsite because flights were cheapest.", "Where is the offsite and why?", ["lisbon", "cheap"]],
  ["The flaky test is soil.test.ts; retrying didn't help, the fix is rounding.", "Which test was flaky and what fixed it?", ["soil.test.ts", "round"]],
  ["Waiting on the landlord Mark Ellis to confirm the move-in date.", "Who am I waiting on and for what?", ["mark ellis", "move-in"]],
  ["The dashboard URL is https://metrics.example.com/q3.", "What's the dashboard URL?", ["metrics.example.com/q3"]],
  ["Next step on the newsletter: pick three stories by Thursday.", "What's the next step on the newsletter?", ["three stories", "thursday"]],
] as const;

// The Read tool truncates lines over 2,000 chars and refuses files over ~25k tokens, so the pad is
// many short lines (~22k tokens per chunk) instead of one 243k-char line (which read as ~500 tokens).
// The Bot is asked for the LAST line: asked for the first line, it learned to Read with limit: 1.
const padChunk = (i: number) => `Chunk ${i}\n` + Array.from({ length: 1400 }, (_, n) => `${i}.${n} lorem ipsum dolor sit amet consectetur adipiscing`).join("\n") + "\n";

describe.skipIf(!live)("ORIG-07 §07.8 live checks", () => {
  it("compacts at ~150k tokens and still answers ≥9/10 seeded questions", async () => {
    const { id } = await api<{ id: string }>("createAgent", { name: "Compaction Probe", isKickstartRequested: false });
    try {
      for (const [fact] of SEEDS) await say(id, `${fact} Just acknowledge.`);
      for (let i = 0; i < 16; i++) writeBoxFile(`/workspace/pad/chunk${i}.txt`, padChunk(i));
      for (let i = 0; i < 16; i++) {
        await say(id, `Read /workspace/pad/chunk${i}.txt in full with the Read tool (the whole file: no offset or limit, no Grep or Bash) and reply with its last line only.`);
        const c = await api<{ ratio: number }>("getAgentContext", { id });
        console.log(`after chunk ${i}: ratio ${c.ratio}`);
        if (c.ratio >= 0.72) break;
      }
      const t0 = Date.now();
      for (;;) { const c = await api<{ compactions: number }>("getAgentContext", { id }); if (c.compactions >= 1) break; if (Date.now() - t0 > 600_000) throw new Error("no idle compaction"); await new Promise((r) => setTimeout(r, 5000)); }
      await idle(id);
      let right = 0;
      for (const [, q, keys] of SEEDS) {
        await say(id, q);
        const tail = (await api<{ entries: { kind: string; message?: { type: string; content?: string } }[] }>("getAgentTranscriptTail", { id, limit: 5 })).entries;
        const ans = (tail.filter((e) => e.kind === "send-message" && e.message?.type === "text").at(-1)?.message?.content ?? "").toLowerCase();
        const ok = keys.every((k) => ans.includes(k));
        if (ok) right++;
        console.log(`${ok ? "OK  " : "MISS"} ${q} -> ${ans.slice(0, 200).replace(/\n/g, " ")}`);
      }
      console.log(`seeded answers: ${right}/10`);
      expect(right).toBeGreaterThanOrEqual(9);
    } finally {
      if (!process.env.KEEP_PROBES) await api("deleteAgent", { id });
    }
  }, 3_600_000);

  it("a corrupted session file rolls over and the Bot continues the seeded task", async () => {
    const { id } = await api<{ id: string }>("createAgent", { name: "Rollover Probe", isKickstartRequested: false });
    try {
      await say(id, "Open task: write /workspace/rollover-proof.txt containing the word HERON. Don't do it yet; just acknowledge.");
      await api("compactAgentNow", { id });
      await new Promise((r) => setTimeout(r, 60_000));
      const before = await api<{ sessionBytes: number | null }>("getAgentContext", { id });
      expect(before.sessionBytes).not.toBeNull();
      console.log(`Corrupt the newest session file now (bot ${id}); waiting 30 s`);
      await new Promise((r) => setTimeout(r, 30_000));
      await say(id, "Please do the open task now.");
      await idle(id);
      expect(readBoxFile("/workspace/rollover-proof.txt")).toContain("HERON");
    } finally {
      if (!process.env.KEEP_PROBES) await api("deleteAgent", { id });
    }
  }, 1_800_000);
});
