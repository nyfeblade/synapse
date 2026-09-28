import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OneShotTimeout, SdkOneShot, StubOneShot } from "../../helper-model/one-shot";
import { clearPromptCache } from "../../prompts/index";

function promptsDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-"));
  fs.mkdirSync(path.join(d, "orig"));
  fs.writeFileSync(path.join(d, "orig", "echo.md"), "<<ECHO_V1>>\nEcho the input.");
  fs.writeFileSync(path.join(d, "orig", "dated.md"), "Today is {{today}} in {{tz}}.");
  process.env.PROMPTS_DIR = d;
  clearPromptCache();
  return d;
}

function fakeQuery(messages: unknown[], opts: { hang?: boolean } = {}) {
  const seen: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.push(args);
    let closed = false;
    return {
      close: () => { closed = true; },
      async *[Symbol.asyncIterator]() {
        if (opts.hang) {
          await new Promise<void>((resolve) => {
            const ac = args.options.abortController as AbortController;
            ac.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (closed || (args.options.abortController as AbortController).signal.aborted) return;
        }
        for (const m of messages) yield m;
      },
    };
  }) as unknown as NonNullable<ConstructorParameters<typeof SdkOneShot>[0]["queryFn"]>;
  return { fn, seen };
}

describe("SdkOneShot", () => {
  it("runs a tool-less Haiku call with the prompt file as system prompt and returns structured output", async () => {
    promptsDir();
    const q = fakeQuery([{ type: "system" }, { type: "result", is_error: false, structured_output: { verdict: "drop" } }]);
    const m = new SdkOneShot({ env: { HOME: "/home/box" }, cwd: "/workspace", queryFn: q.fn });
    const out = await m.run<{ verdict: string }>({ prompt: "orig/echo.md", input: { a: 1 }, schema: { type: "object" }, timeoutMs: 1000 });
    expect(out).toEqual({ verdict: "drop" });
    const o = q.seen[0]!.options;
    expect(q.seen[0]!.prompt).toBe(JSON.stringify({ a: 1 }));
    expect(o).toMatchObject({ model: "claude-haiku-4-5-20251001", systemPrompt: "<<ECHO_V1>>\nEcho the input.", settingSources: [], tools: [], allowedTools: [], persistSession: false, outputFormat: { type: "json_schema", schema: { type: "object" } } });
    expect((o.env as Record<string, string>).ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });

  it("allows exactly the requested connector tool; claude.ai connectors stay off (synapse-public: no Claude login)", async () => {
    promptsDir();
    const q = fakeQuery([{ type: "result", is_error: false, structured_output: [] }]);
    const m = new SdkOneShot({ env: {}, cwd: "/workspace", queryFn: q.fn });
    await m.run({ prompt: "orig/echo.md", input: {}, schema: { type: "array" }, timeoutMs: 1000, allowedTools: ["mcp__claude_ai_Gmail__search_threads"] });
    expect(q.seen[0]!.options).toMatchObject({ allowedTools: ["mcp__claude_ai_Gmail__search_threads"], maxTurns: 4 });
    expect((q.seen[0]!.options.env as Record<string, string>).ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });

  it("bug 134: a call that asks for no thinking runs with thinking disabled (measured: 10–20x fewer output tokens); others are unchanged", async () => {
    promptsDir();
    const q = fakeQuery([{ type: "result", is_error: false, structured_output: {} }]);
    const m = new SdkOneShot({ env: {}, cwd: "/w", queryFn: q.fn });
    await m.run({ prompt: "orig/echo.md", input: {}, schema: {}, timeoutMs: 1000, thinking: false });
    expect(q.seen[0]!.options.thinking).toEqual({ type: "disabled" });
    await m.run({ prompt: "orig/echo.md", input: {}, schema: {}, timeoutMs: 1000 });
    expect(q.seen[1]!.options.thinking).toBeUndefined();
  });

  it("fills {{vars}} in the prompt file", async () => {
    promptsDir();
    const q = fakeQuery([{ type: "result", is_error: false, structured_output: {} }]);
    await new SdkOneShot({ env: {}, cwd: "/w", queryFn: q.fn }).run({ prompt: "orig/dated.md", vars: { today: "2026-09-19", tz: "America/New_York" }, input: {}, schema: {}, timeoutMs: 1000 });
    expect(q.seen[0]!.options.systemPrompt).toBe("Today is 2026-09-19 in America/New_York.");
  });

  it("throws on an error result and times out with OneShotTimeout", async () => {
    promptsDir();
    const bad = new SdkOneShot({ env: {}, cwd: "/w", queryFn: fakeQuery([{ type: "result", is_error: true }]).fn });
    await expect(bad.run({ prompt: "orig/echo.md", input: {}, schema: {}, timeoutMs: 1000 })).rejects.toThrow("no structured output");
    const slow = new SdkOneShot({ env: {}, cwd: "/w", queryFn: fakeQuery([], { hang: true }).fn });
    await expect(slow.run({ prompt: "orig/echo.md", input: {}, schema: {}, timeoutMs: 30 })).rejects.toBeInstanceOf(OneShotTimeout);
  });
});

describe("StubOneShot", () => {
  it("dispatches by prompt file, records calls, and honors timeouts", async () => {
    const stub = new StubOneShot({ "orig/b2b-gate.md": (i) => ({ verdict: "inbox", echo: i }), "orig/group-floor.md": () => new Promise(() => {}) });
    expect(await stub.run({ prompt: "orig/b2b-gate.md", input: { k: 1 }, schema: {}, timeoutMs: 100 })).toEqual({ verdict: "inbox", echo: { k: 1 } });
    expect(stub.calls).toEqual([{ prompt: "orig/b2b-gate.md", input: { k: 1 } }]);
    await expect(stub.run({ prompt: "orig/group-floor.md", input: {}, schema: {}, timeoutMs: 20 })).rejects.toBeInstanceOf(OneShotTimeout);
    await expect(stub.run({ prompt: "orig/unknown.md", input: {}, schema: {}, timeoutMs: 20 })).rejects.toThrow("no stub for orig/unknown.md");
  });
});
