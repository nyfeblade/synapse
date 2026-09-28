import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingAgentView, McpServerView, TranscriptEntry } from "@synapse/shared";
import type { HostConfig } from "../config";
import { createHostApp, type HostApp } from "../app";
import { tmpConfig } from "./helpers";

// Task 34 (Phase 5 fuzz pass): the gateway-level half of the Layer 2 abuse journeys. The Electron
// half is app/e2e/phase5-fuzz-journeys.e2e.ts; these are the cases the FUZZ app can't reach (a host
// restart keeps its store here) or where the engine rule matters more than the pixels.

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
const until = async (f: () => Promise<boolean> | boolean, ms = 8000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

async function start(cfg: HostConfig = tmpConfig()) {
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

describe("Phase 5 fuzz journeys (gateway level)", () => {
  it("TOOL-20 lifecycle: a restart while a coding agent runs marks it interrupted and revives its Bot", async () => {
    const cfg = tmpConfig();
    const s1 = await start(cfg);
    const { id } = await s1.api<{ id: string }>("createAgent", { name: "Fixer", isKickstartRequested: false });
    await app!.close();
    app = null;
    // What the registry holds when the host dies mid-run.
    const running: CodingAgentView = { id: "coding-00000000-crash", botId: id, title: "Fix the README", repo: "demo", branch: "bots/fix-the-readme-0000", worktree: path.join(cfg.workspace, "repos", "demo.worktrees", "x"), status: "running", startedAt: Date.now() - 60_000, endedAt: null, prUrl: null, summary: null };
    fs.writeFileSync(path.join(cfg.hostPrivate, "coding-agents.json"), JSON.stringify({ agents: [running] }));

    const s2 = await start(cfg);
    const [agent] = (await s2.api<{ agents: CodingAgentView[] }>("listCodingAgents", { id })).agents;
    expect(agent).toMatchObject({ id: running.id, status: "error", summary: "Interrupted by a restart of the computer's host." });
    expect(agent!.endedAt).not.toBeNull();
    // Revived: the coding-agent wake ran a (hidden) turn and the demo Bot answered it.
    await until(async () => (await s2.tail(id)).some((e) => e.kind === "send-message" && e.message.type === "text" && e.message.content === "Still here. Where were we?"));
  });

  it("K2 speed: two Add requests at once create one registry entry", async () => {
    const s = await start();
    await Promise.all([s.api("installPlugin", { id: "curated:linear" }), s.api("installPlugin", { id: "curated:linear" })]);
    const { servers } = await s.api<{ servers: McpServerView[] }>("listMcpServers");
    expect(servers.filter((x) => x.catalogId === "curated:linear")).toHaveLength(1);
  });

  it("K3 order: close the first OAuth tab, Reopen and sign in → the entry is no longer waiting for authorization", async () => {
    const s = await start();
    await s.api("installPlugin", { id: "curated:linear" });
    await s.api<{ authorizationUrl: string }>("startMcpAuth", { serverId: "linear" }); // tab 1: closed without signing in
    const { authorizationUrl } = await s.api<{ authorizationUrl: string }>("startMcpAuth", { serverId: "linear" }); // Reopen
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    expect(await s.api("completeMcpOAuth", { state, code: "fuzz" })).toEqual({ serverId: "linear", status: "connected" });
    // Read the entry itself, not getMarketplace: the view previews only the first few entries per
    // category, and once the Code category grew past that, Linear fell out of it.
    const { entry: linear } = await s.api<{ entry: { id: string; state: string } }>("getCatalogEntry", { id: "curated:linear" });
    expect(linear.id).toBe("curated:linear");
    expect(linear.state).not.toBe("waiting-auth");
  });

  it("LOC-04 speed: Allow once twice for one ask queues exactly one execution", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Piper", isKickstartRequested: false });
    await s.api("registerLocalComputer", { computer: { computerId: "mac", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/tmp" } });
    await s.api("localExecHeartbeat", { computerId: "mac" });
    await s.api("sendPrompt", { id, text: "local: echo once", clientNonce: "n1" });
    let askId = "";
    await until(async () => {
      const c = (await s.tail(id)).find((e) => e.kind === "send-message" && e.message.type === "card" && e.message.card.kind === "local-tool-permission");
      askId = c && c.kind === "send-message" && c.message.type === "card" && c.message.card.kind === "local-tool-permission" ? c.message.card.askId : "";
      return !!askId;
    });
    const both = await Promise.allSettled([
      s.api("resolveLocalToolPermission", { id, askId, choice: "once" }),
      s.api("resolveLocalToolPermission", { id, askId, choice: "once" }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 200));
    const { pending } = await s.api<{ pending: { execId: string }[] }>("localExecHeartbeat", { computerId: "mac" });
    expect(pending).toHaveLength(1);
  });

  it("TPL-01: a template you just shared is findable in the Marketplace search, and gone after Delete", async () => {
    const s = await start();
    const { id } = await s.api<{ id: string }>("createAgent", { name: "Courier", description: "Handles my inbox.", isKickstartRequested: false });
    const { draft } = await s.api<{ draft: unknown }>("draftTemplate", { id });
    const { template } = await s.api<{ template: { id: string } }>("exportTemplate", { id, manifest: draft });
    const hits = async () => (await s.api<{ bots: { id: string }[] }>("searchCatalog", { query: "Courier" })).bots.map((b) => b.id);
    expect(await hits()).toEqual([`tpl:${template.id}`]);
    await s.api("deleteTemplate", { templateId: template.id });
    expect(await hits()).toEqual([]);
  });

  it("input: http:// custom servers, file:/// marketplace sources and ../ paths in a .botpack are rejected", async () => {
    const s = await start();
    await expect(s.api("addMcpServer", { name: "Plain", url: "http://example.com/mcp" })).rejects.toThrow("Remote MCP servers must use https.");
    await expect(s.api("addPluginMarketplace", { source: "file:///etc" })).rejects.toThrow("Use a GitHub owner/repo or an https git URL.");
    const evil = zipSync({ "template.json": strToU8("{}"), "../../outside.txt": strToU8("x") });
    await expect(s.api("previewTemplateImport", { bytesBase64: Buffer.from(evil).toString("base64") })).rejects.toThrow("unsafe file names");
    expect((await s.api<{ servers: McpServerView[] }>("listMcpServers")).servers).toHaveLength(0);
  });
});
