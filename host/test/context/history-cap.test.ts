import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { historyCaps, historyKeepLabel } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { applyHistoryEnv } from "../../context/history-env";
import { startFakeMessagesApi } from "../brain/fake-messages-api";
import { tmpConfig } from "../helpers";

/**
 * Token diet (2): the history caps. Chief of Staff (usage.db) re-read 145–190k tokens on every call on
 * the 1M window, where 70% would have let it grow to 700k. Standard now compacts at 180k when idle
 * (Compactor, compactor.test.ts) and at 250k mid-task (the CLI's own auto-compact, set here).
 */
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("history caps", () => {
  // cost-diet-2 lever 6: 150k (was 180k): recall with the archive held at 1.000 at 120k, 150k and 180k (full scale).
  it("standard: 150k at idle, 250k hard on the 1M window; a 200k window keeps its own cap and the CLI default", () => {
    expect(historyCaps("standard", 1_000_000)).toEqual({ idleTokens: 150_000, hardTokens: 250_000 });
    expect(historyCaps(undefined, 1_000_000)).toEqual({ idleTokens: 150_000, hardTokens: 250_000 });
    expect(historyCaps("standard", 200_000)).toEqual({ idleTokens: 150_000, hardTokens: null });
    expect(historyCaps("more", 1_000_000)).toEqual({ idleTokens: 400_000, hardTokens: 500_000 });
    expect(historyCaps("full", 1_000_000)).toEqual({ idleTokens: 700_000, hardTokens: null });
  });

  it("the setting says what each choice keeps and costs next to Standard", () => {
    expect(historyKeepLabel("standard")).toBe("Standard: up to 150k tokens");
    expect(historyKeepLabel("more")).toBe("More: up to 400k tokens, about 2.7× the tokens per message");
    expect(historyKeepLabel("full")).toBe("Full window: up to 700k tokens, about 4.7× the tokens per message");
  });

  it("the CLI gets its auto-compact window so it compacts at the hard cap; a stored secret can't turn that off", () => {
    const env: Record<string, string> = { DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" };
    applyHistoryEnv(env, "standard", "claude-sonnet-5[1m]");
    expect(env).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "283000" });
    const full: Record<string, string> = {};
    applyHistoryEnv(full, "full", "claude-sonnet-5[1m]");
    expect(full).toEqual({});
    const small: Record<string, string> = {};
    applyHistoryEnv(small, "standard", "claude-haiku-4-5");
    expect(small).toEqual({});
  });

  it("a Bot's spawn carries the cap, and changing the setting respawns it (the spawn key moves)", async () => {
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Chief", isKickstartRequested: false });
    a.services.bots.update(id, { model: "claude-sonnet-5" });
    const before = a.services.spawnConfig(id);
    expect(before.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("283000");
    const r = await a.handlers.setAgentHistoryKeep!({ id, keep: "more" });
    expect(r.agent.settings.advanced?.historyKeep).toBe("more");
    const after = a.services.spawnConfig(id);
    expect(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("533000");
    expect(after.spawnKey).not.toBe(before.spawnKey);
    await expect(Promise.resolve().then(() => a.handlers.setAgentHistoryKeep!({ id, keep: "huge" as never }))).rejects.toThrow();
  });
});

/**
 * The hard cap against the real CLI (RUN_CLAUDE=1): a scripted fake Messages API reports the context
 * size, and the CLI's own auto-compact starts mid-turn at 250k with the Bot's env, not at 249k.
 */
describe.runIf(process.env.RUN_CLAUDE === "1")("the CLI compacts mid-task at the hard cap", () => {
  const compacts = async (contextTokens: number): Promise<boolean> => {
    const api = await startFakeMessagesApi([[{ tool: "Bash", input: { command: "echo hi", description: "x" } }], [{ text: "done" }]], { contextTokens });
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "histcap-")));
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    applyHistoryEnv(env, "standard", "claude-sonnet-5[1m]");
    const q = query({ prompt: "go", options: { cwd: home, env, tools: ["Bash"], model: "claude-sonnet-5[1m]", persistSession: false, settingSources: [], canUseTool: async (_n, i) => ({ behavior: "allow", updatedInput: i }) } });
    let compacting = false;
    try {
      for await (const m of q) {
        if (m.type === "system" && (m as { subtype?: string; status?: string }).subtype === "status" && (m as { status?: string }).status === "compacting") compacting = true;
        if (m.type === "result") break;
      }
    } finally {
      q.close();
      await api.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
    return compacting;
  };

  it("249k: no; 251k: yes", async () => {
    expect(await compacts(249_000)).toBe(false);
    expect(await compacts(251_000)).toBe(true);
  }, 120_000);
});
