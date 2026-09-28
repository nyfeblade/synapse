import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OneShotModel } from "../../brain/one-shot";
import { MemoryExtractor } from "../../memory/extractor";
import { FactLedger, ledgerRef } from "../../memory/ledger";
import { MemoryStore } from "../../memory/memory-store";
import { asksAboutThePast, recallFor } from "../../memory/recall";
import { RecallIndex } from "../../memory/recall-index";
import { startRecallSync } from "../../memory/recall-sync";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const ME = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const OTHER = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";
const DAY = 86_400_000;

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  for (const id of [ME, OTHER]) fs.mkdirSync(path.join(cfg.dataRoot, "agents", id), { recursive: true });
  let now = Date.UTC(2026, 2, 1);
  const ledger = new FactLedger(path.join(cfg.hostPrivate, "memory-ledger.db"), () => now);
  const store = new MemoryStore({ cfg, now: () => now, ledger });
  const index = new RecallIndex(path.join(cfg.hostPrivate, "memory-index.db"));
  startRecallSync({ index, store });
  const deps = { index, store, ledger, frozen: () => new Set<string>(), nameOf: (id: string) => (id === OTHER ? "Scout" : "Piper"), now: () => now };
  return { store, ledger, deps, advance: (ms: number) => { now += ms; } };
}

describe("recall with the ledger", () => {
  it("detects questions about the past", () => {
    for (const q of ["Who was my dentist before?", "What did the budget use to be?", "Where did I work previously?", "What was it originally?"]) expect(asksAboutThePast(q)).toBe(true);
    for (const q of ["Who is my dentist?", "What's the budget?", "Book the usual table for Friday."]) expect(asksAboutThePast(q)).toBe(false);
  });

  it("answers the current value, and the old one only when asked about the past, dated", () => {
    const { store, deps, advance } = setup();
    store.add({ kind: "agent", botId: ME }, { content: "The user's dentist is Kim Lee.", tier: "profile", kind: "fact" });
    advance(60 * DAY);
    store.add({ kind: "agent", botId: ME }, { content: "The user's dentist is Ana Ruiz.", tier: "profile", kind: "fact" });
    const now = recallFor(deps, ME, "Who is my dentist?").block!;
    expect(now).toContain("Ana Ruiz");
    expect(now).not.toContain("Kim Lee");
    const past = recallFor(deps, ME, "Who was my dentist before?").block!;
    expect(past).toContain("- (until 2026-04-30) The user's dentist is Kim Lee.");
    expect(past).toContain("Ana Ruiz");
  });

  it("never shows another Bot's private history", () => {
    const { store, deps, advance } = setup();
    store.add({ kind: "agent", botId: OTHER }, { content: "The user's notary is Ivo Brandt.", tier: "profile", kind: "fact" });
    advance(DAY);
    store.add({ kind: "agent", botId: OTHER }, { content: "The user's notary is Lena Voss.", tier: "profile", kind: "fact" });
    expect(recallFor(deps, ME, "Who was my notary before?").block).toBeNull();
    store.add({ kind: "team", botId: OTHER }, { content: "The office wifi name is Harbor.", tier: "profile", kind: "fact" });
    advance(DAY);
    store.add({ kind: "team", botId: OTHER }, { content: "The office wifi name is Lantern.", tier: "profile", kind: "fact" });
    const block = recallFor(deps, ME, "What was the office wifi name before?").block!;
    expect(block).toContain("Harbor");
    expect(block).toContain("[team via Scout]");
  });

  it("stays inside the per-turn budget (≤ 6 facts, ≤ 900 chars) with past lines included", () => {
    const { store, deps, advance } = setup();
    for (let i = 0; i < 12; i++) {
      const tail = "who also reviews the long quarterly appendix, ".repeat(2);
      store.add({ kind: "agent", botId: ME }, { content: `The report owner for Q${i}x is Person Alpha${i}, ${tail}`, tier: "log", kind: "fact" });
      advance(DAY);
      store.add({ kind: "agent", botId: ME }, { content: `The report owner for Q${i}x is Person Beta${i}, ${tail}`, tier: "log", kind: "fact" });
    }
    const r = recallFor(deps, ME, "Who was the quarterly report owner before?");
    expect(r.past.length).toBeGreaterThan(0);
    const lines = r.block!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.join("\n").length).toBeLessThanOrEqual(900);
  });
});

describe("extraction writes provenance to the ledger (no extra model call)", () => {
  it("pairs remove + replacement as a supersession and credits the exchange it came from", async () => {
    const { store, ledger, advance } = setup();
    let out = "profile: The user's accountant is Mira Solberg.";
    let calls = 0;
    const model: OneShotModel = { complete: async () => { calls++; return out; } };
    const x = new MemoryExtractor({ store, model, secrets: () => [], timeZone: () => "UTC", nameOf: () => "Piper", now: () => Date.UTC(2026, 2, 1) });
    await x.run(ME, [{ user: "Book the dentist for Tuesday please, thanks a lot", bot: "Done.", ref: "t2u" }, { user: "My accountant is Mira Solberg, keep that in mind", bot: "Noted.", ref: "t3u" }]);
    advance(DAY);
    out = "remove: The user's accountant is Mira Solberg.\nprofile: The user switched accounting to Noor Haddad's firm.";
    const r = await x.run(ME, { user: "I switched accounting to Noor Haddad's firm this week", bot: "Noted.", ref: "t7u" });
    expect(r).toEqual({ added: 1, removed: 1 });
    expect(calls).toBe(2);
    const shard = ledgerRef({ kind: "agent", botId: ME }).shard;
    const [cur] = ledger.currentIn(shard);
    expect(cur).toMatchObject({ text: "The user switched accounting to Noor Haddad's firm.", source: "user", botId: ME, chatId: ME, messageId: "t7u" });
    expect(ledger.history(cur!.id)).toMatchObject([{ text: "The user's accountant is Mira Solberg.", messageId: "t3u" }]);
  });
});
