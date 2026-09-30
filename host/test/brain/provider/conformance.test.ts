import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { badgesFor, ProviderEvidenceStore } from "../../../brain/provider/conformance/evidence";
import { CHECKS, runConformance } from "../../../brain/provider/conformance/checks";
import { costPer100, modelCatalogView, whatWorks } from "../../../brain/provider/catalog-view";
import { gate } from "../../../bench/coding/provider-gate";
import { setUsageSink, type MeteredRun } from "../../../usage/metered-query";
import { finish, reply, startFakeChatServer, textChunks, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "./fake-chat-server";
import { startProviderRuntime } from "./runtime";

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { setUsageSink(null); for (const c of closers.splice(0)) await c(); });

/** A provider that does everything ProviderBrain needs. `broken` turns one behaviour off. */
function conformant(broken: "" | "tools" | "usage" | "errors" = "") {
  let cacheSeen = false;
  return (r: FakeRequest): FakeReply => {
    if (String(r.headers.authorization).includes("conformance-invalid")) return { status: broken === "errors" ? 500 : 401, body: "{\"error\":{\"message\":\"Incorrect API key\"}}" };
    if (r.body.model === "synapse-no-such-model-pc10") return { status: 404, body: "{\"error\":{\"message\":\"The model does not exist\",\"code\":\"model_not_found\"}}" };
    const msgs = r.body.messages as { role: string; content: unknown }[];
    const last = msgs.at(-1)!;
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    const u = (p: number, c: number, cached = 0) => (broken === "usage" ? [] : [usageChunk(p, c, cached ? { prompt_tokens_details: { cached_tokens: cached }, prompt_cache_hit_tokens: cached } : {})]);
    if (r.body.response_format) return { sse: [...textChunks("{\"colour\":\"blue\"}"), finish("stop"), ...u(20, 5)] };
    if (last.role === "tool") return { sse: [...textChunks("Done."), finish("stop"), ...u(40, 2)] };
    if (text.includes("Count from 1")) return { sse: [...textChunks(Array.from({ length: 300 }, (_, i) => `${i + 1}`).join("\n"), 100), finish("stop"), ...u(20, 600)], chunkBytes: 50, delayMs: 10 };
    if (text.includes("call the echo tool twice")) return { sse: [...toolChunks([{ id: "a", name: "echo", args: { text: "a" } }, { id: "b", name: "echo", args: { text: "b" } }]), finish("tool_calls"), ...u(30, 10)] };
    if (text.includes("Call the echo tool")) {
      if (broken === "tools") return { sse: [...textChunks("ping"), finish("stop"), ...u(30, 1)] };
      return { sse: [...toolChunks([{ id: "e1", name: "echo", args: { text: "ping" } }]), finish("tool_calls"), ...u(30, 8)] };
    }
    if (text.includes("the quick brown fox")) { const c = cacheSeen ? 1200 : 0; cacheSeen = true; return { sse: [...textChunks("OK"), finish("stop"), ...u(1300, 1, c)] }; }
    if (text.includes("2 + 2")) return { sse: [...textChunks("4"), finish("stop"), ...u(10, 1)] };
    return broken === "usage" ? { sse: [...textChunks("OK"), finish("stop")] } : reply({ text: "OK", usage: [10, 1] });
  };
}
async function withProvider(script: (r: FakeRequest) => FakeReply) {
  const up = await startFakeChatServer(script);
  closers.push(() => up.close());
  const rt = await startProviderRuntime({ upstream: up.url });
  closers.push(rt.stop);
  const runs: MeteredRun[] = [];
  setUsageSink({ record: (r) => runs.push(r), lastTotals: () => null, noteTotals: () => {} });
  return { up, runs };
}

describe("provider conformance PC-01..15 (spec §11.1)", () => {
  it("names 15 checks", () => {
    expect(CHECKS.map((c) => c.id)).toEqual(Array.from({ length: 15 }, (_, i) => `PC-${String(i + 1).padStart(2, "0")}`));
  });

  it("a conformant provider passes every check, sets its flags, and every call is metered as conformance", async () => {
    const s = await withProvider(conformant());
    const r = await runConformance("openai:gpt-6.1-sol");
    const failed = r.results.filter((x) => x.status !== "pass");
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(r.mustPass).toBe(true);
    expect(r.flags).toEqual({ parallelTools: true, cachedTokens: true, vision: true, toolImages: true, reasoningEffort: true, structuredOutput: true, streamedArgs: true });
    expect(s.runs.length).toBeGreaterThan(10);
    expect(s.runs.every((x) => x.purpose === "conformance")).toBe(true);
  });

  it("the P2 providers (Mistral, DeepSeek) pass against the same fake, each in its own dialect", async () => {
    for (const ref of ["mistral:mistral-small-latest", "deepseek:deepseek-flash"]) {
      const s = await withProvider(conformant());
      const r = await runConformance(ref);
      const failed = r.results.filter((x) => x.status === "fail");
      expect(failed, `${ref} ${JSON.stringify(failed)}`).toEqual([]);
      expect(r.mustPass, ref).toBe(true);
      const first = s.up.requests[0]!.body;
      if (ref.startsWith("mistral")) expect(first).not.toHaveProperty("stream_options"); // Mistral streams usage on its own
      else expect(first).toMatchObject({ stream_options: { include_usage: true } });
      expect(r.flags.cachedTokens, ref).toBe(true);
      expect(r.results.find((x) => x.id === "PC-12")!.status, ref).toBe("skip"); // neither takes reasoning_effort here
      await s.up.close();
    }
  });

  it("a provider that can't call tools, doesn't report usage, or misreports errors fails a must-pass check and is blocked", async () => {
    for (const broken of ["tools", "usage", "errors"] as const) {
      const s = await withProvider(conformant(broken));
      const r = await runConformance("openai:gpt-6.1-sol");
      expect(r.mustPass, broken).toBe(false);
      expect(badgesFor(r.ref, r, null), broken).toEqual(["blocked"]);
      await s.up.close();
    }
  });

  it("a partial run (a live sample) never clears a model", async () => {
    await withProvider(conformant());
    const r = await runConformance("openai:gpt-6.1-sol", { only: ["PC-01", "PC-02"] });
    expect(r.results.filter((x) => x.status === "pass").map((x) => x.id)).toEqual(["PC-01", "PC-02"]);
    expect(r.mustPass).toBe(false);
  });
});

describe("badges come from measured evidence only", () => {
  const pc = (mustPass: boolean) => ({ ref: "openai:gpt-6.1-sol", at: 1, version: 1, results: [{ id: "PC-02" as const, status: "pass" as const, detail: "", ms: 1 }], mustPass, flags: { parallelTools: true, cachedTokens: true, vision: true, toolImages: true, reasoningEffort: true, structuredOutput: true, streamedArgs: true } });
  const bench = (passed: boolean, trapsOk = true) => ({ ref: "openai:gpt-6.1-sol", at: 1, passRate: 0.8, claudePassRate: 0.9, ratio: 0.89, trapsOk, passed, tasks: 13, report: "" });
  it("Not checked → Experimental (conformance) → Supported (bench gate); a failure blocks; Local marks this Mac", () => {
    expect(badgesFor("openai:gpt-6.1-sol", null, null)).toEqual(["unchecked"]);
    expect(badgesFor("openai:gpt-6.1-sol", pc(true), null)).toEqual(["experimental"]);
    expect(badgesFor("openai:gpt-6.1-sol", pc(true), bench(false))).toEqual(["experimental"]);
    expect(badgesFor("openai:gpt-6.1-sol", pc(true), bench(true))).toEqual(["supported"]);
    expect(badgesFor("openai:gpt-6.1-sol", pc(true), bench(true, false))).toEqual(["blocked"]);
    expect(badgesFor("openai:gpt-6.1-sol", pc(false), bench(true))).toEqual(["blocked"]);
    expect(badgesFor("ollama:qwen3:4b", null, null)).toEqual(["unchecked", "local"]);
    // Ruling 48: a Claude model is the reference, so it carries no badge at all.
    expect(badgesFor("claude-sonnet-5", null, null)).toEqual([]);
  });

  it("the catalog view groups by provider, Claude first, with badges and What works from the evidence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ev = new ProviderEvidenceStore(path.join(dir, "e.json"));
    ev.saveConformance(pc(true));
    ev.saveBench(bench(true));
    const v = modelCatalogView({ claudeModels: () => ["claude-sonnet-5"], usable: (p) => p === "openai" || p === "ollama", evidence: ev, reviewerQualified: () => false, extraModels: (p) => (p === "ollama" ? ["qwen3:4b"] : []) });
    expect(v.groups.map((g) => g.label)).toEqual(["Anthropic", "OpenAI", "Ollama"]);
    expect(v.groups[0]!.models[0]!.badges).toEqual([]); // ruling 48
    expect(v.groups[1]!.searchable).toBeUndefined();
    expect(v.groups[1]!.models.find((m) => m.ref === "openai:gpt-6.1-sol")!.price).toEqual({ input: 2, output: 10 });
    expect(v.groups[2]!.models[0]!.price).toBeUndefined(); // local: free, no price row
    const sol = v.groups[1]!.models.find((m) => m.ref === "openai:gpt-6.1-sol")!;
    expect(sol).toMatchObject({ label: "GPT-6.1 Sol", badges: ["supported"], contextWindow: 1_050_000 });
    expect(v.groups[1]!.models.find((m) => m.ref === "openai:gpt-6-astra")!.badges).toEqual(["unchecked"]);
    expect(v.groups[2]!.models[0]).toMatchObject({ ref: "ollama:qwen3:4b", badges: ["unchecked", "local"] });
    expect(Object.fromEntries(sol.whatWorks.map((w) => [w.label, w.state]))).toEqual({ "Tools and replies": "yes", "Auto-review": "asks", "Web search": "yes", Images: "yes", "Voice calls": "yes", "Coding agents": "no", Subagents: "yes" });
    expect(whatWorks("ollama:qwen3:4b", { usable: () => false, evidence: ev, reviewerQualified: () => true }).find((w) => w.label === "Web search")!.state).toBe("no");
    // Gemini's search grounding is fake-tested only: Experimental, on Gemini and on a Bot that would borrow it.
    const search = (ref: string, usable: (p: string) => boolean) => whatWorks(ref, { usable, evidence: ev, reviewerQualified: () => true }).find((w) => w.label === "Web search")!.state;
    expect(search("gemini:gemini-3.8-flash", (p) => p === "gemini")).toBe("experimental");
    expect(search("gemini:gemini-3.8-flash", (p) => p === "gemini" || p === "openai")).toBe("experimental"); // a Gemini Bot searches with Gemini
    expect(search("mistral:mistral-medium-latest", (p) => p === "mistral" || p === "gemini")).toBe("experimental");
    expect(search("mistral:mistral-medium-latest", (p) => p === "mistral" || p === "gemini" || p === "openai")).toBe("yes"); // borrows OpenAI first
    expect(search("deepseek:deepseek-flash", (p) => p === "deepseek")).toBe("no");
  });

  it("OpenRouter: every tool-taking model on its live list is offered, Not checked, with the live price, and searchable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ev = new ProviderEvidenceStore(path.join(dir, "e.json"));
    // A fake live list: 3 models, one without tools, one already used by a Bot.
    const live = [
      { ref: "openrouter:maker/big", name: "Maker: Big", price: { input: 3, cachedInput: 0.3, output: 15 }, tools: true },
      { ref: "openrouter:maker/no-tools", name: "Maker: No tools", price: { input: 0, cachedInput: 0, output: 0 }, tools: false },
      { ref: "openrouter:other/used", name: "Other: Used", price: { input: 0.1, cachedInput: 0.1, output: 0.4 }, tools: null },
    ];
    const base = { claudeModels: () => [], evidence: ev, reviewerQualified: () => false, extraModels: (p: string) => (p === "openrouter" ? ["other/used"] : []), liveModels: (p: string) => (p === "openrouter" ? live : []) };
    // No OpenRouter key saved and consented: no group, whatever the list says.
    expect(modelCatalogView({ ...base, usable: () => false }).groups).toEqual([]);
    const v = modelCatalogView({ ...base, usable: (p) => p === "openrouter" });
    const g = v.groups.find((x) => x.provider === "openrouter")!;
    expect(g.searchable).toBe(true);
    expect(g.models.map((m) => [m.ref, m.label, m.badges, m.price, m.liveOnly ?? false])).toEqual([
      ["openrouter:other/used", "Other: Used", ["unchecked"], { input: 0.1, output: 0.4 }, false],
      ["openrouter:maker/big", "Maker: Big", ["unchecked"], { input: 3, output: 15 }, true],
    ]);
    // Without a live list yet, the used model is still there (as before), and there is no search box.
    const cold = modelCatalogView({ ...base, liveModels: () => [], usable: (p) => p === "openrouter" }).groups[0]!;
    expect(cold.models.map((m) => m.ref)).toEqual(["openrouter:other/used"]);
    expect(cold.searchable).toBeUndefined();
  });

  it("cost preview: the median turn priced on the chosen model, per 100 turns", () => {
    const turns = [
      { inputTokens: 2_000, cacheReadTokens: 20_000, cacheWriteTokens: 0, outputTokens: 400 },
      { inputTokens: 3_000, cacheReadTokens: 30_000, cacheWriteTokens: 0, outputTokens: 600 },
      { inputTokens: 90_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 9_000 },
    ];
    // medians: input 3,000, cached 20,000, output 600; GPT-6.1 Sol is $2 in, $0.10 cached, $10 out
    expect(costPer100("openai:gpt-6.1-sol", turns)).toBeCloseTo(100 * (3000 * 2 + 20000 * 0.1 + 600 * 10) / 1e6, 2);
    expect(costPer100("ollama:qwen3:4b", turns)).toBe(0);
    expect(costPer100("openai:gpt-6.1-sol", [])).toBeNull();
    expect(costPer100("claude-sonnet-5", turns)).toBeGreaterThan(0);
  });
});

describe("the coding-bench gate (spec §11.2)", () => {
  const rep = (ok: Record<string, boolean>) => ({ results: Object.entries(ok).map(([taskId, success]) => ({ taskId, runner: "synapse", success })) });
  it("passes at 85% of Claude's pass rate with every trap task passing; fails otherwise", () => {
    const claude = rep({ T01: true, T02: true, T03: true, T04: true, T05: true, T06: false });
    expect(gate("openai:x", rep({ T01: true, T02: true, T03: true, T04: true, T05: false, T06: false }), claude)).toMatchObject({ ratio: expect.closeTo(0.8, 6), passed: false });
    const g = gate("openai:x", rep({ T01: true, T02: true, T03: true, T04: true, T05: true, T06: false }), claude);
    expect(g).toMatchObject({ ratio: 1, trapsOk: true, passed: true, tasks: 6 });
    // T02 is a trap task (suite.ts): failing it blocks, whatever the rate
    expect(gate("openai:x", rep({ T01: true, T02: false, T03: true, T04: true, T05: true, T06: true }), claude)).toMatchObject({ trapsOk: false, passed: false });
  });
});
