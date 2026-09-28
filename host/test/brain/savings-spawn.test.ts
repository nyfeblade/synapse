import { afterEach, describe, expect, it } from "vitest";
import { LONG_CONTEXT_ESCALATE_TOKENS } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { FakeBrain } from "../../brain/fake-brain";
import type { SpawnConfig } from "../../brain/types";
import { patchCtx } from "../../context/context-meter";
import { tmpConfig } from "../helpers";

/**
 * saving-settings: the account's Savings choices reach what a Bot's CLI is spawned with. Each is read when the next
 * turn's spawn config is built, so a turn already running keeps what it started with; a warm process whose spawn key
 * moved respawns on its next turn (ClaudeBrain.runTurn), and a model-only change goes through setModel.
 */
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function start() {
  const spawn = new Map<string, () => SpawnConfig>();
  app = await createHostApp(tmpConfig({ FUZZ: "1" }), {
    brainFactory: (botId, d) => { spawn.set(botId, d.spawnConfig); return new FakeBrain(botId, d.wiring, () => [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }]); },
  });
  const { id } = await app.handlers.createAgent!({ name: "Piper", isKickstartRequested: false } as never);
  await app.handlers.sendPrompt!({ id, text: "hi", clientNonce: "n1" });
  for (let i = 0; i < 200 && !spawn.has(id); i++) await new Promise((r) => setTimeout(r, 10));
  return { a: app, id, sc: () => spawn.get(id)!() };
}

describe("Keep conversations ready", () => {
  it("1 hour by default; 5 minutes reaches the env and moves the spawn key (a warm Bot respawns on its next turn)", async () => {
    const { a, sc } = await start();
    const before = sc();
    expect(before.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    await a.handlers.setHostSettings!({ promptCacheTtl: "5m" });
    const after = sc();
    expect(after.env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
    expect(after.spawnKey).not.toBe(before.spawnKey);
  });
});

describe("Long-context model", () => {
  it("On (default) spawns [1m], as before", async () => {
    const { sc } = await start();
    expect(sc().model).toBe("claude-sonnet-5[1m]");
  });

  it("Only when needed: standard context, [1m] once the chat's context passes the line, and it stays for that chat", async () => {
    const { a, id, sc } = await start();
    await a.handlers.setHostSettings!({ longContext: "when-needed" });
    a.services.bots.setSessionId(id, "chat-1");
    expect(sc().model).toBe("claude-sonnet-5");
    patchCtx(a.services.bots, id, { ctxTokens: LONG_CONTEXT_ESCALATE_TOKENS + 1 });
    expect(sc().model).toBe("claude-sonnet-5[1m]");
    patchCtx(a.services.bots, id, { ctxTokens: 20_000 }); // compacted: same chat, stays escalated (one switch per chat)
    expect(sc().model).toBe("claude-sonnet-5[1m]");
    const key = sc().spawnKey;
    a.services.bots.setSessionId(id, "chat-2"); // a new chat starts on standard context again
    expect(sc().model).toBe("claude-sonnet-5");
    expect(sc().spawnKey, "the model is not in the key: a warm process switches with setModel, no respawn").toBe(key);
  });

  it("the auto-compact window stays the [1m] one, so compaction happens where it did before", async () => {
    const { a, sc } = await start();
    const on = sc().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    await a.handlers.setHostSettings!({ longContext: "when-needed" });
    expect(sc().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(on);
  });

  it("the escalation survives a host restart", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    const spawn = new Map<string, () => SpawnConfig>();
    // The session resumes across the restart, as the real CLI's does.
    const opts = { brainFactory: (botId: string, d: { wiring: never; spawnConfig: () => SpawnConfig; getSessionId(): string | null }) => { spawn.set(botId, d.spawnConfig); return new FakeBrain(botId, d.wiring, () => [{ tool: "mcp__bot__SendMessage", input: { content: "ok" } }], { sessionId: d.getSessionId() }); } };
    app = await createHostApp(cfg, opts as never);
    const { id } = await app.handlers.createAgent!({ name: "Piper", isKickstartRequested: false } as never);
    await app.handlers.setHostSettings!({ longContext: "when-needed" });
    app.services.bots.setSessionId(id, "chat-1");
    await app.handlers.sendPrompt!({ id, text: "hi", clientNonce: "n1" });
    for (let i = 0; i < 200 && !spawn.has(id); i++) await new Promise((r) => setTimeout(r, 10));
    patchCtx(app.services.bots, id, { ctxTokens: LONG_CONTEXT_ESCALATE_TOKENS + 5 });
    expect(spawn.get(id)!().model).toBe("claude-sonnet-5[1m]");
    patchCtx(app.services.bots, id, { ctxTokens: 10 });
    await app.close();
    spawn.clear();
    app = await createHostApp(cfg, opts as never);
    await app.handlers.sendPrompt!({ id, text: "again", clientNonce: "n2" });
    for (let i = 0; i < 200 && !spawn.has(id); i++) await new Promise((r) => setTimeout(r, 10));
    expect(spawn.get(id)!().model).toBe("claude-sonnet-5[1m]");
  });
});
