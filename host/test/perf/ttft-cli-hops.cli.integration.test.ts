import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
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
import { AsyncQueue } from "../../util/async-queue";
import { tmpConfig } from "../helpers";
import { startFakeMessagesApi } from "../brain/fake-messages-api";

/**
 * TTFT war room: how much of a turn's time-to-first-token is the CLI itself (no model latency — a scripted
 * fake Messages API answers instantly). Measures, per turn, the host-side hops:
 *   push → first POST /v1/messages at the API (CLI spawn/init/MCP/resume + request build)
 *   push → first SendMessage stream_event (tool_use start) back through the SDK
 * for (a) a COLD turn (fresh process, as warmSessions=false does on every turn) and
 * (b) WARM turns (a second/third message pushed into the same live process).
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/perf/ttft-cli-hops.cli.integration.test.ts
 */
const SEND = "mcp__bot__SendMessage";

function timingProxy(upstream: string): Promise<{ url: string; arrivals: number[]; close(): Promise<void> }> {
  const arrivals: number[] = [];
  const up = new URL(upstream);
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/v1/messages") && !req.url.includes("count_tokens")) arrivals.push(performance.now());
    const p = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 200, r.headers);
      r.pipe(res);
    });
    req.pipe(p);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, arrivals,
    close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()); }),
  })));
}

const user = (text: string): SDKUserMessage => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage);

describe.runIf(process.env.RUN_CLAUDE === "1")("TTFT: CLI hops, cold vs warm", () => {
  it("measures push → API request and push → SendMessage start", async () => {
    const rounds = 4;
    const script = Array.from({ length: rounds * 2 }, (_, i) => (i % 2 === 0 ? [{ tool: SEND, input: { content: `Hi ${i}.`, end_turn: true } }] : [{ text: "Sent." }]));
    const api = await startFakeMessagesApi(script);
    const px = await timingProxy(api.url);
    const cfg = tmpConfig();
    initLayout(cfg);
    const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
    const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
    let slot: TurnSlot = newSlot({ botId: id, requestId: "req_0", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 1, startedAt: Date.now() });
    const tools = createBotTools({
      botId: id, slot: () => slot, bots, acks: new AckLedger(path.join(cfg.hostPrivate, "acks.json")), creations: new CreationLedger(path.join(cfg.hostPrivate, "creations.json")),
      now: () => Date.now(), createBot: () => "x",
    });
    const allow = { preToolUse: async () => ({ decision: "allow" as const }), canUseTool: async (_b: string, c: { input: Record<string, unknown> }) => ({ behavior: "allow" as const, updatedInput: c.input }), expireAll: () => {}, forgetBot: () => {} };
    const wiring = createBotWiring({ botId: id, slot: () => slot, gate: () => allow as never, tools: () => tools, flags: () => DEFAULT_FLAGS, now: () => Date.now() });
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ttft-")));
    const mk = (resume: string | null) => {
      const o = buildBotQueryOptions({
        cfg, flags: { ...DEFAULT_FLAGS, runAs: "same-uid" }, resumeSessionId: resume, newSessionId: null, systemAppend: "You are Piper. ".repeat(400), model: "claude-sonnet-5",
        env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: px.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        mcpServers: { bot: toNamedMcpServer("bot", tools) }, botToolNames: tools.map((t) => t.name),
        hooks: toSdkHooks(wiring), canUseTool: toSdkCanUseTool(wiring), abortController: new AbortController(),
      });
      o.cwd = home;
      o.pathToClaudeCodeExecutable = undefined;
      return o;
    };
    const rows: { mode: string; toApiMs: number; toSendStartMs: number; toResultMs: number }[] = [];
    let sessionId: string | null = null;
    try {
      // (a) cold turns: a fresh process each (what warmSessions=false does), resuming the same session after the first.
      for (let k = 0; k < 2; k++) {
        const input = new AsyncQueue<SDKUserMessage>();
        const q = query({ prompt: input, options: mk(sessionId) });
        const n0 = px.arrivals.length;
        const t0 = performance.now();
        input.push(user(`hello ${k}`));
        let tSend = 0;
        for await (const m of q) {
          const mm = m as { type: string; session_id?: string; event?: { type?: string; content_block?: { type?: string; name?: string } } };
          if (mm.session_id) sessionId = mm.session_id;
          if (!tSend && mm.type === "stream_event" && mm.event?.type === "content_block_start" && mm.event.content_block?.name === SEND) tSend = performance.now();
          if (mm.type === "result") break;
        }
        rows.push({ mode: k === 0 ? "cold (new session)" : "cold (--resume)", toApiMs: px.arrivals[n0]! - t0, toSendStartMs: tSend - t0, toResultMs: performance.now() - t0 });
        input.end();
        q.close();
      }
      // (b) warm turns: one process, messages pushed after each result (warmSessions=true).
      const input = new AsyncQueue<SDKUserMessage>();
      const q = query({ prompt: input, options: mk(sessionId) });
      const it = q[Symbol.asyncIterator]();
      let warmInits = 0;
      for (let k = 0; k < 3; k++) {
        slot = { ...slot, requestId: `req_w${k}` };
        const n0 = px.arrivals.length;
        const t0 = performance.now();
        input.push(user(`warm hello ${k}`));
        let tSend = 0;
        for (;;) {
          const r = await it.next();
          if (r.done) break;
          const mm = r.value as { type: string; subtype?: string; event?: { type?: string; content_block?: { name?: string } } };
          if (mm.type === "system" && mm.subtype === "init") warmInits++;
          if (!tSend && mm.type === "stream_event" && mm.event?.type === "content_block_start" && mm.event.content_block?.name === SEND) tSend = performance.now();
          if (mm.type === "result") break;
        }
        rows.push({ mode: k === 0 ? "first turn of a new process (--resume)" : `warm push #${k}`, toApiMs: px.arrivals[n0]! - t0, toSendStartMs: tSend - t0, toResultMs: performance.now() - t0 });
      }
      // (c) prewarm: the query is opened (process spawned) 3 s before the message is pushed, without iterating
      // it first (the reviewer pool's pattern). Is the CLI's start-up hidden?
      {
        let spawnedAt = 0;
        const pin = new AsyncQueue<SDKUserMessage>();
        const po = mk(null);
        po.spawnClaudeCodeProcess = (so) => { spawnedAt = performance.now(); return spawn(so.command, so.args, { cwd: so.cwd, env: so.env as NodeJS.ProcessEnv, signal: so.signal, stdio: ["pipe", "pipe", "pipe"] }) as never; };
        const opened = performance.now();
        const pq = query({ prompt: pin, options: po });
        await new Promise((r) => setTimeout(r, 3000));
        const n0 = px.arrivals.length;
        const t0 = performance.now();
        pin.push(user("prewarmed hello"));
        for await (const m of pq) if ((m as { type: string }).type === "result") break;
        rows.push({ mode: `prewarmed 3 s (spawned ${spawnedAt ? Math.round(spawnedAt - opened) + " ms after open" : "NOT before push"})`, toApiMs: px.arrivals[n0]! - t0, toSendStartMs: 0, toResultMs: performance.now() - t0 });
        pin.end();
        pq.close();
      }
      rows.push({ mode: `system/init messages seen across 3 warm turns of ONE process: ${warmInits}`, toApiMs: 0, toSendStartMs: 0, toResultMs: 0 });
      input.end();
      q.close();
    } finally {
      await px.close();
      await api.close();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(path.dirname(cfg.dataRoot), { recursive: true, force: true });
    }
    if (process.env.TTFT_OUT) fs.writeFileSync(process.env.TTFT_OUT, JSON.stringify(rows.map((r) => ({ ...r, toApiMs: Math.round(r.toApiMs), toSendStartMs: Math.round(r.toSendStartMs), toResultMs: Math.round(r.toResultMs) })), null, 1));
    expect(rows.length).toBe(7);
  }, 180_000);
});
