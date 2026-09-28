import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { LIMITS } from "@synapse/shared";
import { ClaudeBrain } from "../../brain/claude-brain";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { ZERO_USAGE } from "../../brain/types";
import { loadConfig } from "../../config";
import { input, testWiring } from "./helpers";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHostApp } from "../../app";
import { ENGINEERING_UP_FRONT_TOOLS, EVERYDAY_UP_FRONT_TOOLS, NON_CODING_BUILTIN_SKILLS } from "../../engineering/lean-profile";
import { tmpConfig } from "../helpers";
import { sealTo } from "../../secrets/crypto";

/** A stand-in for the SDK Query: answers each pushed user message with init (first time), assistant text and result. */
function fakeQueryFactory(opts: { initOnFirstMessage?: boolean } = {}) {
  const spawned: Options[] = [];
  const setModels: string[] = [];
  const flagSettings: unknown[] = [];
  let closed = 0;
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    spawned.push(params.options);
    const out: unknown[] = [];
    const waiters: ((v: IteratorResult<unknown>) => void)[] = [];
    let done = false;
    const emit = (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else out.push(m); };
    const finish = () => { done = true; for (const w of waiters.splice(0)) w({ value: undefined, done: true }); };
    let interrupted = false;
    let first = true;
    (async () => {
      if (!opts.initOnFirstMessage) emit({ type: "system", subtype: "init", session_id: params.options.sessionId ?? params.options.resume, model: params.options.model, tools: [], claude_code_version: "2.1.277" });
      for await (const msg of params.prompt) {
        if (opts.initOnFirstMessage && first) emit({ type: "system", subtype: "init", session_id: params.options.sessionId ?? params.options.resume, model: params.options.model, tools: [], claude_code_version: "2.1.277" });
        first = false;
        const text = (msg.message.content as { text: string }[])[0]!.text;
        if (text === "HANG") { await new Promise((r) => setTimeout(r, 50)); if (!interrupted) continue; }
        // "CTX:<n>": the assistant message reports an n-token context (saving-settings, long-context escalation).
        const ctx = /^CTX:(\d+)$/.exec(text);
        emit({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "text", text: `echo ${text}` }], ...(ctx ? { usage: { input_tokens: Number(ctx[1]) } } : {}) } });
        emit({ type: "result", subtype: interrupted ? "error_during_execution" : "success", is_error: interrupted, result: "", errors: [], usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 }, total_cost_usd: 0.001, modelUsage: {} });
        interrupted = false;
      }
      finish();
    })();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => (out.length ? Promise.resolve({ value: out.shift(), done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiters.push(r))),
      return: async () => { finish(); return { value: undefined, done: true }; },
      interrupt: async () => { interrupted = true; emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "", errors: ["interrupted"], usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, modelUsage: {} }); },
      setModel: async (m: string) => { setModels.push(m); },
      applyFlagSettings: async (s: unknown) => { flagSettings.push(s); },
      close: () => { closed++; finish(); },
    };
  }) as never;
  return { queryFn, spawned, setModels, flagSettings, closedCount: () => closed };
}

function makeBrain(f: ReturnType<typeof fakeQueryFactory>, over: { flags?: Partial<typeof DEFAULT_FLAGS>; model?: string } = {}) {
  let session: string | null = null;
  let model = over.model ?? "claude-sonnet-5";
  let key = "k1";
  const wiring = testWiring({ flags: () => ({ ...DEFAULT_FLAGS, ...over.flags }) });
  const brain = new ClaudeBrain({
    botId: "b1", cfg: loadConfig({}), wiring, queryFn: f.queryFn,
    getSessionId: () => session, setSessionId: (id) => { session = id; },
    spawnConfig: () => ({ model, systemAppend: "P", env: {}, spawnKey: key }),
  });
  return { brain, setModel: (m: string) => { model = m; }, setKey: (k: string) => { key = k; }, session: () => session };
}

describe("ClaudeBrain (ORIG-16 §16.2–16.3)", () => {
  it("spawns with the prompt mode its spawn config names, and respawns when it changes (engineering switch)", async () => {
    const f = fakeQueryFactory();
    let mode: "standalone" | "preset" = "standalone";
    let session: string | null = null;
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn: f.queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: `k-${mode}`, systemPromptMode: mode }),
    });
    await brain.runTurn(input("one"), () => {});
    expect(typeof f.spawned[0]!.systemPrompt).toBe("string");
    mode = "preset";
    await brain.runTurn(input("two"), () => {});
    expect(f.spawned).toHaveLength(2);
    expect(f.spawned[1]!.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "P" });
    expect(f.spawned[1]!.resume).toBe(session);
    await brain.dispose();
  });

  it("spawns with sessionId, stores it, then warm-pushes the second turn into the same process", async () => {
    const f = fakeQueryFactory();
    const { brain, session } = makeBrain(f);
    const r1 = await brain.runTurn(input("one"), () => {});
    expect(r1).toMatchObject({ finalText: "echo one", aborted: false });
    expect(brain.procState).toBe("warm_idle");
    expect(session()).toBe(f.spawned[0]!.sessionId);
    const r2 = await brain.runTurn(input("two"), () => {});
    expect(r2.finalText).toBe("echo two");
    expect(f.spawned).toHaveLength(1);
  });

  // Task 34 fix round, live re-run of Step 2 against the box: the real Claude CLI rejected the
  // model's mcp__bot__SendMessage tool call with "No such tool available: mcp__bot__SendMessage"
  // (confirmed from the real session's own transcript jsonl), so the model retried, fell back to the
  // bare (host-disallowed) "SendMessage" name, got a second, clearer error, and gave up, replying
  // with plain text nobody ever sees. buildBotQueryOptions's `tools: [...BOT_BUILTIN_TOOLS]` allowlist
  // named only CLI built-ins and never the bot's own MCP-server tool names — unlike the conformance
  // probes (host/brain/conformance/context.ts's baseOptions), which set no `tools:` restriction at
  // all and whose own MCP tools (e.g. mcp__probe__ping, CT-02) are reachable. The fix folds the bot's
  // own tool names (namespaced mcp__bot__<name>, matching the "bot" MCP server's registered name)
  // into that same allowlist.
  it("includes the bot's own MCP tool names (mcp__bot__*) in the tools allowlist alongside the CLI built-ins", async () => {
    const f = fakeQueryFactory();
    const { brain } = makeBrain(f);
    await brain.runTurn(input("one"), () => {});
    expect(f.spawned[0]!.tools).toEqual(expect.arrayContaining(["Bash", "mcp__bot__SendMessage"]));
  });

  /**
   * S1 lean engineering profile: what the CLI is actually spawned with. An engineering Bot's "bot"
   * server marks only the coding session's tools alwaysLoad (the rest wait behind ToolSearch) and
   * lists the non-coding built-in skills by name only; a standard Bot's spawn is unchanged.
   */
  it("an engineering Bot's spawn loads only the up-front bot tools and names non-coding skills only; an everyday Bot loads the everyday set without Bash", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    const app = await createHostApp(cfg);
    // synapse-public: a Bot runs only with the Anthropic API key saved (a fake one; the query function is a fake too).
    await app.handlers.setApiKey!({ sealed: await sealTo((await app.handlers.getAuth!({})).boxPublicKey, "sk-ant-api03-" + "T".repeat(80) + "test") });
    try {
      const listed = async (o: Options) => {
        const srv = o.mcpServers!.bot as McpSdkServerConfigWithInstance;
        const [a, b] = InMemoryTransport.createLinkedPair();
        await (srv.instance as unknown as { connect(t: unknown): Promise<void> }).connect(a);
        const c = new Client({ name: "t", version: "1" });
        await c.connect(b);
        try { return (await c.listTools()).tools; } finally { await c.close(); }
      };
      const loaded = (tools: { name: string; _meta?: Record<string, unknown> }[]) => tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name).sort();
      const spawnFor = async (engineering: boolean) => {
        const { id } = await app.handlers.createAgent!({ name: engineering ? "Eng" : "Std", isKickstartRequested: false });
        if (engineering) await app.handlers.setAgentEngineeringMode!({ id, enabled: true });
        const f = fakeQueryFactory();
        let session: string | null = null;
        const brain = new ClaudeBrain({
          botId: id, cfg, wiring: app.services.runner.wiring(id), queryFn: f.queryFn,
          getSessionId: () => session, setSessionId: (sid) => { session = sid; }, spawnConfig: () => app.services.spawnConfig(id),
        });
        await brain.runTurn(input("one"), () => {});
        await brain.dispose();
        return { o: f.spawned[0]!, all: app.services.runner.wiring(id).botTools().map((t) => t.name) };
      };

      const eng = await spawnFor(true);
      const engTools = await listed(eng.o);
      expect(loaded(engTools)).toEqual([...ENGINEERING_UP_FRONT_TOOLS].sort());
      expect(engTools.length, "the other bot tools are still served, lazily").toBe(eng.all.length);
      expect(eng.o.tools).toContain("ToolSearch");
      const overrides = (eng.o.settings as { skillOverrides?: Record<string, string> }).skillOverrides ?? {};
      for (const n of NON_CODING_BUILTIN_SKILLS) expect(overrides[n], n).toBe("name-only");
      for (const n of ["code-review", "simplify", "security-review", "init", "run"]) expect(overrides[n], n).toBeUndefined();

      // Engineering and coding keep Claude Code's own Bash (cost-diet-2 lever 2).
      expect(eng.o.tools).toContain("Bash");

      // cost-diet-2 levers 2 + 3: an everyday Bot loads exactly the evidence-picked up-front set (of the
      // tools it has), every other bot tool is still served lazily, and it has no built-in Bash: the
      // host's Shell (always registered, up front) does its shell work.
      const std = await spawnFor(false);
      const stdTools = await listed(std.o);
      expect(loaded(stdTools), "an everyday Bot loads only the up-front set").toEqual(EVERYDAY_UP_FRONT_TOOLS.filter((n) => std.all.includes(n)).sort());
      expect(loaded(stdTools)).toEqual(expect.arrayContaining(["SendMessage", "Shell", "SearchHistory"]));
      expect(stdTools.length, "the other bot tools are still served, lazily").toBe(std.all.length);
      expect(std.o.tools).toContain("ToolSearch");
      expect(std.o.tools).not.toContain("Bash");
      for (const t of ["Read", "Write", "Edit", "WebFetch", "WebSearch", "TodoWrite", "Skill"]) expect(std.o.tools, t).toContain(t);
      expect((std.o.settings as { skillOverrides?: unknown }).skillOverrides).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("works when the CLI only sends init after the first message (CT-10 fails)", async () => {
    const f = fakeQueryFactory({ initOnFirstMessage: true });
    const { brain } = makeBrain(f);
    expect((await brain.runTurn(input("x"), () => {})).finalText).toBe("echo x");
  });

  it("cold-only mode closes after each result and resumes next time", async () => {
    const f = fakeQueryFactory();
    const { brain, session } = makeBrain(f, { flags: { warmSessions: false } });
    await brain.runTurn(input("one"), () => {});
    expect(brain.procState).toBe("cold");
    await brain.runTurn(input("two"), () => {});
    expect(f.spawned).toHaveLength(2);
    expect(f.spawned[1]!.resume).toBe(session());
  });

  it("a voice-call turn runs at low effort on the warm process, and the next typed turn is back to the Bot's own", async () => {
    const f = fakeQueryFactory();
    const a = makeBrain(f);
    await a.brain.runTurn({ ...input("hello"), voiceTurn: true }, () => {}); // cold start straight into a voice turn
    expect(f.flagSettings).toEqual([{ effortLevel: "low" }]);
    await a.brain.runTurn({ ...input("and London"), voiceTurn: true }, () => {});
    expect(f.flagSettings).toHaveLength(1); // already low: nothing to change
    await a.brain.runTurn(input("typed"), () => {});
    expect(f.flagSettings).toEqual([{ effortLevel: "low" }, { effortLevel: null }]); // no Bot effort: the model default
    expect(f.spawned).toHaveLength(1); // a per-turn option, never a respawn
  });

  // saving-settings (Call replies): every effort switch on a live process re-writes the history cache; it is logged
  // with the same words the cache-rewrites investigation (bug-log "Prompt-cache re-writes on a warm cache") used.
  it("logs each effort switch on the live process", async () => {
    const f = fakeQueryFactory();
    const lines: [string, Record<string, unknown> | undefined][] = [];
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn: f.queryFn, log: (m, x) => lines.push([m, x]),
      getSessionId: () => null, setSessionId: () => {}, spawnConfig: () => ({ model: "claude-sonnet-5", effort: "high", systemAppend: "P", env: {}, spawnKey: "k" }),
    });
    await brain.runTurn({ ...input("spoken"), voiceTurn: true }, () => {});
    await brain.runTurn(input("typed"), () => {});
    const switches = lines.filter(([m]) => m.startsWith("effort switched on the live process"));
    expect(switches.map(([, x]) => x?.to)).toEqual(["low", "high"]);
  });

  // saving-settings (Long-context model, "Only when needed"): a turn that grows past the line switches to [1m] before
  // its next model call (PreToolUse, like the router's escalation), once; never on a spawn that has no escalation set.
  it("Only when needed: a turn whose context passes the line switches the live process to [1m] at its next tool call, once", async () => {
    const f = fakeQueryFactory();
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn: f.queryFn,
      getSessionId: () => null, setSessionId: () => {},
      spawnConfig: () => ({ model: "claude-sonnet-5", systemAppend: "P", env: {}, spawnKey: "k", longContext: { model: "claude-sonnet-5[1m]", atTokens: 160_000 } }),
    });
    const pre = () => f.spawned[0]!.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/" } as never, "t1", { signal: new AbortController().signal });
    await brain.runTurn(input("CTX:100000"), () => {});
    await pre();
    expect(f.setModels).toEqual([]);
    await brain.runTurn(input("CTX:170000"), () => {});
    await pre();
    await pre();
    expect(f.setModels).toEqual(["claude-sonnet-5[1m]"]);
  });

  it("On: no escalation is ever made mid-turn", async () => {
    const f = fakeQueryFactory();
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn: f.queryFn,
      getSessionId: () => null, setSessionId: () => {}, spawnConfig: () => ({ model: "claude-sonnet-5[1m]", systemAppend: "P", env: {}, spawnKey: "k" }),
    });
    await brain.runTurn(input("CTX:900000"), () => {});
    await f.spawned[0]!.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/" } as never, "t1", { signal: new AbortController().signal });
    expect(f.setModels).toEqual([]);
  });

  it("applies a model change with setModel, or respawns when CT-17 failed", async () => {
    const f = fakeQueryFactory();
    const a = makeBrain(f);
    await a.brain.runTurn(input("one"), () => {});
    a.setModel("claude-opus-5");
    await a.brain.runTurn(input("two"), () => {});
    expect(f.setModels).toEqual(["claude-opus-5"]);
    const g = fakeQueryFactory();
    const b = makeBrain(g, { flags: { modelChange: "respawn" } });
    await b.brain.runTurn(input("one"), () => {});
    b.setModel("claude-opus-5");
    await b.brain.runTurn(input("two"), () => {});
    expect(g.spawned.map((o) => o.model)).toEqual(["claude-sonnet-5", "claude-opus-5"]);
  });

  // cost-diet-2 lever 1: a routed turn runs on the router's model, switching a warm process with setModel both ways.
  it("runs a routed turn on the routed model and switches back for the next turn", async () => {
    const f = fakeQueryFactory();
    const a = makeBrain(f);
    const r1 = await a.brain.runTurn({ ...input("hi"), routedModel: "claude-haiku-4-5-20251001" }, () => {});
    expect(f.spawned[0]!.model, "a cold routed turn spawns on the routed model").toBe("claude-haiku-4-5-20251001");
    expect(r1.model).toBe("claude-haiku-4-5-20251001");
    const r2 = await a.brain.runTurn(input("fix the bug"), () => {});
    expect(r2.model).toBe("claude-sonnet-5");
    await a.brain.runTurn({ ...input("thanks"), routedModel: "claude-haiku-4-5-20251001" }, () => {});
    expect(f.setModels).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    expect(f.spawned, "no respawn: the session carries on").toHaveLength(1);
  });

  it("a routed turn that reaches for a work tool finishes on the Bot's own model; a reply alone does not escalate", async () => {
    const f = fakeQueryFactory();
    const a = makeBrain(f);
    await a.brain.runTurn({ ...input("hi"), routedModel: "claude-haiku-4-5-20251001" }, () => {});
    const pre = f.spawned[0]!.hooks!.PreToolUse![0]!.hooks[0]!;
    const call = (tool_name: string) => pre({ hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: `t-${tool_name}`, session_id: "s", transcript_path: "", cwd: "/" } as never, `t-${tool_name}`, { signal: new AbortController().signal });
    await call("mcp__bot__SendMessage");
    expect(f.setModels).toEqual([]);
    await call("mcp__bot__Shell");
    await call("Read");
    expect(f.setModels, "once, on the first work tool").toEqual(["claude-sonnet-5"]);
    await a.brain.runTurn(input("next"), () => {});
    expect(f.setModels, "already on the main model: no second switch").toEqual(["claude-sonnet-5"]);
  });

  it("respawns when spawn-time state changes (epoch, secrets, MCP set)", async () => {
    const f = fakeQueryFactory();
    const b = makeBrain(f);
    await b.brain.runTurn(input("one"), () => {});
    b.setKey("k2");
    await b.brain.runTurn(input("two"), () => {});
    expect(f.spawned).toHaveLength(2);
  });

  it("interrupt ends the turn as aborted and returns to warm_idle", async () => {
    const f = fakeQueryFactory();
    const { brain } = makeBrain(f);
    await brain.runTurn(input("warm"), () => {});
    const p = brain.runTurn(input("HANG"), () => {});
    await new Promise((r) => setTimeout(r, 10));
    await brain.interrupt("user message");
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(brain.procState).toBe("warm_idle");
  });
});

/**
 * A controllable fake Query whose `next()` never settles until the test calls `emit`/`endNow`/`throwNow`,
 * and whose `close()` does NOT unstick an ALREADY-pending `next()` (simulating a slow-to-exit Claude
 * Code process — see the "generation guard" tests below).
 *
 * Real SDK semantics (installed SDK's Query wraps a real `async *` generator, created once): once the
 * generator throws out of `next()`, or once `close()` has run its course, it is *permanently
 * completed* — every `next()` call from then on resolves `{done: true}` immediately; it never hangs
 * again and never re-throws. `throwNow` and `close` both mark that terminal state here so a test can't
 * accidentally model a query that "resumes" after throwing, which a real generator cannot do.
 */
function makeControllableQuery() {
  const queue: unknown[] = [];
  const waiters: { resolve: (v: IteratorResult<unknown>) => void; reject: (e: unknown) => void }[] = [];
  let done = false; // true once the generator is permanently completed: every later next() -> {done:true}
  let closeCount = 0;
  const query = {
    [Symbol.asyncIterator]() { return this; },
    next: () => {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<unknown>>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    return: async () => { done = true; for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true }); return { value: undefined, done: true }; },
    interrupt: async () => undefined,
    setModel: async () => {},
    // Does NOT resolve/reject an already-pending next() (models a slow-to-exit process), but DOES mark
    // the generator done for any LATER next() call, matching real close()/return() semantics.
    close: () => { closeCount++; done = true; },
  } as unknown as Query;
  return {
    query,
    emit: (v: unknown) => { const w = waiters.shift(); if (w) w.resolve({ value: v, done: false }); else queue.push(v); },
    endNow: () => { done = true; for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true }); },
    // Rejects the currently-pending next() (if any) with `e`, exactly once — then the generator is
    // permanently completed: any subsequent next() call resolves {done:true}, it does not hang waiting
    // for a future emit() and does not throw again.
    throwNow: (e: unknown) => { const w = waiters.shift(); done = true; if (w) w.reject(e); },
    closeCount: () => closeCount,
  };
}

function makeQueryFn() {
  const created: ReturnType<typeof makeControllableQuery>[] = [];
  const spawnedOptions: Options[] = [];
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    spawnedOptions.push(params.options);
    const c = makeControllableQuery();
    created.push(c);
    return c.query;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { queryFn, created, spawnedOptions };
}

const RESULT_MSG = (text: string) => ({
  type: "assistant", parent_tool_use_id: null, message: { id: `m_${text}`, content: [{ type: "text", text }] },
});
const OK_RESULT = {
  type: "result", subtype: "success", is_error: false, result: "", errors: [],
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0,
};
const INIT = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId, model: "m", tools: [], claude_code_version: "2.1.277" });

describe("ClaudeBrain generation guard (stale pumps must not touch a newer generation)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a stale generation-1 pump that finally exits after cool() gave up does not corrupt generation 2", async () => {
    const { queryFn, created } = makeQueryFn();
    let session: string | null = null;
    const logs: { msg: string; f?: Record<string, unknown> }[] = [];
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: "k1" }),
      log: (msg, f) => logs.push({ msg, f }),
    });

    // Turn 1 on generation 1, completes normally and reaches warm_idle.
    const p1 = brain.runTurn(input("one"), () => {});
    const c1 = created[0]!;
    c1.emit(INIT("s1"));
    c1.emit(RESULT_MSG("echo one"));
    c1.emit(OK_RESULT);
    await p1;
    expect(brain.procState).toBe("warm_idle");

    // cool() gives up: c1 never unsticks (close() doesn't resolve its pending next()), so both the
    // exited-race and the forced-close grace wait time out; cool() proceeds anyway.
    const coolP = brain.cool("test-reason");
    await vi.advanceTimersByTimeAsync(LIMITS.coolExitMs);
    await vi.advanceTimersByTimeAsync(LIMITS.coolTermGraceMs);
    await coolP;
    expect(brain.procState).toBe("cold");

    // Generation 2 spawns and completes a whole turn normally while gen 1's pump is still stuck.
    const p2 = brain.runTurn(input("two"), () => {});
    const c2 = created[1]!;
    c2.emit(INIT("s1"));
    c2.emit(RESULT_MSG("echo two"));
    c2.emit(OK_RESULT);
    const r2 = await p2;
    expect(r2.finalText).toBe("echo two");
    expect(r2.aborted).toBe(false);
    expect(brain.procState).toBe("warm_idle");

    // Now the slow-dying generation-1 process finally exits.
    c1.endNow();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    // The stale gen-1 pump must not have crashed/closed generation 2.
    expect(c2.closeCount()).toBe(0);
    expect(brain.procState).toBe("warm_idle");
    expect(logs.some((l) => /stale/i.test(l.msg))).toBe(true);
  });

  it("generation 1's spawn-init watchdog firing after generation 2 has spawned does not crash generation 2", async () => {
    const { queryFn, created } = makeQueryFn();
    let session: string | null = null;
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: "k1" }),
    });

    // Generation 1 never sends init: it stays "spawning" and its spawnInitTimeoutMs watchdog is armed.
    const p1 = brain.runTurn(input("one"), () => {});
    expect(brain.procState).toBe("spawning");

    // Force it away (e.g. an operator-triggered cool) before the watchdog fires. c1 stays stuck, so
    // cool() gives up via its own timeouts, same as the previous test.
    const coolP = brain.cool("force", true);
    await vi.advanceTimersByTimeAsync(LIMITS.coolExitMs);
    await vi.advanceTimersByTimeAsync(LIMITS.coolTermGraceMs);
    await coolP;
    const r1 = await p1;
    expect(r1.aborted).toBe(true);
    expect(brain.procState).toBe("cold");

    // Generation 2 spawns, also without init yet, so it's "spawning" too — with its own, later watchdog.
    const p2 = brain.runTurn(input("two"), () => {});
    const c2 = created[1]!;
    expect(brain.procState).toBe("spawning");

    // Advance exactly to when generation 1's ORIGINAL watchdog (armed at t=0) fires.
    const alreadyElapsed = LIMITS.coolExitMs + LIMITS.coolTermGraceMs;
    await vi.advanceTimersByTimeAsync(LIMITS.spawnInitTimeoutMs - alreadyElapsed);

    // Generation 1's stale watchdog must not have crashed generation 2.
    expect(brain.procState).toBe("spawning");
    expect(c2.closeCount()).toBe(0);

    // Generation 2 still works normally afterwards.
    c2.emit(INIT("s2"));
    c2.emit(RESULT_MSG("echo two"));
    c2.emit(OK_RESULT);
    const r2 = await p2;
    expect(r2.finalText).toBe("echo two");
  });
});

// Task 34 fix round, finding 1 (Bug 2): cool() used to force-close the transport unconditionally
// once `coolExitMs` elapsed, even when `this.turn` was still genuinely active (no "result" message
// observed yet) and the cool wasn't `force`d (every call site except interrupt()'s own hard-timeout
// fallback: cold-only mode's post-turn teardown, spawn-time/model-change teardown, dispose()). That
// races a real turn that may already be Stop-hook-approved and billed on the CLI side: closing the
// transport can sever it before its trailing SendMessage/result arrives, and cool() would then
// resolve the turn as `aborted: true` with `usage: ZERO_USAGE`, silently discarding an already-paid
// reply. The fix gives a still-pending, non-forced turn the FULL coolExitMs + coolTermGraceMs window
// before ever closing.
describe("ClaudeBrain cool() vs. a still-active turn (Task 34 Bug 2: cold-only mode must not race an in-flight reply)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not close the transport at the first timeout while a non-forced cool's turn is still pending, and the real result wins if it lands within the grace window", async () => {
    const { queryFn, created } = makeQueryFn();
    let session: string | null = null;
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: "k1" }),
    });

    const p1 = brain.runTurn(input("one"), () => {});
    const c1 = created[0]!;
    c1.emit(INIT("s1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(brain.procState).toBe("running");

    // Something tears this brain down (e.g. cold-only mode's post-turn cool) WHILE the turn is
    // still genuinely in flight — no "result" message has arrived yet.
    const coolP = brain.cool("cold-only mode");
    await vi.advanceTimersByTimeAsync(LIMITS.coolExitMs);
    // A non-forced cool must not have severed the transport yet: the CLI may already be
    // Stop-hook-approved and about to flush its SendMessage/result.
    expect(c1.closeCount()).toBe(0);

    // The real reply lands just after that first timeout, still within the grace window.
    c1.emit(RESULT_MSG("echo one"));
    c1.emit(OK_RESULT);
    await vi.advanceTimersByTimeAsync(0);

    const r1 = await p1;
    expect(r1.aborted).toBe(false);
    expect(r1.finalText).toBe("echo one");
    expect(r1.usage).not.toEqual(ZERO_USAGE);

    // cool() still completes — it doesn't hang forever on a process that never truly exits.
    await vi.advanceTimersByTimeAsync(LIMITS.coolTermGraceMs);
    await coolP;
    expect(brain.procState).toBe("cold");
  });

  it("still closes promptly at the first timeout when there is no pending turn to protect", async () => {
    const { queryFn, created } = makeQueryFn();
    let session: string | null = null;
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: "k1" }),
    });
    const p1 = brain.runTurn(input("one"), () => {});
    const c1 = created[0]!;
    c1.emit(INIT("s1"));
    c1.emit(RESULT_MSG("echo one"));
    c1.emit(OK_RESULT);
    await p1;

    const coolP = brain.cool("test-reason");
    await vi.advanceTimersByTimeAsync(LIMITS.coolExitMs);
    expect(c1.closeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(LIMITS.coolTermGraceMs);
    await coolP;
  });

  it("force cool still closes immediately regardless of a pending turn", async () => {
    const { queryFn, created } = makeQueryFn();
    let session: string | null = null;
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: "k1" }),
    });
    const p1 = brain.runTurn(input("one"), () => {});
    const c1 = created[0]!;
    c1.emit(INIT("s1"));
    await vi.advanceTimersByTimeAsync(0);

    const coolP = brain.cool("interrupt not acknowledged", true);
    expect(c1.closeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(LIMITS.coolExitMs);
    await vi.advanceTimersByTimeAsync(LIMITS.coolTermGraceMs);
    await coolP;
    const r1 = await p1;
    expect(r1.aborted).toBe(true);
  });
});

describe("ClaudeBrain post-interrupt SDK throw (CT-03 conformance fix)", () => {
  it("ends the query cleanly (cold, not crashed) after the expected post-interrupt throw, and the next runTurn respawns fresh", async () => {
    const { queryFn, created, spawnedOptions } = makeQueryFn();
    let session: string | null = null;
    const logs: { msg: string; f?: Record<string, unknown> }[] = [];
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: "k1" }),
      log: (msg, f) => logs.push({ msg, f }),
    });

    const p = brain.runTurn(input("go"), () => {});
    const c = created[0]!;
    c.emit(INIT("s1"));
    await new Promise((r) => setTimeout(r, 10));
    expect(brain.procState).toBe("running");
    expect(session).toBe("s1");

    // The host interrupts mid-tool-use (procState -> "interrupted").
    const interruptP = brain.interrupt("user message");
    await new Promise((r) => setTimeout(r, 10));

    // The CLI delivers its final result quickly, as it does in production: the turn resolves via
    // finishTurn() (procState -> "warm_idle") before the interrupt's own settle race completes.
    c.emit({
      type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools",
      result: "", errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
      usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.0001,
    });
    await interruptP;
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.error).toBeUndefined();
    expect(brain.procState).toBe("warm_idle");

    // Then the SDK throws out of the async iterator on the very next iteration. The installed SDK's
    // Query wraps a real `async *` generator: once it throws, the generator is permanently completed
    // (its own catch already closed the transport), so there's nothing to "forgive and resume" — this
    // must end the query cleanly (cold, no crash record), not retry reading from it.
    c.throwNow(new Error("Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"));
    await new Promise((r) => setTimeout(r, 10));

    // Ends cold (not crashed), the query was closed, and the already-resolved turn result — still
    // aborted, still no crash-shaped error — is untouched.
    expect(brain.procState).toBe("cold");
    expect(c.closeCount()).toBeGreaterThan(0);
    expect(r.aborted).toBe(true);
    expect(r.error).toBeUndefined();
    expect(logs.some((l) => /ended cleanly/i.test(l.msg))).toBe(true);
    expect(logs.some((l) => /crash/i.test(l.msg))).toBe(false);

    // The next runTurn() spawns fresh (cold -> spawning) and resumes the same session, as usual.
    const p2 = brain.runTurn(input("two"), () => {});
    expect(brain.procState).toBe("spawning");
    expect(created).toHaveLength(2);
    expect(spawnedOptions[1]!.resume).toBe("s1");
    const c2 = created[1]!;
    c2.emit(INIT("s1"));
    c2.emit(RESULT_MSG("echo two"));
    c2.emit(OK_RESULT);
    const r2 = await p2;
    expect(r2.finalText).toBe("echo two");
    expect(brain.procState).toBe("warm_idle");
  });

  it("a genuine process death while idle (no interrupt) still crashes -> cold", async () => {
    const { queryFn, created } = makeQueryFn();
    let session: string | null = null;
    const logs: { msg: string; f?: Record<string, unknown> }[] = [];
    const brain = new ClaudeBrain({
      botId: "b1", cfg: loadConfig({}), wiring: testWiring(), queryFn,
      getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "m", systemAppend: "P", env: {}, spawnKey: "k1" }),
      log: (msg, f) => logs.push({ msg, f }),
    });

    // A whole turn completes normally; no interrupt() is ever called.
    const p = brain.runTurn(input("one"), () => {});
    const c = created[0]!;
    c.emit(INIT("s1"));
    c.emit(RESULT_MSG("echo one"));
    c.emit(OK_RESULT);
    const r = await p;
    expect(r.finalText).toBe("echo one");
    expect(brain.procState).toBe("warm_idle");

    // Now, while genuinely idle between turns, the process dies for real. Even though this.turn is
    // null (same as the post-interrupt case), there was no interrupt for this generation, so this
    // must still go through crash() -> cold (with a crash record), not the clean-end path.
    c.throwNow(new Error("read ECONNRESET"));
    await new Promise((r) => setTimeout(r, 10));

    expect(brain.procState).toBe("cold");
    expect(c.closeCount()).toBeGreaterThan(0);
    expect(logs.some((l) => /ended cleanly/i.test(l.msg))).toBe(false);
  });
});
