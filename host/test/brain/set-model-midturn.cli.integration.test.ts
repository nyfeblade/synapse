import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type HookCallback, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeMessagesApi, type FakeMessagesApi } from "./fake-messages-api";

/**
 * cost-diet-2 lever 1 (model routing): escalation needs the CLI to switch models BETWEEN the model calls of
 * one turn. Pinned on the real CLI with a scripted fake Messages API (no model, no key): a routed turn starts
 * on Haiku; the moment it calls a work tool, the host calls Query.setModel(main) from the PreToolUse hook,
 * and the turn's next model call goes to the main model. Also pins that a turn-boundary setModel applies to
 * the next turn (the router's normal path).
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/brain/set-model-midturn.cli.integration.test.ts
 */
let api: FakeMessagesApi | null = null;
afterEach(async () => { await api?.close(); api = null; });

const models = (a: FakeMessagesApi) => a.bodies.map((b) => (JSON.parse(b) as { model: string }).model);

describe.runIf(process.env.RUN_CLAUDE === "1")("Query.setModel on a live session", () => {
  it("switches the model for the rest of the turn when called from PreToolUse, and for the next turn at a boundary", async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "setmodel-")));
    api = await startFakeMessagesApi([
      [{ tool: "Bash", input: { command: "true", description: "work" } }],
      [{ text: "done with turn one" }],
      [{ text: "turn two" }],
    ]);
    let q: Query | null = null;
    const pre: HookCallback = async () => {
      await q!.setModel("claude-sonnet-5");
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    };
    const inbox: SDKUserMessage[] = [];
    let wake: (() => void) | null = null;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (inbox.length) yield inbox.shift()!;
        await new Promise<void>((r) => { wake = r; });
      }
    }
    const say = (text: string) => { inbox.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } } as SDKUserMessage); wake?.(); };
    q = query({
      prompt: input(),
      options: {
        cwd: home, model: "claude-haiku-4-5-20251001", settingSources: [], persistSession: false, tools: ["Bash"], permissionMode: "default",
        hooks: { PreToolUse: [{ hooks: [pre] }] },
        env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      },
    });
    let results = 0;
    try {
      say("turn one");
      for await (const m of q) {
        if (m.type !== "result") continue;
        results++;
        if (results === 1) { await q.setModel("claude-haiku-4-5-20251001"); say("turn two"); }
        if (results === 2) break;
      }
    } finally {
      q.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
    const m = models(api);
    expect(m[0], "the routed turn starts on the cheap model").toMatch(/haiku/);
    expect(m[1], "after the work tool the same turn continues on the main model").toMatch(/sonnet/);
    expect(m[2], "a boundary setModel routes the next turn").toMatch(/haiku/);
  }, 90_000);
});
