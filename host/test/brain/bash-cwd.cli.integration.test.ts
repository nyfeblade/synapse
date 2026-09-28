import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type HookCallback, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeMessagesApi, type FakeMessagesApi } from "./fake-messages-api";

/**
 * cost-diet-2 (coding-bench run 2): the reviewer judged the built-in Bash's commands with an UNKNOWN cwd
 * (the host did not track it), so `npm test`, `npx tsc` and `npx vitest` after an earlier `cd` all went to
 * the ~8 s model reviewer. The CLI hands every PreToolUse hook its current `cwd`; this pins, on the real
 * CLI with a scripted fake Messages API (no model, no key), that the hook's cwd follows a Bash `cd` into
 * the next call. The approval gate relies on it (approvals/approval-gate.ts bashCwd).
 *
 *   RUN_CLAUDE=1 npx vitest run --project host host/test/brain/bash-cwd.cli.integration.test.ts
 */
let api: FakeMessagesApi | null = null;
afterEach(async () => { await api?.close(); api = null; });

describe.runIf(process.env.RUN_CLAUDE === "1")("the built-in Bash's cwd reaches the PreToolUse hook", () => {
  it("a `cd` in one Bash call is the next call's hook cwd", async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bashcwd-")));
    const sub = path.join(home, "proj");
    fs.mkdirSync(sub);
    api = await startFakeMessagesApi([
      [{ tool: "Bash", input: { command: `cd ${sub} && true`, description: "cd" } }],
      [{ tool: "Bash", input: { command: "true", description: "next" } }],
      [{ text: "done" }],
    ]);
    const seen: { command: string; cwd: string }[] = [];
    const pre: HookCallback = async (raw) => {
      const i = raw as PreToolUseHookInput;
      seen.push({ command: String((i.tool_input as { command?: string }).command), cwd: i.cwd });
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    };
    const q = query({
      prompt: "go",
      options: {
        cwd: home, model: "claude-sonnet-5", settingSources: [], persistSession: false, tools: ["Bash"], permissionMode: "default",
        hooks: { PreToolUse: [{ hooks: [pre] }] },
        env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sk-ant-api03-fake", ANTHROPIC_BASE_URL: api.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      },
    });
    try {
      for await (const m of q) if (m.type === "result") break;
    } finally {
      q.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
    expect(seen.map((s) => s.command)).toEqual([`cd ${sub} && true`, "true"]);
    expect(seen[0]!.cwd).toBe(home);
    expect(seen[1]!.cwd, "the hook sees where the next Bash call will run").toBe(sub);
  }, 60_000);
});
