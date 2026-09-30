import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STRC, modelLabel, type CodingAgentView, type ProviderId, type ProvidersView, type TranscriptEntry } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { credentialsReady } from "../../auth/auth-env";
import { ProviderEvidenceStore } from "../../brain/provider/conformance/evidence";
import { sealTo } from "../../secrets/crypto";
import { tmpConfig } from "../helpers";
import { finish, reply, startFakeChatServer, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "../brain/provider/fake-chat-server";

/**
 * "Any model can be a coding model in Engineering mode" (owner direction 2026-09-30), end to end in the real host with
 * no Anthropic key: a Bot on a fake OpenAI, Gemini or local (Ollama) provider, Engineering mode on, fixes a bug the way
 * an engineer does — plans (TodoWrite), reads, edits, runs the tests (Shell), reports — on Synapse's own engineering
 * prompt; and hands a repository task to a coding agent that runs on the same model (provider-loop). A model that
 * failed its tool-use check is never blocked: it gets one quiet note and works.
 */
let app: HostApp | null = null;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await app?.close(); app = null; for (const c of closers.splice(0)) await c(); });
const until = async (f: () => boolean, ms = 20_000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };

type Msg = { role: string; content: unknown; tool_calls?: { function: { name: string; arguments: string } }[] };
let n = 0;
const call = (name: string, args: Record<string, unknown>): FakeReply => ({ sse: [...toolChunks([{ id: `c${++n}`, name, args }]), finish("tool_calls"), usageChunk(2000, 30)] });

/** The scripted model: an engineering-mode Bot turn, a coding agent, or a helper call. */
function model(proj: string, repo: string) {
  return (req: FakeRequest): FakeReply => {
    if (req.path.endsWith("/models") || req.path.endsWith("/api/tags")) return { status: 200, body: "{\"data\":[],\"models\":[]}" };
    const body = JSON.stringify(req.body);
    const msgs = (req.body.messages ?? []) as Msg[];
    const tools = ((req.body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    if (!tools.length) return reply({ text: body.includes("BOT_MEMORY_EXTRACTION") ? "NONE" : "{}" });
    const lastCall = [...msgs].reverse().find((m) => m.role === "assistant" && m.tool_calls?.length)?.tool_calls?.[0]?.function.name;
    const last = msgs.at(-1)!;
    // A coding agent (provider-loop): Synapse's coding prompt and the coding tools, no SendMessage.
    if (String((msgs[0] as { content: string }).content).includes("You are a coding agent inside Synapse.")) {
      if (last.role === "user") return call("Read", { file_path: "src/add.js" });
      if (lastCall === "Read") return call("Edit", { file_path: "src/add.js", old_string: "a - b", new_string: "a + b" });
      if (lastCall === "Edit") return call("Bash", { command: "sh test.sh && git add -A && git -c user.name=t -c user.email=t@t commit -qm 'Fix add'" });
      return reply({ text: "Fixed add in src/add.js; sh test.sh: 1 passed; committed \"Fix add\"." });
    }
    // The Bot's own engineering turn.
    if (last.role === "user" && String(last.content).includes("coding agent")) return call("CodingAgent", { action: "launch", repo: `file://${repo}`, task: "add(2, 3) returns -1. Fix it and run the tests.", title: "Fix add" });
    if (last.role === "user" && String(last.content).includes("Fix the add bug")) return call("TodoWrite", { todos: [{ content: "Find the bug", status: "in_progress", activeForm: "Finding the bug" }, { content: "Fix it and run the tests", status: "pending", activeForm: "Fixing" }] });
    if (lastCall === "TodoWrite") return call("Read", { file_path: path.join(proj, "src/add.js") });
    if (lastCall === "Read") return call("Edit", { file_path: path.join(proj, "src/add.js"), old_string: "a - b", new_string: "a + b" });
    if (lastCall === "Edit") return call("Shell", { command: "sh test.sh", working_directory: proj });
    if (lastCall === "Shell") return call("SendMessage", { content: "Fixed add (it subtracted). sh test.sh: 1 passed." });
    if (lastCall === "CodingAgent" && last.role === "tool") return call("SendMessage", { content: "A coding agent is on it." });
    if (lastCall === "SendMessage" || lastCall === "CodingAgent") return { sse: [finish("stop"), usageChunk(2100, 1)] };
    return reply({ text: "" });
  };
}

function writeProject(dir: string): void {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/add.js"), "exports.add = (a, b) => a - b;\n");
  // A shell test (the Bots' Shell runs with the computer's own PATH, which a test host may not give node).
  fs.writeFileSync(path.join(dir, "test.sh"), "grep -q 'a + b' src/add.js && echo '1 passed' || { echo 'FAIL add(2, 3) = -1'; exit 1; }\n");
}

const PROVIDERS: { provider: Exclude<ProviderId, "anthropic">; ref: string }[] = [
  { provider: "openai", ref: "openai:gpt-6.1-sol" },
  { provider: "gemini", ref: "gemini:gemini-3.8-flash" },
  { provider: "ollama", ref: "ollama:qwen3:4b" },
];

async function start(provider: Exclude<ProviderId, "anthropic">, ref: string, o: { failedToolUse?: boolean } = {}) {
  const cfg = tmpConfig();
  const proj = path.join(cfg.workspace, "calc");
  writeProject(proj);
  const repo = path.join(path.dirname(cfg.workspace), "origin-calc");
  writeProject(repo);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-qm", "start");
  if (o.failedToolUse) {
    fs.mkdirSync(cfg.hostPrivate, { recursive: true, mode: 0o700 });
    new ProviderEvidenceStore(path.join(cfg.hostPrivate, "provider-evidence.json")).saveConformance({
      ref, at: Date.now(), version: 1, mustPass: false,
      results: [{ id: "PC-01", status: "pass", detail: "", ms: 1 }, { id: "PC-02", status: "fail", detail: "no tool call came back", ms: 1 }],
      flags: { parallelTools: null, cachedTokens: null, vision: null, toolImages: null, reasoningEffort: null, structuredOutput: null, streamedArgs: null },
    });
  }
  const up = await startFakeChatServer(model(proj, repo));
  closers.push(() => up.close());
  app = await createHostApp(cfg, { providerUpstream: (p) => (p === provider ? up.url : undefined) });
  expect(credentialsReady()).toBe(false);
  const h = app.handlers as Record<string, (a: unknown) => Promise<unknown>>;
  const v = (await h.getProviders!({})) as ProvidersView;
  const row = v.providers.find((x) => x.id === provider)!;
  await h.consentProvider!({ provider, textVersion: row.consentVersion });
  if (provider !== "ollama") await h.setProviderKey!({ provider, sealed: await sealTo(v.boxPublicKey, `sk-${provider}-0123456789abcdef`) });
  const { id } = (await h.createAgent!({ name: "Ada", isKickstartRequested: false })) as { id: string };
  await h.updateAgent!({ id, model: ref });
  await h.setAgentPermMode!({ id, mode: "full-auto" });
  await h.setAgentEngineeringMode!({ id, enabled: true });
  const texts = () => app!.services.bots.tail(id, 300).flatMap((e: TranscriptEntry) => (e.kind === "send-message" && e.message.type === "text" ? [e.message.content] : []));
  return { cfg, id, h, up, proj, repo, texts };
}

describe("Engineering mode and coding agents on any model (no Anthropic key)", () => {
  for (const { provider, ref } of PROVIDERS) {
    it(`${provider}: plan, read, edit, run the tests, report — on Synapse's engineering prompt`, async () => {
      const s = await start(provider, ref);
      await s.h.sendPrompt!({ id: s.id, text: "Fix the add bug in the calc project and run its tests.", clientNonce: "e1" });
      await until(() => s.texts().includes("Fixed add (it subtracted). sh test.sh: 1 passed.") && app!.services.runner.isIdle(s.id));
      expect(fs.readFileSync(path.join(s.proj, "src/add.js"), "utf8")).toBe("exports.add = (a, b) => a + b;\n");
      const turn = s.up.requests.filter((r) => ((r.body.tools ?? []) as { function: { name: string } }[]).some((t) => t.function.name === "SendMessage"));
      const system = String(((turn[0]!.body.messages as Msg[])[0]!).content);
      expect(system).toContain("Right now you are working as a software engineer.");
      expect(system).toContain("Your system prompt is Synapse's engineering prompt");
      expect(system).not.toContain("Claude Code");
      expect(system).not.toContain("you are in standard mode");
      const tools = (turn[0]!.body.tools ?? []) as { function: { name: string; description: string } }[];
      const names = tools.map((t) => t.function.name);
      for (const t of ["Read", "Write", "Edit", "Glob", "Grep", "Shell", "CodingAgent", "ToolSearch"]) expect(names, t).toContain(t);
      // 0.1.8: the rarely used tools wait behind ToolSearch, names listed (the Claude Code path's lean profile).
      expect(names).not.toContain("TodoWrite");
      expect(tools.find((t) => t.function.name === "ToolSearch")!.function.description).toContain("TodoWrite");
      // The test run's output went back to the model.
      const toolOut = turn.flatMap((r) => (r.body.messages as Msg[]).filter((m) => m.role === "tool").map((m) => String(m.content)));
      expect(toolOut.some((t) => /1 passed[\s\S]*exit code 0/.test(t))).toBe(true);
    }, 60_000);
  }

  it("openai: a coding agent runs on the Bot's own model (provider-loop), commits on its branch, and its card settles done", async () => {
    const s = await start("openai", "openai:gpt-6.1-sol");
    await s.h.sendPrompt!({ id: s.id, text: "Have a coding agent fix the add bug in the calc repo.", clientNonce: "e2" });
    await until(() => ((app!.handlers as Record<string, (a: unknown) => { agents: CodingAgentView[] }>).listCodingAgents!({ id: s.id }).agents[0]?.status ?? "running") !== "running", 30_000);
    const a = (app!.handlers as Record<string, (a: unknown) => { agents: CodingAgentView[] }>).listCodingAgents!({ id: s.id }).agents[0]!;
    expect(a).toMatchObject({ status: "done", engine: "provider-loop", model: "openai:gpt-6.1-sol", summary: "Fixed add in src/add.js; sh test.sh: 1 passed; committed \"Fix add\"." });
    expect(fs.readFileSync(path.join(a.worktree, "src/add.js"), "utf8")).toBe("exports.add = (a, b) => a + b;\n");
    expect(execFileSync("git", ["-C", a.worktree, "log", "--format=%s", "-1"]).toString().trim()).toBe("Fix add");
    // Every one of the agent's model calls went to OpenAI, on the Bot's model, metered as coding.
    const agentCalls = s.up.requests.filter((r) => String(((r.body.messages as Msg[])?.[0] as { content?: string })?.content ?? "").includes("You are a coding agent inside Synapse."));
    expect(agentCalls.length).toBe(4);
    for (const r of agentCalls) expect(r.body.model).toBe("gpt-6.1-sol");
    const usage = (await s.h.getUsageDashboard!({})) as unknown;
    expect(JSON.stringify(usage)).toContain("coding");
  }, 60_000);

  it("never blocked by a failed tool-use check: Engineering mode and coding agents still run, with one quiet note", async () => {
    const s = await start("ollama", "ollama:qwen3:4b", { failedToolUse: true });
    const trays = () => app!.services.trays.list().filter((t) => t.title === STRC.toolUseCheckFailedTitle);
    expect(trays()).toHaveLength(1); // turning Engineering mode on
    await s.h.sendPrompt!({ id: s.id, text: "Fix the add bug in the calc project and run its tests.", clientNonce: "e3" });
    await until(() => s.texts().includes("Fixed add (it subtracted). sh test.sh: 1 passed.") && app!.services.runner.isIdle(s.id));
    await s.h.sendPrompt!({ id: s.id, text: "Have a coding agent fix the add bug in the calc repo.", clientNonce: "e4" });
    await until(() => ((app!.handlers as Record<string, (a: unknown) => { agents: CodingAgentView[] }>).listCodingAgents!({ id: s.id }).agents[0]?.status ?? "running") === "done", 30_000);
    expect(trays()).toHaveLength(1); // once per Bot and model, not per launch
    expect(trays()[0]!.detail).toBe(STRC.toolUseCheckFailed(modelLabel("ollama:qwen3:4b")));
  }, 60_000);
});
