import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { sealTo } from "../secrets/crypto";

/** Task 29: Phase 3 acceptance against the deployed box host (runs on the Mac; RUN_BOX=1 RUN_CLAUDE=1). */
const RUN = process.env.RUN_BOX === "1" && process.env.RUN_CLAUDE === "1";
const orb = (...a: string[]) => execFileSync("orb", ["-m", "box", "-u", "root", ...a]).toString();
const gw = JSON.parse(RUN ? orb("cat", "/home/box/.host/gateway.json") : "{}") as { port: number; token: string };
const base = `http://127.0.0.1:${gw.port}`;
async function api<T = any>(cmd: string, args: unknown = {}): Promise<T> {
  const r = await fetch(`${base}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${gw.token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  const j = (await r.json()) as { ok: boolean; result: T; error?: { message: string } };
  if (!j.ok) throw new Error(j.error?.message);
  return j.result;
}
async function waitFor(botId: string, pred: (e: any) => boolean, ms = 300_000): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const { entries } = await api<{ entries: any[] }>("getAgentTranscriptTail", { id: botId, limit: 200 });
    const hit = entries.find(pred);
    if (hit) return hit;
    if (Date.now() > end) {
      const said = entries.filter((e) => e.kind === "send-message").slice(-3).map((e) => JSON.stringify(e.message).slice(0, 400));
      throw new Error(`timed out waiting for the transcript; last messages: ${said.join(" | ")}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const said = (re: RegExp) => (e: any) => e.kind === "send-message" && e.message.type === "text" && re.test(e.message.content);
let n = 0;
const send = (id: string, text: string) => api("sendPrompt", { id, text, clientNonce: `p3-${Date.now()}-${++n}` });

describe.runIf(RUN)("Phase 3 acceptance (box, real brain)", () => {
  let bot = "";
  afterAll(async () => { if (bot) await api("deleteAgent", { id: bot }).catch(() => {}); });

  it("a browserUse subagent reads a real page and the parent reports it", async () => {
    bot = (await api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false })).id;
    await send(bot, "Use a browserUse subagent to open https://example.com and tell me the exact page heading.");
    await waitFor(bot, said(/Example Domain/i));
    const { tasks } = await api<{ tasks: any[] }>("getAsyncTasks", { id: bot });
    expect(tasks.some((t) => t.kind === "subagent" && t.type === "browserUse" && t.status === "done")).toBe(true);
  }, 600_000);

  it("the gateway VNC route returns the RFB banner for the Bot's screen", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/vnc/${bot}`, { headers: { authorization: `Bearer ${gw.token}` } });
    const banner = await new Promise<string>((res, rej) => { ws.once("message", (d) => res(d.toString())); ws.once("error", rej); });
    expect(banner).toMatch(/^RFB 003\.00[38]\n$/);
    ws.close();
  }, 60_000);

  it("request_box_help → hand back → the Bot resumes with a Screenshot", async () => {
    await send(bot, "Call request_box_help asking me to sign in to example.com (reason auth), then stop.");
    const card = await waitFor(bot, (e) => e.kind === "send-message" && e.message.type === "box-help" && e.message.request.status === "pending");
    expect(card.message.request.screenshotDataUrl).toMatch(/^data:image\/webp;base64,/);
    await api("setTakeoverActive", { id: bot, requestId: card.message.request.id, active: true });
    await api("handBackForeverBox", { id: bot, requestId: card.message.request.id, outcome: "done" });
    await waitFor(bot, (e) => e.kind === "tool-call" && e.name === "mcp__bot__Screenshot" && e.startedAt > card.createdAt);
  }, 600_000);

  it("ORIG-12 §12.6: secrets are usable but never visible", async () => {
    bot ||= (await api<{ id: string }>("createAgent", { name: "Scout", isKickstartRequested: false })).id;
    const value = `p3-secret-${Math.random().toString(36).slice(2, 10)}`;
    const { boxPublicKey } = await api<{ boxPublicKey: string }>("getBotSecretsStatus", { botId: bot });
    await api("setBotSecrets", { botId: bot, upserts: [{ name: "P3_SECRET", description: "acceptance probe", sealed: await sealTo(boxPublicKey, value), valueHash: "h" }], removes: [] });
    // The model won't print a variable it knows is a secret, so the value (raw, base64, hex, URL, JSON) sits in a file
    // it doesn't know about; what is under test is the app's redaction of the tool output, the reply, the stores and logs.
    const b64v = Buffer.from(value).toString("base64");
    execFileSync("orb", ["-m", "box", "-u", "root", "sh", "-c", "cat > /workspace/p3-notes.txt && chown box:bots /workspace/p3-notes.txt"], {
      input: `release notes\nbuild ref ${value}\nb64 ${b64v}\nhex ${Buffer.from(value).toString("hex")}\nurl ${encodeURIComponent(value)}\njson ${JSON.stringify(value)}\n`,
    });
    const t0 = Date.now();
    await send(bot, "Use the Shell tool to run `cat /workspace/p3-notes.txt` and send me the whole output exactly as you see it, in a code block.");
    const reply = await waitFor(bot, (e) => said(/secret:P3_SECRET/)(e) && e.createdAt > t0);
    const b64 = Buffer.from(value).toString("base64");
    const hex = Buffer.from(value).toString("hex");
    for (const v of [value, b64, hex]) expect(JSON.stringify(reply)).not.toContain(v);
    // §12.6 bullet 1: after the tool outputs, the value is in no session JSONL, store or log. (Checked before the
    // next step on purpose: that step has the user type the value, which the user's own message then carries.)
    const hits = execFileSync("orb", ["-m", "box", "-u", "root", "sh", "-c", `grep -rlF -e '${value}' -e '${b64}' -e '${hex}' /home/box/.claude/projects /home/box/agent-data /home/box/.host/reviewer.log.jsonl 2>/dev/null || true`]).toString().trim();
    expect(hits).toBe("");
    const t1 = Date.now();
    await send(bot, `Send me exactly this text with SendMessage: ${value}`);
    // SendMessage is hidden activity, so the denial shows as the Bot's next reply, which never carries the value.
    await waitFor(bot, (e) => e.kind === "send-message" && e.message.type === "text" && e.createdAt > t1);
    const after = (await api<{ entries: any[] }>("getAgentTranscriptTail", { id: bot, limit: 200 })).entries.filter((e) => e.kind === "send-message" && e.createdAt > t1);
    for (const v of [value, b64, hex]) expect(JSON.stringify(after)).not.toContain(v);
    orb("rm", "-f", "/workspace/p3-notes.txt");
  }, 900_000);

  it("a background Shell revives the Bot when it finishes (TOOL-11/12)", async () => {
    const t0 = Date.now();
    await send(bot, "Use the Shell tool with block_until_ms 0 to run `sleep 25; echo p3-bg-done`, tell me you started it, and end your turn.");
    // The revival: once the background shell is done, the Bot speaks again without a user message.
    const end = Date.now() + 300_000;
    let task: any;
    for (;;) {
      const { tasks } = await api<{ tasks: any[] }>("getAsyncTasks", { id: bot });
      task = tasks.find((t) => t.kind === "shell" && t.startedAt >= t0 && t.status === "done");
      if (task || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(task).toBeTruthy();
    await waitFor(bot, (e) => e.kind === "send-message" && e.createdAt > task.endedAt && e.message.type === "text", 300_000);
  }, 400_000);

  it("snapshots stream (CMP-12)", async () => {
    const { snapshot } = await api<{ snapshot: any }>("snapshotBoxStoreNow", { reason: "manual" });
    expect(snapshot.bytes).toBeGreaterThan(0);
    const r = await fetch(`${base}/snapshots/${snapshot.id}?offset=0&length=1024`, { headers: { authorization: `Bearer ${gw.token}` } });
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBe(1024);
  }, 900_000);
});
