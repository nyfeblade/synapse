import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FactLedger, ledgerRef } from "../../memory/ledger";
import { migrateMemoryToLedger } from "../../memory/ledger-migrate";
import { MemoryStore } from "../../memory/memory-store";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const A = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const B = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";
const DAY = 86_400_000;

function mk() {
  const cfg = tmpConfig();
  initLayout(cfg);
  for (const id of [A, B]) fs.mkdirSync(path.join(cfg.dataRoot, "agents", id), { recursive: true });
  let t = Date.UTC(2026, 2, 1);
  const ledger = new FactLedger(path.join(cfg.hostPrivate, "memory-ledger.db"), () => t);
  const store = new MemoryStore({ cfg, now: () => t, ledger });
  return { cfg, store, ledger, advance: (ms: number) => { t += ms; } };
}
const agent = { kind: "agent" as const, botId: A };
const texts = (store: MemoryStore, s: Parameters<MemoryStore["all"]>[0]) => store.all(s).map((f) => f.content);

describe("MemoryStore + ledger: a contradiction supersedes, never deletes", () => {
  it("a new value for the same subject and predicate replaces the old line and keeps it as history", () => {
    const { store, ledger, advance } = mk();
    store.add(agent, { content: "The user's dentist is Kim Lee.", tier: "profile", kind: "fact" }, { botId: A, chatId: A, messageId: "t4u", source: "user", confidence: 0.8 });
    advance(30 * DAY);
    const r = store.add(agent, { content: "The user's dentist is Ana Ruiz.", tier: "profile", kind: "fact" }, { botId: A, chatId: A, messageId: "t9u", source: "user", confidence: 0.8 });
    expect(texts(store, agent)).toEqual(["The user's dentist is Ana Ruiz."]);
    const cur = ledger.current(ledgerRef(agent).shard, r.fact.id)!;
    expect(ledger.history(cur.id)).toMatchObject([{ text: "The user's dentist is Kim Lee.", messageId: "t4u", validTo: Date.UTC(2026, 2, 31), supersededBy: cur.id }]);
  });

  it("multi-valued facts (two sisters) both stay current", () => {
    const { store } = mk();
    store.add(agent, { content: "The user's sister is Maya.", tier: "profile", kind: "fact" });
    store.add(agent, { content: "The user's sister is Ana.", tier: "profile", kind: "fact" });
    expect(texts(store, agent)).toHaveLength(2);
  });

  it("a weaker source does not overturn a stronger one (a web hint never replaces what the user corrected)", () => {
    const { store, ledger } = mk();
    const f = store.add(agent, { content: "Halyard's budget is 55k.", tier: "profile", kind: "fact" }, { botId: null, source: "user", confidence: 1 });
    store.add(agent, { content: "Halyard's budget is 40k.", tier: "profile", kind: "fact" }, { botId: A, source: "web", confidence: 0.5 });
    expect(texts(store, agent)).toContain("Halyard's budget is 55k.");
    expect(ledger.current(ledgerRef(agent).shard, f.fact.id)).not.toBeNull();
  });

  it("supersede() pairs the extractor's remove with its replacement even when the key can't be read", () => {
    const { store, ledger } = mk();
    store.add(agent, { content: "Waiting on the landlord about the lease.", tier: "log", kind: "note" });
    const r = store.supersede(agent, "Waiting on the landlord about the lease.", { content: "The landlord agreed to renew the lease through 2027.", tier: "log", kind: "fact" }, { botId: A, source: "user", confidence: 0.8 });
    expect(texts(store, agent)).toEqual(["The landlord agreed to renew the lease through 2027."]);
    expect(r.replaced).toBe(true);
    const cur = ledger.current(ledgerRef(agent).shard, r.fact.id)!;
    expect(ledger.history(cur.id).map((h) => h.text)).toEqual(["Waiting on the landlord about the lease."]);
  });

  it("a correction (the screen's edit) is a user-sourced fact at confidence 1 that supersedes the old one", () => {
    const { store, ledger } = mk();
    const old = store.add(agent, { content: "The user's employer is Quillon.", tier: "profile", kind: "fact" }, { botId: A, source: "user", confidence: 0.8 });
    const fixed = store.replace(agent, old.fact.id, "The user's employer is Verdigris.");
    const cur = ledger.current(ledgerRef(agent).shard, fixed.id)!;
    expect(cur).toMatchObject({ source: "user", confidence: 1, botId: null });
    expect(ledger.history(cur.id).map((h) => h.text)).toEqual(["The user's employer is Quillon."]);
  });

  it("retract (the extractor's unpaired remove) ends the fact; forget (the user's) deletes it and its history", () => {
    const { store, ledger } = mk();
    const a = store.add(agent, { content: "The user's gym is Pulse.", tier: "profile", kind: "fact" });
    store.remove(agent, "The user's gym is Pulse.", "retract");
    expect(ledger.searchPast(["pulse"], { botId: A, projects: [] }).map((r) => r.factId)).toEqual([a.fact.id]);
    const b = store.add(agent, { content: "The user's tailor is Rosa.", tier: "profile", kind: "fact" });
    store.add(agent, { content: "The user's tailor is Ines.", tier: "profile", kind: "fact" });
    const ines = store.all(agent).find((f) => f.content.includes("Ines"))!;
    store.removeById(agent, ines.id);
    expect(ledger.searchPast(["tailor"], { botId: A, projects: [] })).toEqual([]);
    expect(ledger.current(ledgerRef(agent).shard, b.fact.id)).toBeNull();
  });

  it("team facts live in their own shard, readable by every Bot; clear and clearBot empty the ledger too", () => {
    const { cfg, store, ledger } = mk();
    const team = { kind: "team" as const, botId: B };
    store.add(team, { content: "The staging server is at 10.0.0.5.", tier: "profile", kind: "fact" });
    expect(fs.existsSync(path.join(cfg.dataRoot, "team-memory", "agents", B, "profile.md"))).toBe(true);
    expect(store.teamShardOwners()).toEqual([B]);
    expect(ledger.currentIn(ledgerRef(team).shard)).toHaveLength(1);
    store.add(agent, { content: "The user's dentist is Kim Lee.", tier: "profile", kind: "fact" });
    store.clear(agent);
    expect(ledger.currentIn(ledgerRef(agent).shard)).toHaveLength(0);
    store.clearBot(B);
    expect(ledger.currentIn(ledgerRef(team).shard)).toHaveLength(0);
    expect(store.teamShardOwners()).toEqual([]);
  });

  it("the boot migration imports every shard's facts once, as 'migrated', and never rewrites them", () => {
    const { cfg, ledger } = mk();
    const plain = new MemoryStore({ cfg, now: () => Date.UTC(2026, 0, 1) });
    plain.add(agent, { content: "The user's dentist is Kim Lee.", tier: "profile", kind: "fact" });
    plain.add(agent, { content: "The user's dentist is Ana Ruiz.", tier: "profile", kind: "fact" });
    plain.add({ kind: "user", botId: B }, { content: "Prefers short answers.", tier: "profile", kind: "fact" });
    plain.createProject("apollo", A);
    plain.add({ kind: "project", botId: A, slug: "apollo" }, { content: "Launch is in May.", tier: "log", kind: "fact" });
    const before = fs.readFileSync(path.join(plain.dir(agent), "profile.md"), "utf8");
    expect(migrateMemoryToLedger({ store: plain, ledger, botIds: [A, B] })).toBe(4);
    expect(migrateMemoryToLedger({ store: plain, ledger, botIds: [A, B] })).toBe(0);
    expect(fs.readFileSync(path.join(plain.dir(agent), "profile.md"), "utf8")).toBe(before);
    expect(ledger.currentIn(ledgerRef(agent).shard).every((r) => r.source === "migrated")).toBe(true);
  });
});
