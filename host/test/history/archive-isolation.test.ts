import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HistoryArchive, type ArchiveRow } from "../../history/archive";

/**
 * Every Bot runs as the one uid `box`, which can read all of /home/box/agent-data (decisions.md,
 * 2026-09-21, OS-USER FINDING). So the archive is ONE bothost-only file, and isolation between Bots
 * is the host's job: every query is scoped by the bot id the host resolved, never by anything the
 * model passes.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const SRC = fs.readFileSync(path.join(repoRoot, "host", "history", "archive.ts"), "utf8");
const selectList = (s: string) => /^SELECT\s+([\s\S]*?)\s+FROM\b/.exec(s)?.[1] ?? "";
/** One count/total/sum over lengths or rows: a number, never a value from a row. */
const AGGREGATE_ONLY = /^(?:count\(\*\)|(?:total|sum)\((?:\s*length\(\w+\)\s*\+?)+\))(?:\s+AS\s+\w+)?$/;
const redact = (_b: string, t: string) => t;
const row = (src: string, body: string, at = 1_700_000_000_000, stream = "chat"): ArchiveRow => ({ src, stream, at, speaker: "user", ctx: "ctx", body });

function open(): { a: HistoryArchive; dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-iso-"));
  const file = path.join(dir, "history.db");
  return { a: new HistoryArchive(file, { redact, secrets: () => [] }), dir, file };
}

describe("history archive: one Bot never sees another's rows", () => {
  it("search, around, has and stats are scoped to the calling Bot", () => {
    const { a } = open();
    try {
      a.put("botA", [row("e:1", "the Halvor budget is 40k"), row("e:2", "alpha only words", 1_700_000_001_000)]);
      a.put("botB", [row("e:1", "the Halvor budget is 99k zebra"), row("e:2", "bravo secret plans zebra", 1_700_000_001_000)]);
      expect(a.search("botA", { query: "zebra" })).toEqual([]);
      expect(a.search("botA", { query: "halvor budget" }).map((h) => h.text)).toEqual(["the Halvor budget is 40k"]);
      const bHit = a.search("botB", { query: "zebra" })[0]!;
      expect(a.around("botA", bHit.ref, 5), "a ref from Bot B must not open Bot B's rows for Bot A").toEqual([]);
      expect(a.around("botB", bHit.ref, 5).length).toBeGreaterThan(0);
      expect(a.stats("botA").rows).toBe(2);
      expect(a.has("botA", "e:1")).toBe(true);
      a.removeBot("botB");
      expect(a.stats("botB").rows).toBe(0);
      expect(a.stats("botA").rows).toBe(2);
    } finally { a.close(); }
  });

  it("the same source id under two Bots is two rows (idempotency is per Bot)", () => {
    const { a } = open();
    try {
      a.put("botA", [row("e:1", "first")]);
      a.put("botA", [row("e:1", "first, edited")]);
      a.put("botB", [row("e:1", "other")]);
      expect(a.stats("botA").rows).toBe(1);
      expect(a.search("botA", { query: "edited" }).map((h) => h.text)).toEqual(["first, edited"]);
    } finally { a.close(); }
  });

  it("every SELECT on the archive table is scoped by bot_id, or returns only an aggregate number", () => {
    const selects = [...SRC.matchAll(/SELECT[\s\S]*?(?=["`])/g)].map((m) => m[0]).filter((s) => /\barchive\b/.test(s));
    expect(selects.length, "no SELECT found; the pattern is blind").toBeGreaterThan(2);
    for (const s of selects) {
      if (/bot_id\s*=\s*\?/.test(s)) continue;
      // Unscoped is allowed only when nothing of any row comes back: the select list is one aggregate.
      expect(selectList(s), `unscoped SELECT returns row content: ${s.slice(0, 120)}`).toMatch(AGGREGATE_ONLY);
    }
  });

  it("must-fire self-test: the scoping rule rejects an unscoped content SELECT", () => {
    expect(AGGREGATE_ONLY.test(selectList("SELECT body, ctx FROM archive WHERE at > ?"))).toBe(false);
    expect(AGGREGATE_ONLY.test(selectList("SELECT max(body) AS b FROM archive"))).toBe(false);
    expect(AGGREGATE_ONLY.test(selectList("SELECT total(length(ctx) + length(body)) AS chars FROM archive"))).toBe(true);
  });

  it("the file is 0600 and so are its WAL and shared-memory files", () => {
    const { a, file } = open();
    try {
      a.put("botA", [row("e:1", "hello")]);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        expect(fs.existsSync(f), `${path.basename(f)} exists`).toBe(true);
        expect(fs.statSync(f).mode & 0o777, path.basename(f)).toBe(0o600);
      }
    } finally { a.close(); }
  });
});
