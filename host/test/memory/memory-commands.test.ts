import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryCommands } from "../../memory/memory-commands";
import { MemoryStore } from "../../memory/memory-store";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

// MEM-09, DESIGNED: the memory screen. Every assertion that an edit "worked" reads the FILE on the
// host, not the handler's return value — the files are the source of truth (MEM-01), and a screen
// whose writes only changed an in-memory copy would be the recurring bug class again.

const B = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const C = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";
const SECRET = "hunter2-vault-value-9f3a";

function mk() {
  const cfg = tmpConfig();
  initLayout(cfg);
  for (const id of [B, C]) fs.mkdirSync(path.join(cfg.dataRoot, "agents", id), { recursive: true });
  const store = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 12, 15) });
  const names: Record<string, string> = { [B]: "Piper", [C]: "Otto" };
  const cmd = createMemoryCommands({
    store,
    botExists: (id) => id in names,
    nameOf: (id) => names[id] ?? "a deleted Bot",
    secrets: (id) => (id === B ? [SECRET] : []),
    redact: (_id, text) => text.split(SECRET).join("[secret]"),
  });
  const agentDir = path.join(cfg.dataRoot, "agents", B, "memory");
  const read = (rel: string) => fs.readFileSync(path.join(agentDir, rel), "utf8");
  return { cfg, store, cmd, agentDir, read };
}
const agent = { kind: "agent" as const };
const user = { kind: "user" as const };

describe("memory commands (MEM-09, designed)", () => {
  it("lists a scope's facts with tier, kind and date, and the Bot's projects", async () => {
    const { store, cmd } = mk();
    store.add({ kind: "agent", botId: B }, { content: "Prefers short answers", tier: "profile", kind: "fact" });
    store.add({ kind: "agent", botId: B }, { content: "Booked the dentist", tier: "log", kind: "fact", date: "2026-09-01" });
    store.add({ kind: "agent", botId: B }, { content: "Waiting on Mark's reply", tier: "log", kind: "note", date: "2026-09-10" });
    store.createProject("kitchen-reno", B);
    const v = await cmd.getAgentMemories!({ id: B, scope: agent });
    expect(v.projects).toEqual(["kitchen-reno"]);
    expect(v.facts.map((f) => [f.tier, f.kind, f.date, f.content])).toEqual([
      ["profile", "fact", "2026-09-12", "Prefers short answers"],
      ["log", "fact", "2026-09-01", "Booked the dentist"],
      ["log", "note", "2026-09-10", "Waiting on Mark's reply"],
    ]);
    expect((await cmd.getAgentMemories!({ id: B })).facts).toEqual([]);
  });

  it("'about you' shows every Bot's user shard — what this Bot actually reads — naming the Bot that learned it", async () => {
    const { store, cmd } = mk();
    store.add({ kind: "user", botId: B }, { content: "Lives in Denver", tier: "profile", kind: "fact" });
    store.add({ kind: "user", botId: C }, { content: "Has a dog named Rye", tier: "profile", kind: "fact" });
    const v = await cmd.getAgentMemories!({ id: B, scope: user });
    expect(v.facts.map((f) => [f.content, f.owner, f.ownerName]).sort()).toEqual([
      ["Has a dog named Rye", C, "Otto"],
      ["Lives in Denver", B, "Piper"],
    ]);
  });

  it("an edit rewrites the line in the file, keeping its date and tier", async () => {
    const { store, cmd, read } = mk();
    store.add({ kind: "agent", botId: B }, { content: "Lives in Denver", tier: "profile", kind: "fact", date: "2026-08-02" });
    const [f] = (await cmd.getAgentMemories!({ id: B, scope: agent })).facts;
    const r = await cmd.updateAgentMemory!({ id: B, scope: agent, factId: f!.id, content: "Lives in Boulder" });
    expect(r.fact.content).toBe("Lives in Boulder");
    expect(read("profile.md")).toContain("- (2026-08-02) Lives in Boulder");
    expect(read("profile.md")).not.toContain("Denver");
  });

  it("an edit of a note keeps it a note, in its month's log file", async () => {
    const { store, cmd, read } = mk();
    store.add({ kind: "agent", botId: B }, { content: "Call back Tuesday", tier: "log", kind: "note", date: "2026-07-20" });
    const [f] = (await cmd.getAgentMemories!({ id: B, scope: agent })).facts;
    await cmd.updateAgentMemory!({ id: B, scope: agent, factId: f!.id, content: "Call back Wednesday" });
    expect(read("log/2026-07.md")).toContain("- (2026-07-20) [note] Call back Wednesday");
    expect(read("log/2026-07.md")).not.toContain("Tuesday");
  });

  it("an edit in another Bot's 'about you' shard writes THAT shard's file", async () => {
    const { cfg, store, cmd } = mk();
    store.add({ kind: "user", botId: C }, { content: "Has a dog named Rye", tier: "profile", kind: "fact" });
    const f = (await cmd.getAgentMemories!({ id: B, scope: user })).facts[0]!;
    await cmd.updateAgentMemory!({ id: B, scope: user, factId: f.id, owner: f.owner, content: "Has a dog named Rye, a collie" });
    expect(fs.readFileSync(path.join(cfg.dataRoot, "user-memory", "agents", C, "profile.md"), "utf8")).toContain("Has a dog named Rye, a collie");
  });

  it("delete removes the line from the file and nothing else", async () => {
    const { store, cmd, read } = mk();
    store.add({ kind: "agent", botId: B }, { content: "Prefers short answers", tier: "profile", kind: "fact" });
    store.add({ kind: "agent", botId: B }, { content: "Drinks oat milk", tier: "profile", kind: "fact" });
    const f = (await cmd.getAgentMemories!({ id: B, scope: agent })).facts.find((x) => x.content === "Drinks oat milk")!;
    expect(await cmd.deleteAgentMemory!({ id: B, scope: agent, factId: f.id })).toEqual({ removed: true });
    expect(read("profile.md")).not.toContain("oat milk");
    expect(read("profile.md")).toContain("Prefers short answers");
    expect(await cmd.deleteAgentMemory!({ id: B, scope: agent, factId: f.id })).toEqual({ removed: false });
  });

  it("add writes the chosen tier to disk: always known → profile.md, note → a [note] log line", async () => {
    const { cmd, read } = mk();
    expect((await cmd.addAgentMemory!({ id: B, scope: agent, content: "  Allergic to   penicillin ", tier: "profile" })).added).toBe(true);
    await cmd.addAgentMemory!({ id: B, scope: agent, content: "Parcel due Friday", tier: "note" });
    expect(read("profile.md")).toContain("- (2026-09-12) Allergic to penicillin");
    expect(read("log/2026-09.md")).toContain("- (2026-09-12) [note] Parcel due Friday");
  });

  it("add to a project the Bot has not joined is refused, and nothing is written", async () => {
    const { cfg, cmd } = mk();
    await expect(Promise.resolve().then(() => cmd.addAgentMemory!({ id: B, scope: { kind: "project", slug: "garden" }, content: "x", tier: "log" }))).rejects.toThrow(/project "garden" doesn't exist yet/);
    expect(fs.existsSync(path.join(cfg.dataRoot, "projects", "garden"))).toBe(false);
  });

  it("clear empties the scope on disk; clearing 'about you' clears every Bot's shard", async () => {
    const { cfg, store, cmd, agentDir } = mk();
    store.add({ kind: "agent", botId: B }, { content: "Prefers short answers", tier: "profile", kind: "fact" });
    store.add({ kind: "agent", botId: B }, { content: "Booked the dentist", tier: "log", kind: "fact" });
    store.add({ kind: "user", botId: B }, { content: "Lives in Denver", tier: "profile", kind: "fact" });
    store.add({ kind: "user", botId: C }, { content: "Has a dog named Rye", tier: "log", kind: "fact" });
    expect(await cmd.clearAgentMemories!({ id: B, scope: agent })).toEqual({ removed: 2 });
    expect(store.all({ kind: "agent", botId: B })).toEqual([]);
    const left = fs.existsSync(agentDir) ? fs.readdirSync(agentDir, { recursive: true }).map(String).filter((n) => n.endsWith(".md")) : [];
    for (const n of left) expect(fs.readFileSync(path.join(agentDir, n), "utf8")).not.toMatch(/Prefers|dentist/);
    expect(store.all({ kind: "user", botId: B })).toHaveLength(1); // a scope clear touches only that scope
    expect(await cmd.clearAgentMemories!({ id: B, scope: user })).toEqual({ removed: 2 });
    expect(store.all({ kind: "user", botId: B })).toEqual([]);
    expect(store.all({ kind: "user", botId: C })).toEqual([]);
    const otto = path.join(cfg.dataRoot, "user-memory", "agents", C, "log", "2026-09.md");
    expect(fs.existsSync(otto) ? fs.readFileSync(otto, "utf8") : "").not.toContain("Rye"); // the file is the truth, not the store's parse of it
  });

  it("an unknown Bot is refused", async () => {
    const { cmd } = mk();
    expect(() => cmd.getAgentMemories!({ id: "2d9e8a01-5ca0-4f2e-9c75-3b4f5e6d7c8d", scope: agent })).toThrow(/No such Bot/);
  });
});

describe("memory screen never shows a secret (ORIG-12)", () => {
  it("a line holding a vault value or a key-shaped string reaches the renderer with no text at all", async () => {
    const { store, cmd } = mk();
    // The Bot's own update_state write path has no secret guard, so such a line CAN be on disk.
    store.add({ kind: "agent", botId: B }, { content: `Wifi password saved as ${SECRET}`, tier: "profile", kind: "fact" });
    store.add({ kind: "agent", botId: B }, { content: "Deploy key sk-ant-api03-abcdefghijklmnop", tier: "log", kind: "fact" });
    store.add({ kind: "agent", botId: B }, { content: "Prefers short answers", tier: "profile", kind: "fact" });
    const v = await cmd.getAgentMemories!({ id: B, scope: agent });
    const wire = JSON.stringify(v);
    expect(wire).not.toContain(SECRET);
    expect(wire).not.toContain("sk-ant-api03");
    expect(v.facts.filter((f) => f.content === null)).toHaveLength(2);
    expect(v.facts.find((f) => f.content === "Prefers short answers")).toBeTruthy();
  });

  it("a hidden line can still be deleted, by id, without its text ever being sent", async () => {
    const { store, cmd, read } = mk();
    store.add({ kind: "agent", botId: B }, { content: `Wifi password saved as ${SECRET}`, tier: "profile", kind: "fact" });
    const f = (await cmd.getAgentMemories!({ id: B, scope: agent })).facts[0]!;
    expect(f.content).toBeNull();
    await cmd.deleteAgentMemory!({ id: B, scope: agent, factId: f.id });
    expect(read("profile.md")).not.toContain(SECRET);
  });

  it("add and edit refuse a secret, so the screen cannot be how one gets into memory", async () => {
    const { store, cmd, agentDir } = mk();
    await expect(Promise.resolve().then(() => cmd.addAgentMemory!({ id: B, scope: agent, content: `my pin is ${SECRET}`, tier: "profile" }))).rejects.toThrow(/looks like a secret/);
    await expect(Promise.resolve().then(() => cmd.addAgentMemory!({ id: B, scope: agent, content: "token ghp_abcdefghijklmnopqrstuvwxyz", tier: "log" }))).rejects.toThrow(/looks like a secret/);
    store.add({ kind: "agent", botId: B }, { content: "Lives in Denver", tier: "profile", kind: "fact" });
    const f = (await cmd.getAgentMemories!({ id: B, scope: agent })).facts[0]!;
    await expect(Promise.resolve().then(() => cmd.updateAgentMemory!({ id: B, scope: agent, factId: f.id, content: `Lives in Denver, door code ${SECRET}` }))).rejects.toThrow(/looks like a secret/);
    expect(fs.readFileSync(path.join(agentDir, "profile.md"), "utf8")).not.toContain(SECRET);
  });
});
