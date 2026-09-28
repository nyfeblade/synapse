import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../memory/memory-store";
import { RecallIndex } from "../../memory/recall-index";
import { reindexAll, startRecallSync } from "../../memory/recall-sync";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ME = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const OTHER = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const store = new MemoryStore({ cfg, now: () => Date.UTC(2026, 8, 20) });
  const index = new RecallIndex(path.join(cfg.hostPrivate, "memory-index.db"));
  return { cfg, store, index };
}

describe("RecallIndex (ORIG-05 §05.3)", () => {
  it("has FTS5 and indexes only what a Bot may read", () => {
    const { store, index } = setup();
    store.add({ kind: "agent", botId: ME }, { content: "The landlord Mark Ellis renews the lease every August", tier: "profile", kind: "fact" });
    store.add({ kind: "agent", botId: OTHER }, { content: "The landlord of the studio is Ruth Ames", tier: "profile", kind: "fact" });
    store.add({ kind: "user", botId: OTHER }, { content: "The user's café is Café Crème on Pine", tier: "profile", kind: "fact" });
    reindexAll({ index, store, botIds: [ME, OTHER] });
    const mine = index.search(["landlord"], { botId: ME, projects: [] });
    expect(mine.map((c) => c.content)).toEqual(["The landlord Mark Ellis renews the lease every August"]);
    expect(index.search(["cafe"], { botId: ME, projects: [] }).map((c) => c.scope)).toEqual(["user"]); // remove_diacritics 2
    expect(index.count({ botId: ME, projects: [] })).toBe(2);
    expect(index.docFreq("landlord", { botId: ME, projects: [] })).toBe(1);
  });

  it("follows store writes through the subscription", () => {
    const { store, index } = setup();
    const stop = startRecallSync({ index, store });
    store.add({ kind: "agent", botId: ME }, { content: "Prefers aisle seats on flights", tier: "profile", kind: "fact" });
    expect(index.search(["aisle"], { botId: ME, projects: [] })).toHaveLength(1);
    store.remove({ kind: "agent", botId: ME }, "Prefers aisle seats on flights");
    expect(index.search(["aisle"], { botId: ME, projects: [] })).toHaveLength(0);
    stop();
  });

  it("includes joined projects only", () => {
    const { store, index } = setup();
    store.createProject("launch", OTHER);
    store.add({ kind: "project", botId: OTHER, slug: "launch" }, { content: "Launch press embargo lifts Oct 30", tier: "log", kind: "fact" });
    reindexAll({ index, store, botIds: [ME, OTHER] });
    expect(index.search(["embargo"], { botId: ME, projects: [] })).toHaveLength(0);
    expect(index.search(["embargo"], { botId: ME, projects: ["launch"] })).toHaveLength(1);
  });

  // Task 38 live: a deleted Bot's user facts stayed in the index; another Bot's recall then hit them,
  // touched their meta for a cleared owner and the whole user turn failed ("No such Bot").
  it("drops a deleted Bot's shards from the index, and touching a cleared owner's facts is a no-op (BOT-09)", () => {
    const { cfg, store, index } = setup();
    const stop = startRecallSync({ index, store });
    store.add({ kind: "user", botId: OTHER }, { content: "The user's landlord is Mark Ellis", tier: "profile", kind: "fact" });
    store.add({ kind: "agent", botId: OTHER }, { content: "The landlord prefers email", tier: "profile", kind: "fact" });
    const hit = index.search(["landlord"], { botId: ME, projects: [] });
    expect(hit).toHaveLength(1);
    store.clearBot(OTHER);
    expect(index.search(["landlord"], { botId: ME, projects: [] })).toHaveLength(0);
    expect(index.search(["landlord"], { botId: OTHER, projects: [] })).toHaveLength(0);
    expect(() => store.touchRecalled({ kind: "user", botId: OTHER }, [hit[0]!.factId])).not.toThrow();
    expect(fs.existsSync(path.join(cfg.dataRoot, "user-memory", "agents", OTHER))).toBe(false);
    stop();
  });

  // Task 38 live: shards indexed before the purge-on-delete fix stayed in memory-index.db across
  // restarts, so a deleted Bot's facts kept surfacing as "[via a deleted Bot]".
  it("boot reindex drops shards whose owner no longer exists", () => {
    const { store, index } = setup();
    index.replaceShard(`user:${OTHER}`, [{ factId: "f1", scope: "user", owner: OTHER, project: null, kind: "fact", content: "The user's landlord is Mark Ellis", createdAt: 0, importance: 1 }]);
    index.replaceShard(`agent:${OTHER}`, [{ factId: "f2", scope: "agent", owner: OTHER, project: null, kind: "fact", content: "The landlord prefers email", createdAt: 0, importance: 1 }]);
    reindexAll({ index, store, botIds: [ME] });
    expect(index.search(["landlord"], { botId: ME, projects: [] })).toHaveLength(0);
    expect(index.search(["landlord"], { botId: OTHER, projects: [] })).toHaveLength(0);
  });
});
