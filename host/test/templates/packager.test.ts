import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readBotpack, writeBotpack } from "../../templates/botpack";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import type { BrainWiring } from "../../brain/types";
import { StubTemplateDrafter } from "../../templates/drafter";
import { TemplatePackager, readFacts } from "../../templates/packager";
import { createTemplateTool } from "../../tools/template-tool";

let root: string;
let packager: TemplatePackager;
const kv = new Map<string, unknown>();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-"));
  kv.clear();
  const cfg = { dataRoot: path.join(root, "agent-data"), claudeConfigDir: path.join(root, "claude"), workspace: path.join(root, "workspace") } as never;
  const bot = path.join(root, "agent-data", "agents", "b1");
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  w(path.join(bot, "memory", "profile.md"), "# Profile\n- (2026-09-01) The user prefers short summaries.\n- (2026-09-01) The user's wife is Maya and her number is 555-201-3344.\n");
  w(path.join(bot, "memory", "log", "2026-09.md"), "- (2026-09-10) [note] Standups moved to 10 AM.\n");
  w(path.join(bot, "automations", "r1", "automation.json"), JSON.stringify({ name: "Morning sweep", prompt: "Sweep the inbox", schedule: "0 8 * * *", enabled: true }));
  w(path.join(bot, "enabled-workflows.json"), JSON.stringify({ disabled: ["secret-skill"] }));
  w(path.join(root, "claude", "skills", "weekly-report", "SKILL.md"), "---\nname: weekly-report\ndescription: Writes the weekly report\n---\nSteps\n");
  w(path.join(root, "claude", "skills", "weekly-report", "fetch.py"), "print(1)\n");
  w(path.join(root, "claude", "skills", "secret-skill", "SKILL.md"), "---\nname: secret-skill\ndescription: x\n---\n");
  w(path.join(root, "claude", "skills", "private-one", "SKILL.md"), "---\nname: private-one\ndescription: y\nprivate: true\n---\n");
  const bots = {
    summary: () => ({ id: "b1", profile: { name: "Courier", title: "Inbox", description: "Handles my inbox.", avatarShape: "orb", avatarColor: "#3472d9", avatarKind: "shape", model: "claude-opus-5" } }),
    require: () => ({ store: { getKv: (k: string, fb: unknown) => kv.get(k) ?? fb, setKv: (k: string, v: unknown) => kv.set(k, v) } }),
    sessionId: () => null,
  } as never;
  packager = new TemplatePackager({ cfg, bots, drafter: new StubTemplateDrafter(), plugins: () => [{ catalogId: "curated:linear", name: "Linear" }], author: () => ({ name: "Alex" }), now: () => 7 });
});

describe("botpack", () => {
  it("round-trips and rejects unsafe paths and missing template.json", () => {
    const template = { id: "0b6f1c1e-4a57-4c3e-9f7e-1d2c3b4a5f60", name: "Courier", sourceBotId: "b1", visibility: "local" as const, createdAt: 1, updatedAt: 1, manifest: { profile: { name: "Courier", title: "", description: "", avatarShape: "orb" as const, avatarColor: "#fff" }, skills: [], memories: [], routines: [], plugins: [] } };
    const bytes = writeBotpack({ template, skills: { s: { "SKILL.md": new TextEncoder().encode("x") } }, memoriesMd: "- a\n", avatar: null });
    expect(readBotpack(bytes).template.name).toBe("Courier");
    expect(readBotpack(bytes).skills.s!["SKILL.md"]).toBeTruthy();
    expect(() => readBotpack(new Uint8Array([1, 2, 3]))).toThrow(/isn't a Bot template/);
  });

  it("rejects zip-slip / path-traversal entries (dot-only segments), even when template.json is otherwise present", () => {
    const template = { id: "0b6f1c1e-4a57-4c3e-9f7e-1d2c3b4a5f60", name: "Courier", sourceBotId: "b1", visibility: "local" as const, createdAt: 1, updatedAt: 1, manifest: { profile: { name: "Courier", title: "", description: "", avatarShape: "orb" as const, avatarColor: "#fff" }, skills: [], memories: [], routines: [], plugins: [] } };
    const malicious = zipSync({
      "template.json": strToU8(JSON.stringify(template)),
      "skills/../../../../etc/passwd": strToU8("pwned"),
    });
    expect(() => readBotpack(malicious)).toThrow(/unsafe file names/);
    expect(() => readBotpack(zipSync({ "../../outside.txt": strToU8("x") }))).toThrow(/unsafe file names/);
    expect(() => readBotpack(zipSync({ "skills/./x.md": strToU8("x") }))).toThrow(/unsafe file names/);
  });
});

describe("TemplatePackager (TPL-01 packaging rules)", () => {
  it("reads §4.3 fact lines", () => {
    expect(readFacts(path.join(root, "agent-data", "agents", "b1", "memory"))).toEqual(["The user prefers short summaries.", "The user's wife is Maya and her number is 555-201-3344.", "Standups moved to 10 AM."]);
  });

  it("drafts: filters personal memories, excludes disabled/private skills and code, disables routines, keeps first-party plugins", async () => {
    const m = await packager.draft("b1");
    expect(m.profile).toMatchObject({ name: "Courier", title: "Inbox", model: "claude-opus-5" });
    expect(m.memories).toEqual(["The user prefers short summaries.", "Standups moved to 10 AM."]);
    expect(m.skills.map((s) => s.id)).toEqual(["weekly-report"]);
    expect(m.routines).toEqual([{ name: "Morning sweep", prompt: "Sweep the inbox", schedule: "0 8 * * *" }]);
    expect(m.plugins).toEqual([{ catalogId: "curated:linear", name: "Linear" }]);
  });

  it("exports a record + .botpack (skills without scripts), updates in place, deletes", async () => {
    const m = await packager.draft("b1");
    const r = packager.export("b1", m);
    expect(r.fileName).toBe("courier.botpack");
    expect(r.template).toMatchObject({ name: "Courier", author: { name: "Alex" }, sourceBotId: "b1", visibility: "local" });
    const pack = readBotpack(r.bytes);
    expect(Object.keys(pack.skills["weekly-report"]!)).toEqual(["SKILL.md"]);
    expect(pack.memoriesMd).toContain("Standups moved to 10 AM.");
    expect(packager.get("b1")!.id).toBe(r.template.id);
    const again = packager.export("b1", { ...m, memories: [] });
    expect(again.template.id).toBe(r.template.id);
    packager.delete(r.template.id);
    expect(packager.get("b1")).toBeNull();
  });

  it("the Template tool writes into /workspace/templates (ORIG-17)", async () => {
    const t = createTemplateTool({ botId: "b1", packager, workspace: path.join(root, "workspace") });
    const res = await t.handler({ action: "export", agent_id: "b1" });
    expect(res.text).toMatch(/Saved the template to .*workspace\/templates\/courier\.botpack/);
    expect(fs.existsSync(path.join(root, "workspace", "templates", "courier.botpack"))).toBe(true);
  });

  it("the Template tool's schema survives the real MCP tools/list round-trip (mcpfix pattern)", async () => {
    const t = createTemplateTool({ botId: "b1", packager, workspace: path.join(root, "workspace") });
    const server = toSdkMcpServer({ botTools: () => [t] } as unknown as BrainWiring);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((x) => x.name)).toEqual(["Template"]);
      const template = listed.tools[0]!;
      expect(Object.keys(template.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["action", "agent_id"]));
    } finally {
      await client.close();
    }
  });
});
