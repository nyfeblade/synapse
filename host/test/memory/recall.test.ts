import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../memory/memory-store";
import { createRecallHooks, queryTerms, recallFor, renderRecall, scoreCandidates, selectRecall } from "../../memory/recall";
import { RecallIndex } from "../../memory/recall-index";
import { startRecallSync } from "../../memory/recall-sync";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ME = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const SCOUT = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";
const NOW = Date.UTC(2026, 8, 20);

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const store = new MemoryStore({ cfg, now: () => NOW });
  const index = new RecallIndex(path.join(cfg.hostPrivate, "memory-index.db"));
  startRecallSync({ index, store });
  const frozen = new Set<string>();
  const deps = { index, store, frozen: () => frozen, nameOf: (id: string) => (id === SCOUT ? "Scout" : "Piper"), now: () => NOW };
  return { store, index, frozen, deps };
}

describe("query terms", () => {
  it("keeps ≥4-char tokens, drops the MEM-06 stopwords, dedupes, caps at 12", () => {
    expect(queryTerms("Thanks! What did Mark Ellis say about the lease? lease again")).toEqual(["what", "mark", "ellis", "about", "lease", "again"]);
    expect(queryTerms(Array.from({ length: 30 }, (_, i) => `word${i}x`).join(" "))).toHaveLength(12);
  });
});

describe("recall (ORIG-05 §05.3)", () => {
  it("recalls a relevant fact not in the frozen section, with the exact block", () => {
    const { store, deps } = setup();
    store.add({ kind: "agent", botId: ME }, { content: "The user's landlord is Mark Ellis; lease renews every August.", tier: "profile", kind: "fact", date: "2026-07-02" });
    store.add({ kind: "user", botId: SCOUT }, { content: "The user is comparing Denver flights for Oct 14–16.", tier: "log", kind: "fact", date: "2026-09-12" });
    store.add({ kind: "agent", botId: ME }, { content: "The user likes oat milk in coffee.", tier: "profile", kind: "fact", date: "2026-07-02" });
    const r = recallFor(deps, ME, "When does the lease with Mark Ellis renew?");
    expect(r.block).toBe(
      "<system_reminder><recalled_memory>\nPossibly relevant memories not shown above (check before relying on them):\n- (learned 2026-07-02) The user's landlord is Mark Ellis; lease renews every August.\n</recalled_memory></system_reminder>",
    );
    const r2 = recallFor(deps, ME, "Any Denver flights for October yet?");
    expect(r2.block).toContain("- (learned 2026-09-12) [via Scout] The user is comparing Denver flights for Oct 14–16.");
    expect(store.meta({ kind: "agent", botId: ME })).toSatisfy((m: Record<string, { recallCount?: number }>) => Object.values(m).some((x) => x.recallCount === 1));
  });

  it("drops frozen facts and single common-term matches, and is absent when nothing is relevant", () => {
    const { store, frozen, deps } = setup();
    const f = store.add({ kind: "agent", botId: ME }, { content: "The user's landlord is Mark Ellis.", tier: "profile", kind: "fact" }).fact;
    for (let i = 0; i < 30; i++) store.add({ kind: "agent", botId: ME }, { content: `Weekly note ${i}: the garden needs watering`, tier: "log", kind: "fact" });
    frozen.add(f.id);
    expect(recallFor(deps, ME, "Did Mark Ellis reply?").block).toBeNull();
    expect(recallFor(deps, ME, "garden").block).toBeNull();
    expect(recallFor(deps, ME, "What's the capital of Peru?").block).toBeNull();
  });

  it("caps at 6 facts and 900 chars", () => {
    const { store, deps } = setup();
    for (let i = 0; i < 12; i++) store.add({ kind: "agent", botId: ME }, { content: `Invoice Zephyrine ${i} for the Halvorsen account is due on the ${i + 1}th and needs a purchase order number first`, tier: "log", kind: "fact" });
    const r = recallFor(deps, ME, "Zephyrine Halvorsen invoices");
    expect(r.facts.length).toBeLessThanOrEqual(6);
    expect(r.block!.split("\n").filter((l) => l.startsWith("- ")).join("\n").length).toBeLessThanOrEqual(900);
  });

  it("the hook runs on user turns only and honors the parity switch", () => {
    const { store, deps } = setup();
    store.add({ kind: "agent", botId: ME }, { content: "The user's landlord is Mark Ellis.", tier: "profile", kind: "fact" });
    let on = true;
    const h = createRecallHooks({ ...deps, enabled: () => on });
    expect(h.turnBlocks!(ME, { source: "user", hidden: false, silenceAllowed: false, queryText: "Mark Ellis landlord?" })).toHaveLength(1);
    expect(h.turnBlocks!(ME, { source: "ack-redrive", hidden: true, silenceAllowed: false, queryText: "Mark Ellis landlord?" })).toHaveLength(0);
    on = false;
    expect(h.turnBlocks!(ME, { source: "user", hidden: false, silenceAllowed: false, queryText: "Mark Ellis landlord?" })).toHaveLength(0);
  });

  it("scores and selects per the formula", () => {
    const base = { scope: "agent" as const, owner: ME, project: null, kind: "fact" as const, content: "alpha beta", createdAt: NOW, importance: 1, factId: "a" };
    const scored = scoreCandidates([{ ...base, bm25: -2 }, { ...base, factId: "b", content: "alpha", bm25: -1 }], { now: NOW, terms: ["alpha", "beta"], reinforced: () => false });
    expect(scored.find((s) => s.factId === "a")).toMatchObject({ bm25n: 1, matched: ["alpha", "beta"] });
    expect(scored.find((s) => s.factId === "a")!.s).toBeCloseTo(1.3, 5);
    expect(selectRecall(scored, { frozen: new Set(), rare: new Set() }).map((s) => s.factId)).toEqual(["a"]);
    expect(renderRecall([])).toBe("");
  });
});
