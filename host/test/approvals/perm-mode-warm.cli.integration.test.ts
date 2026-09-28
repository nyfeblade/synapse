import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { ClaudeBrain } from "../../brain/claude-brain";
import type { BrainWiring } from "../../brain/types";
import { sealTo } from "../../secrets/crypto";
import { tmpConfig } from "../helpers";
import { startFakeMessagesApi, type FakeMessagesApi } from "../brain/fake-messages-api";

/**
 * TTFT war room review, fix round 1: with warm sessions on, a Bot's CLI outlives the turn it was spawned for. The
 * permission mode must still be read per call, not per spawn: tightening it (Full auto → Ask) while the Bot is warm
 * gates the very next tool call on the SAME process. Real host app (gate, runner, supervisor) + the real bundled CLI,
 * against a scripted fake Messages API.
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/approvals/perm-mode-warm.cli.integration.test.ts
 */
const SEND = "mcp__bot__SendMessage";
const SHELL = "mcp__bot__Shell";
// Full auto runs it without a card; in Ask the (stub) reviewer blocks the word "delete", which makes it a card.
const CMD = { command: "echo delete-me > /tmp/perm-mode-warm-probe.txt", description: "probe" };

let app: HostApp | null = null;
let api: FakeMessagesApi | null = null;
afterEach(async () => { await app?.handlers.clearApiKey?.({}); await app?.close(); app = null; await api?.close(); api = null; });

const until = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return pred(); };

describe.runIf(process.env.RUN_CLAUDE === "1")("permission mode on a warm process", () => {
  it("Full auto → Ask while warm: the next tool call on the same process is gated by Ask", async () => {
    api = await startFakeMessagesApi([
      [{ tool: SHELL, input: CMD }], [{ tool: SEND, input: { content: "Done.", end_turn: true } }],
      [{ tool: SHELL, input: CMD }], [{ tool: SEND, input: { content: "Done again.", end_turn: true } }],
    ]);
    const cfg = tmpConfig();
    let brain = null as ClaudeBrain | null;
    app = await createHostApp(cfg, {
      brainFactory: (botId, d) => {
        const wiring = Object.create(d.wiring) as BrainWiring;
        wiring.flags = () => ({ ...d.wiring.flags(), runAs: "same-uid", warmSessions: true });
        brain = new ClaudeBrain({
          botId, cfg, wiring, getSessionId: d.getSessionId, setSessionId: d.setSessionId,
          spawnConfig: () => {
            const sc = d.spawnConfig();
            return { ...sc, env: { PATH: "/usr/bin:/bin", HOME: cfg.workspace, CLAUDE_CONFIG_DIR: cfg.claudeConfigDir, ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: api!.url, ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } };
          },
        });
        return brain;
      },
    });
    // The CLI signs in with the app's own auth (applied at spawn): the API key, one the fake API accepts.
    const v0 = await app.handlers.getAuth!({});
    await app.handlers.setApiKey!({ sealed: await sealTo(v0.boxPublicKey, "sk-ant-api03-" + "F".repeat(80) + "fake") });
    const { id } = await app.handlers.createAgent!({ name: "Warm", isKickstartRequested: false } as never);
    app.services.bots.updateSettings(id, { permMode: "full-auto" });
    const s = app.services;

    await app.handlers.sendPrompt!({ id, text: "run the probe", clientNonce: "n1" });
    const ok1 = await until(() => api!.calls.length >= 2 && s.runner.isIdle(id), 60_000);
    if (!ok1) console.error("DEBUG", JSON.stringify({ calls: api.calls.length, reqs: api.requests.slice(0, 5), state: brain?.procState, idle: s.runner.isIdle(id), trays: s.trays.list().map((t) => [t.title, t.detail]), tail: s.bots.tail(id, 8).map((e) => [e.kind, JSON.stringify(e).slice(0, 200)]) }));
    expect(ok1).toBe(true);
    expect(s.gate.pendingCount(id)).toBe(0); // Full auto: ran without a card
    expect(JSON.stringify(api.calls[1]!.lastUser)).not.toMatch(/Not run|denied|approval/i);
    const pid = brain!.pid;
    expect(brain!.procState).toBe("warm_idle");

    s.bots.updateSettings(id, { permMode: "ask" }); // tightened while the process is warm
    await app.handlers.sendPrompt!({ id, text: "run it again", clientNonce: "n2" });
    expect(await until(() => s.gate.pendingCount(id) > 0, 60_000)).toBe(true); // Ask: a card, on the same process
    expect(brain!.pid).toBe(pid);
    expect(api.calls.length).toBe(3); // the call is held at the card: no tool result reached the model
    await app.handlers.interruptAgent!({ id });
  }, 180_000);
});
