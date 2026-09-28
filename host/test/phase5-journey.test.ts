import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerView, TranscriptEntry, UsageView } from "@synapse/shared";
import { createHostApp, type HostApp } from "../app";
import { tmpConfig } from "./helpers";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
const until = async (f: () => Promise<boolean> | boolean, ms = 8000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

async function start() {
  const cfg = tmpConfig();
  app = await createHostApp(cfg);
  const { port } = await app.listen();
  const api = async <T>(cmd: string, args: unknown = {}): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
    if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
    return j.result as T;
  };
  const tail = async (id: string) => (await api<{ entries: TranscriptEntry[] }>("getAgentTranscriptTail", { id })).entries;
  return { cfg, api, tail };
}

describe("Phase 5 journey on FakeBrain (gateway level)", () => {
  it("Marketplace: add a curated connector, authorize through the loopback flow, toggle a tool", async () => {
    const s = await start();
    const view = await s.api<{ categories: { name: string }[] }>("getMarketplace");
    expect(view.categories.map((c) => c.name)).toContain("Code");
    const inst = await s.api<{ needsAuth: boolean; serverIds: string[] }>("installPlugin", { id: "curated:linear" });
    expect(inst).toMatchObject({ needsAuth: true, serverIds: ["linear"] });
    const { authorizationUrl } = await s.api<{ authorizationUrl: string }>("startMcpAuth", { serverId: "linear" });
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    expect(await s.api("completeMcpOAuth", { state, code: "fuzz" })).toEqual({ serverId: "linear", status: "connected" });
    const { servers } = await s.api<{ servers: McpServerView[] }>("listMcpServers");
    const linear = servers.find((x) => x.id === "linear")!;
    expect(linear.status).toBe("connected");
    expect(linear.tools.map((t) => t.name)).toContain("list_items");
    await s.api("setMcpToolEnabled", { serverId: "linear", tool: "delete_item", enabled: false });
    expect(app!.services.phase5.mcpServers("any").linear).toBeTruthy();
  });

  it("ruling B: the Bot CLI's managed skills plugins come from the marketplace store (none before an install)", async () => {
    await start();
    expect(app!.services.phase5.cliPlugins()).toEqual([]);
  });

  it("a Bot turn records usage and a local command needs the Mac (LOC-06) then runs after Allow once", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Piper", isKickstartRequested: false });
    await s.api("sendPrompt", { id, text: "hello", clientNonce: "n1" });
    await until(async () => (await s.api<UsageView>("getUsage")).rows.length > 0);
    expect((await s.api<UsageView>("getUsage")).rows[0]).toMatchObject({ botId: id, turns: 1 });
    await s.api("registerLocalComputer", { computer: { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/tmp" } });
    await s.api("localExecHeartbeat", { computerId: "mac" });
    await s.api("sendPrompt", { id, text: "local: echo hi", clientNonce: "n2" });
    let askId = "";
    await until(async () => {
      const card = (await s.tail(id)).find((e) => e.kind === "send-message" && e.message.type === "card" && e.message.card.kind === "local-tool-permission");
      askId = card && card.kind === "send-message" && card.message.type === "card" && card.message.card.kind === "local-tool-permission" ? card.message.card.askId : "";
      return !!askId;
    });
    await s.api("resolveLocalToolPermission", { id, askId, choice: "once" });
    let execId = "";
    await until(async () => { execId = (await s.api<{ pending: { execId: string }[] }>("localExecHeartbeat", { computerId: "mac" })).pending[0]?.execId ?? ""; return !!execId; });
    await s.api("localExecOutput", { execId, stream: "stdout", chunk: "hi\n" });
    await s.api("localExecDone", { execId, exitCode: 0 });
    await until(async () => (await s.tail(id)).some((e) => e.kind === "send-message" && e.message.type === "text" && e.message.content === "Done on your Mac."));
  });

  it("templates round-trip: draft → export → preview → Add Bot, with sourceTemplateId and the Added state", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Courier", description: "Handles my inbox.", isKickstartRequested: false });
    const { draft } = await s.api<{ draft: unknown }>("draftTemplate", { id });
    const exp = await s.api<{ bytesBase64: string; fileName: string }>("exportTemplate", { id, manifest: draft });
    expect(exp.fileName).toBe("courier.botpack");
    const prev = await s.api<{ token: string; thirdParty: boolean }>("previewTemplateImport", { bytesBase64: exp.bytesBase64 });
    const { id: copy } = await s.api<{ id: string }>("importTemplate", { token: prev.token });
    expect(copy).not.toBe(id);
    const starter = await s.api<{ token: string }>("previewTemplateImport", { starterId: "starter:inbox-triage" });
    await s.api("importTemplate", { token: starter.token });
    const view = await s.api<{ fromTeam: { id: string; state: string }[] }>("getMarketplace");
    expect(view.fromTeam.find((e) => e.id === "starter:inbox-triage")!.state).toBe("added");
  });

  it("avatar Generate, voice settings, memory mode, onboarding and the coding agent are wired", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Fixer", isKickstartRequested: false });
    expect((await s.api<{ svg: string }>("generateAgentAvatar", { id, prompt: "a red triangle" })).svg).toMatch(/^<svg/);
    await s.api("setAgentVoice", { id, speechRate: 1.5 });
    expect((await s.api<{ memoryMode: string }>("setMemoryMode", { mode: "dreaming" })).memoryMode).toBe("dreaming");
    expect((await s.api<{ memoryMode: string }>("getPhase5Settings")).memoryMode).toBe("dreaming");
    expect(await s.api("getOnboarding")).toEqual({ hasSeenOnboarding: false, tokenConfigured: false });
    const repo = path.join(s.cfg.workspace, "repos", "demo");
    fs.mkdirSync(repo, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "init", "-q", "-b", "main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "demo\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
    await s.api("sendPrompt", { id, text: "code: demo", clientNonce: "c1" });
    await until(async () => (await s.api<{ agents: { status: string }[] }>("listCodingAgents", { id })).agents[0]?.status === "done");
  });
});
