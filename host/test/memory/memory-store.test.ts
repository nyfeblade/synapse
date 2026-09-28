import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore, scopeLabel } from "../../memory/memory-store";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const B = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const C = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";
function mk() {
  const cfg = tmpConfig();
  initLayout(cfg);
  let t = Date.UTC(2026, 8, 12, 15);
  const store = new MemoryStore({ cfg, now: () => t });
  return { cfg, store, advance: (ms: number) => { t += ms; } };
}

describe("MemoryStore (MEM-01, MEM-02, §05.4)", () => {
  // Task 38 live: an extraction that settles after its Bot was deleted recreated agents/<id>/memory
  // (an orphan folder, and the Bot's memory outlived it — BOT-09).
  it("refuses writes for a Bot whose memory was cleared, so a late extraction can't recreate its folder (BOT-09)", () => {
    const { cfg, store } = mk();
    const s = { kind: "agent" as const, botId: B };
    store.add(s, { content: "Prefers short answers", tier: "profile", kind: "fact" });
    fs.rmSync(path.join(cfg.dataRoot, "agents", B), { recursive: true, force: true }); // BotService.remove
    store.clearBot(B);
    expect(() => store.add(s, { content: "Landlord is Mark Ellis", tier: "log", kind: "fact" })).toThrow(/No such Bot/);
    expect(() => store.add({ kind: "user", botId: B }, { content: "Lives in Denver", tier: "profile", kind: "fact" })).toThrow(/No such Bot/);
    expect(fs.existsSync(path.join(cfg.dataRoot, "agents", B))).toBe(false);
    expect(fs.existsSync(path.join(cfg.dataRoot, "user-memory", "agents", B))).toBe(false);
  });

  it("writes profile and monthly log files with headers, dedupes and confirms", () => {
    const { cfg, store } = mk();
    const s = { kind: "agent" as const, botId: B };
    expect(store.add(s, { content: "Prefers short answers", tier: "profile", kind: "fact" }).added).toBe(true);
    expect(store.add(s, { content: "prefers  SHORT answers", tier: "log", kind: "fact" })).toMatchObject({ added: false });
    store.add(s, { content: "Waiting on the landlord", tier: "log", kind: "note" });
    const dir = path.join(cfg.dataRoot, "agents", B, "memory");
    expect(fs.readFileSync(path.join(dir, "profile.md"), "utf8")).toMatch(/^# About the user\n<!--.*-->\n- \(2026-09-12\) Prefers short answers\n$/s);
    expect(fs.readFileSync(path.join(dir, "log", "2026-09.md"), "utf8")).toContain("- (2026-09-12) [note] Waiting on the landlord");
    const meta = store.meta(s);
    expect(Object.values(meta)[0]).toMatchObject({ confirmCount: 1 });
  });

  it("removes only an exact match and notifies subscribers", () => {
    const { store } = mk();
    const s = { kind: "agent" as const, botId: B };
    const seen: string[] = [];
    store.subscribe((sc) => seen.push(sc.kind));
    store.add(s, { content: "Manager is Dana Ruiz", tier: "profile", kind: "fact" });
    expect(store.remove(s, "Manager is Dana")).toBeNull();
    expect(store.remove(s, "Manager is Dana Ruiz")?.content).toBe("Manager is Dana Ruiz");
    expect(store.profile(s)).toEqual([]);
    expect(seen).toEqual(["agent", "agent"]);
  });

  it("keeps user shards per Bot and lists their owners", () => {
    const { cfg, store } = mk();
    store.add({ kind: "user", botId: B }, { content: "Works in Pacific time", tier: "profile", kind: "fact" });
    store.add({ kind: "user", botId: C }, { content: "Has a dog named Miso", tier: "profile", kind: "fact" });
    expect(fs.existsSync(path.join(cfg.dataRoot, "user-memory", "agents", B, "profile.md"))).toBe(true);
    expect(store.userShardOwners().sort()).toEqual([B, C].sort());
  });

  it("enforces project existence and membership with the spec's errors", () => {
    const { store } = mk();
    expect(store.checkProjectScope(B, "launch")).toBe(`project "launch" doesn't exist yet; create it or join it before using it`);
    store.createProject("launch", C, "Q4 launch");
    expect(store.checkProjectScope(B, "launch")).toBe(`you're not a member of project "launch" yet`);
    store.joinProject(B, "launch");
    expect(store.checkProjectScope(B, "launch")).toBeNull();
    expect(store.projects(B)).toEqual(["launch"]);
    expect(scopeLabel({ kind: "project", botId: B, slug: "launch" })).toBe('project "launch"');
  });
});
