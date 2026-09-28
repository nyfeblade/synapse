import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FactLedger, ledgerRef, type Provenance } from "../../memory/ledger";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const said = (botId: string, messageId = "t3u"): Provenance => ({ botId, chatId: botId, messageId, source: "user", confidence: 0.8 });

function mk() {
  let now = Date.UTC(2026, 0, 1);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "memory-ledger.db");
  const l = new FactLedger(file, () => now);
  return { l, file, tick: (ms: number) => { now += ms; }, at: () => now };
}

describe("FactLedger (bi-temporal, host-private)", () => {
  it("records a fact once per shard, with its key and provenance", () => {
    const { l } = mk();
    const ref = ledgerRef({ kind: "agent", botId: A });
    const r = l.record(ref, { factId: "f1", text: "The user's dentist is Kim Lee.", date: "2026-01-01" }, said(A));
    expect(r).toMatchObject({ scope: "private", owner: A, subject: "user", predicate: "dentist", value: "kim lee", source: "user", confidence: 0.8, botId: A, messageId: "t3u", supersededAt: null, validTo: null });
    expect(r.validFrom).toBe(Date.UTC(2026, 0, 1));
    expect(l.record(ref, { factId: "f1", text: "The user's dentist is Kim Lee.", date: "2026-01-01" }, said(A, "t9u")).id).toBe(r.id);
    expect(l.currentIn(ref.shard)).toHaveLength(1);
  });

  it("ends a fact without deleting it, and walks the history newest first", () => {
    const { l, tick, at } = mk();
    const ref = ledgerRef({ kind: "agent", botId: A });
    const v1 = l.record(ref, { factId: "f1", text: "The user's dentist is Kim Lee.", date: "2026-01-01" }, said(A));
    tick(86_400_000);
    const v2 = l.record(ref, { factId: "f2", text: "The user's dentist is Ana Ruiz.", date: "2026-01-02" }, said(A));
    l.end(ref.shard, "f1", v2.id);
    tick(86_400_000);
    const v3 = l.record(ref, { factId: "f3", text: "The user's dentist is Bo Chen.", date: "2026-01-03" }, said(A));
    const ended = l.end(ref.shard, "f2", v3.id);
    expect(ended).toMatchObject({ supersededBy: v3.id, supersededAt: at(), validTo: at() });
    expect(l.current(ref.shard, "f1")).toBeNull();
    expect(l.history(v3.id).map((r) => r.id)).toEqual([v2.id, v1.id]);
    expect(l.currentIn(ref.shard).map((r) => r.factId)).toEqual(["f3"]);
  });

  it("forget deletes the fact and its whole history (a user's Forget really forgets)", () => {
    const { l } = mk();
    const ref = ledgerRef({ kind: "agent", botId: A });
    l.record(ref, { factId: "f1", text: "The user's dentist is Kim Lee.", date: "2026-01-01" }, said(A));
    const v2 = l.record(ref, { factId: "f2", text: "The user's dentist is Ana Ruiz.", date: "2026-01-02" }, said(A));
    l.end(ref.shard, "f1", v2.id);
    expect(l.forget(ref.shard, "f2")).toBe(2);
    expect(l.searchPast(["dentist"], { botId: A, projects: [] })).toEqual([]);
  });

  it("scopes past search in the host: private rows only for their Bot; user and team rows for every Bot; project rows for members", () => {
    const { l } = mk();
    const rows: [Parameters<typeof ledgerRef>[0], string][] = [
      [{ kind: "agent", botId: A }, "Alpha private budget is 10k."],
      [{ kind: "user", botId: A }, "Alpha user budget is 20k."],
      [{ kind: "team", botId: A }, "Alpha team budget is 30k."],
      [{ kind: "project", botId: A, slug: "apollo" }, "Alpha apollo budget is 40k."],
    ];
    rows.forEach(([s, text], i) => {
      const ref = ledgerRef(s);
      l.record(ref, { factId: `f${i}`, text, date: "2026-01-01" }, said(A));
      l.end(ref.shard, `f${i}`, null);
    });
    const seen = (botId: string, projects: string[]) => l.searchPast(["budget"], { botId, projects }).map((r) => r.text).sort();
    expect(seen(A, ["apollo"])).toHaveLength(4);
    expect(seen(B, [])).toEqual(["Alpha team budget is 30k.", "Alpha user budget is 20k."]);
    expect(seen(B, ["apollo"])).toContain("Alpha apollo budget is 40k.");
  });

  it("migrates existing facts idempotently with provenance 'migrated'", () => {
    const { l } = mk();
    const ref = ledgerRef({ kind: "user", botId: B });
    const facts = [{ id: "a", content: "Prefers short answers.", date: "2025-03-01" }, { id: "b", content: "The user's employer is Quillon.", date: "2025-04-01" }];
    expect(l.migrate(ref, facts)).toBe(2);
    expect(l.migrate(ref, facts)).toBe(0);
    expect(l.current(ref.shard, "b")).toMatchObject({ source: "migrated", botId: B, scope: "user", subject: "user", predicate: "employer" });
  });

  it("clears a shard and everything a deleted Bot owns", () => {
    const { l } = mk();
    l.record(ledgerRef({ kind: "agent", botId: A }), { factId: "x", text: "One.", date: "2026-01-01" }, said(A));
    l.record(ledgerRef({ kind: "team", botId: A }), { factId: "y", text: "Two.", date: "2026-01-01" }, said(A));
    l.record(ledgerRef({ kind: "agent", botId: B }), { factId: "z", text: "Three.", date: "2026-01-01" }, said(B));
    expect(l.clearShard(ledgerRef({ kind: "agent", botId: B }).shard)).toBe(1);
    expect(l.clearOwner(A)).toBe(2);
  });

  it("is one plain SQLite file that survives a reopen (backups copy it with the online backup API)", () => {
    const { l, file } = mk();
    l.record(ledgerRef({ kind: "agent", botId: A }), { factId: "x", text: "One.", date: "2026-01-01" }, said(A));
    l.dispose();
    const again = new FactLedger(file);
    expect(again.currentIn(ledgerRef({ kind: "agent", botId: A }).shard)).toHaveLength(1);
    again.dispose();
  });
});
