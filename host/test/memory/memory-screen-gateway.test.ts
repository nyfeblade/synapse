import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryListView } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { tmpConfig } from "../helpers";

// "Built but unwired" is this repo's other recurring class: the memory commands are tested as parts in
// memory-commands.test.ts; this drives them through the REAL host app's gateway, over HTTP, and reads
// the files the Bot's prompt is rendered from.

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("memory screen through the real gateway (MEM-09, designed)", () => {
  it("add, edit, delete and clear each reach the Bot's memory files", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const { port } = await app.listen();
    const api = async <T>(cmd: string, args: unknown): Promise<T> => {
      const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
      const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
      if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
      return j.result as T;
    };
    const { id } = await api<{ id: string }>("createAgent", { name: "Piper", isKickstartRequested: false });
    const profile = path.join(cfg.dataRoot, "agents", id, "memory", "profile.md");
    const scope = { kind: "agent" };

    await api("addAgentMemory", { id, scope, content: "Lives in Denver", tier: "profile" });
    expect(fs.readFileSync(profile, "utf8")).toContain("Lives in Denver");
    const [f] = (await api<MemoryListView>("getAgentMemories", { id, scope })).facts;
    expect(f?.content).toBe("Lives in Denver");

    await api("updateAgentMemory", { id, scope, factId: f!.id, content: "Lives in Boulder" });
    expect(fs.readFileSync(profile, "utf8")).toContain("Lives in Boulder");
    expect(fs.readFileSync(profile, "utf8")).not.toContain("Denver");

    const g = (await api<MemoryListView>("getAgentMemories", { id, scope })).facts[0]!;
    await api("deleteAgentMemory", { id, scope, factId: g.id });
    expect(fs.readFileSync(profile, "utf8")).not.toContain("Boulder");

    await api("addAgentMemory", { id, scope: { kind: "user" }, content: "Has a dog named Rye", tier: "log" });
    expect((await api<MemoryListView>("getAgentMemories", { id, scope: { kind: "user" } })).facts.map((x) => x.content)).toEqual(["Has a dog named Rye"]);
    expect(await api("clearAgentMemories", { id, scope: { kind: "user" } })).toEqual({ removed: 1 });
    expect((await api<MemoryListView>("getAgentMemories", { id, scope: { kind: "user" } })).facts).toEqual([]);
  });
});
