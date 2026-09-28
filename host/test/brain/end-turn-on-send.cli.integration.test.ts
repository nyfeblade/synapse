import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { BotService } from "../../bots/bot-service";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { toNamedMcpServer, toSdkCanUseTool, toSdkHooks } from "../../brain/sdk-wiring";
import { buildBotQueryOptions } from "../../brain/spawn-options";
import { SseHub } from "../../gateway/sse-hub";
import { AckLedger } from "../../runner/ack-ledger";
import { createBotWiring } from "../../runner/bot-wiring";
import { CreationLedger } from "../../runner/creation-ledger";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { createBotTools } from "../../tools/bot-tools";
import { tmpConfig } from "../helpers";
import { startFakeMessagesApi, type FakeMessagesApi, type ScriptedBlock } from "./fake-messages-api";

/**
 * Token diet (1): model calls per message, counted on the wire. The real bundled CLI runs one turn with
 * the Bot's real spawn options, the real SendMessage tool and the host's real hooks; the model is a
 * scripted fake Messages API (fake-messages-api.ts), so each scenario is exact and free.
 *
 * Before: every reply cost one more model call after SendMessage, whose only output was "Sent." (box
 * transcript a6a4b9db…, 2026-09-21: 201,988 then 202,199 cache-read tokens for one "test" message).
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/brain/end-turn-on-send.cli.integration.test.ts
 */
const SEND = "mcp__bot__SendMessage";
let api: FakeMessagesApi | null = null;
afterEach(async () => { await api?.close(); api = null; });

async function turn(script: ScriptedBlock[][]): Promise<{ calls: number; sent: string[]; sawBashResult: boolean; subtype: string | undefined }> {
  api = await startFakeMessagesApi(script);
  const cfg = tmpConfig();
  initLayout(cfg);
  const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const slot: TurnSlot = newSlot({ botId: id, requestId: "req_1", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 1, startedAt: Date.now() });
  const tools = createBotTools({
    botId: id, slot: () => slot, bots, acks: new AckLedger(path.join(cfg.hostPrivate, "acks.json")), creations: new CreationLedger(path.join(cfg.hostPrivate, "creations.json")),
    now: () => Date.now(), createBot: () => "x",
    sendHandlers: { card: async (_a, ctx) => { ctx!.deliver({ type: "text", content: "[card]" }); return { text: "Card sent." }; } },
  }).filter((t) => t.name === "SendMessage");
  const allow = { preToolUse: async () => ({ decision: "allow" as const }), canUseTool: async (_b: string, c: { input: Record<string, unknown> }) => ({ behavior: "allow" as const, updatedInput: c.input }), expireAll: () => {}, forgetBot: () => {} };
  const wiring = createBotWiring({ botId: id, slot: () => slot, gate: () => allow as never, tools: () => tools, flags: () => DEFAULT_FLAGS, now: () => Date.now() });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "endturn-")));
  const o = buildBotQueryOptions({
    cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: null, newSessionId: null, systemAppend: "You are Piper.", model: "claude-haiku-4-5-20251001",
    env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: api.url, ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    mcpServers: { bot: toNamedMcpServer("bot", tools) }, botToolNames: ["SendMessage"],
    hooks: toSdkHooks(wiring), canUseTool: toSdkCanUseTool(wiring), abortController: new AbortController(),
  });
  o.cwd = home;
  o.persistSession = false;
  o.pathToClaudeCodeExecutable = undefined;
  let subtype: string | undefined;
  const q = query({ prompt: "test", options: o });
  try {
    for await (const m of q) if (m.type === "result") { subtype = m.subtype; break; }
  } finally {
    q.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  const sent = bots.tail(id, 50).flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
  const sawBashResult = api.calls.some((c) => JSON.stringify(c.lastUser).includes("bash-ran"));
  return { calls: api.calls.length, sent, sawBashResult, subtype };
}

describe.runIf(process.env.RUN_CLAUDE === "1")("a final SendMessage ends the turn with no further model call", () => {
  it("a simple reply is ONE model call (was two: the second only said \"Sent.\")", async () => {
    const r = await turn([[{ tool: SEND, input: { content: "Got it.", end_turn: true } }], [{ text: "Sent." }]]);
    expect(r.sent).toEqual(["Got it."]);
    expect(r.calls).toBe(1);
    expect(r.subtype).toBe("success");
  }, 60_000);

  it("a multi-message reply still delivers every message, and the last one ends the turn", async () => {
    const r = await turn([
      [{ tool: SEND, input: { content: "Part one." } }],
      [{ tool: SEND, input: { content: "Part two.", end_turn: true } }],
      [{ text: "Sent." }],
    ]);
    expect(r.sent).toEqual(["Part one.", "Part two."]);
    expect(r.calls).toBe(2);
  }, 60_000);

  it("two sends in one model message both land and end the turn", async () => {
    const r = await turn([[{ tool: SEND, input: { content: "A." } }, { tool: SEND, input: { content: "B.", end_turn: true } }], [{ text: "Sent." }]]);
    expect(r.sent).toEqual(["A.", "B."]);
    expect(r.calls).toBe(1);
  }, 60_000);

  it("a message without end_turn keeps the turn going: tool calls after a message still run", async () => {
    const r = await turn([
      [{ tool: SEND, input: { content: "On it." } }],
      [{ tool: "Bash", input: { command: "echo bash-ran", description: "probe" } }],
      [{ tool: SEND, input: { content: "Done.", end_turn: true } }],
      [{ text: "Sent." }],
    ]);
    expect(r.sent).toEqual(["On it.", "Done."]);
    expect(r.sawBashResult).toBe(true);
    expect(r.calls).toBe(3);
  }, 60_000);

  it("end_turn next to another tool in the same message does not cut that tool's result off", async () => {
    const r = await turn([
      [{ tool: SEND, input: { content: "Checking.", end_turn: true } }, { tool: "Bash", input: { command: "echo bash-ran", description: "probe" } }],
      [{ text: "ok" }],
    ]);
    expect(r.sawBashResult).toBe(true);
    // Call 2 answers the Bash result; a tool ran after the last send, so OUT-07's closing nudge (Stop
    // hook) asks for one more call. Both are the discipline working, not the diet failing.
    expect(r.calls).toBe(3);
  }, 60_000);

  it("a card with end_turn ends the turn too", async () => {
    const r = await turn([[{ tool: SEND, input: { type: "card", card: { kind: "link", url: "https://example.com" }, end_turn: true } }], [{ text: "Sent." }]]);
    expect(r.sent).toEqual(["[card]"]);
    expect(r.calls).toBe(1);
  }, 60_000);
});
