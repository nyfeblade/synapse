import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ArchiveNotReady, HistoryArchive, type ArchiveRow } from "../../history/archive";
import { interfaceFields } from "../guard-parse";

/**
 * THE CLASS: "a secret reaching the history archive in clear text."
 *
 * The archive (host/history/archive.ts) is a SQLite file of everything a Bot has said, heard, been
 * sent and summarised. Every row comes from text the user or the Bot typed, so any of it can carry a
 * key the user pasted, and the file outlives the chat. The redaction has to sit where no future
 * write path can route around it.
 *
 * THE RULE (declaration style, no allowlist):
 *  1. Every public method of HistoryArchive is declared here exactly once, by what it does to the
 *     file. A method that writes user text is swept with a canary.
 *  2. Every field of ArchiveRow is declared: TEXT (redacted and swept) or NOT_TEXT with a reason
 *     saying why no user text can reach it.
 *  3. Every SQL statement that writes the rows table lives in the one method that redacts.
 *  4. Only archive.ts in host/history may open SQLite, so the indexer cannot write around it.
 *  5. No redactor yet (Phase 3 not up) means the write is refused, never stored unredacted.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const SRC = fs.readFileSync(path.join(repoRoot, "host", "history", "archive.ts"), "utf8");

/** Public method names of `class <name>`: every member at class depth 1 that is not private/constructor. */
export function publicMethods(src: string, name: string): string[] {
  const m = new RegExp(`class\\s+${name}\\b[^{]*\\{`).exec(src);
  if (!m) return [];
  let depth = 0, i = src.indexOf("{", m.index);
  const start = i + 1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  const body = src.slice(start, i);
  const out: string[] = [];
  let d = 0, line = "";
  for (const ch of body) {
    if (d === 0) line += ch;
    if (ch === "{") d++;
    else if (ch === "}") d--;
    if (d === 0 && (ch === "\n" || ch === "}")) {
      const mm = /^\s*(?:(?:public|static|async|readonly)\s+)*([A-Za-z_]\w*)\s*(?:<[^>]*>)?\(/.exec(line);
      if (mm && !/^\s*(private|protected|#)/.test(line) && mm[1] !== "constructor") out.push(mm[1]!);
      line = "";
    }
  }
  return [...new Set(out)];
}

/** Body of `name(...) { ... }` inside the source. */
function methodBody(src: string, name: string): string {
  const m = new RegExp(`\\n\\s*(?:private\\s+)?${name}\\s*\\(`).exec(src);
  if (!m) return "";
  let i = src.indexOf("{", src.indexOf(")", m.index)), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

const WRITES_USER_TEXT: Record<string, string> = {
  put: "the one writer of archive rows: transcript entries, compaction summaries and document chunks all arrive here, and every text column is redacted inside it before the INSERT.",
};
const OTHER: Record<string, string> = {
  search: "reads rows for one Bot, scoped by the bot id the host passes; it writes nothing.",
  around: "reads the neighbouring rows of one hit for one Bot, scoped the same way; it writes nothing.",
  stats: "counts one Bot's rows and bytes for the storage readout; it writes nothing.",
  has: "answers whether a source id is already indexed (idempotency), for one Bot; it writes nothing.",
  getMeta: "reads a host bookkeeping value (a backfill cursor); it writes nothing.",
  setMeta: "writes host bookkeeping only: backfill cursors (counts and session-file sizes) keyed by bot id. The indexer never passes it message text; keys and values are numbers and ids the host generated.",
  removeBot: "deletes a Bot's rows and cursors when the Bot is deleted; it only removes text.",
  close: "closes the database handle; it neither reads nor writes any row.",
};

const TEXT_FIELDS: Record<string, string> = {
  ctx: "the contextual prefix (Bot name, date, speaker, document title and section). A document title and a Bot name are user-typed, so it is redacted like the body.",
  body: "the original wording of the turn, summary or document chunk, which is exactly where a pasted key lands.",
  speaker: "who said it: 'user', 'you' or another Bot's display name, and a name is user-typed.",
};
const NOT_TEXT: Record<string, string> = {
  src: "the idempotency key the host builds from an entry id, a summary hash or an attachment id plus a chunk number; the host generates every part of it and none of it is message text.",
  stream: "which sequence a row belongs to ('chat', 'summary' or 'doc:<attachment id>'), host-generated, used to fetch neighbours.",
  at: "a millisecond timestamp, a number; it cannot hold text at all.",
};

const CANARY = "canary-archive-7Qx3v-do-not-persist";
const VAULT_ONLY = "vault-only-9Lm2p-value";

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "archive-guard-")); }
function bytesIn(dir: string): string {
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "latin1")).join("\n");
}
const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({ src: "e:t1u", stream: "chat", at: 1_700_000_000_000, speaker: "user", ctx: "Nova · 2023-11-14 · user", body: "hello", ...over });
/** The scanner stand-in: redacts CANARY (as the Phase 3 scanner does for a vault value). */
const scanner = (_b: string, t: string) => t.split(CANARY).join("[secret:API_KEY]");

describe("the history archive never stores a secret in clear text", () => {
  it("finds what it checks at all (the guard's own smoke test)", () => {
    expect(publicMethods(SRC, "HistoryArchive")).toContain("put");
    expect(publicMethods(SRC, "HistoryArchive").length, "too few methods parsed; the guard is blind").toBeGreaterThan(4);
    expect(interfaceFields(SRC, "ArchiveRow")).toContain("body");
    expect(methodBody(SRC, "put")).toMatch(/INSERT/);
  });

  it("every public method is declared exactly once, and no declaration is stale", () => {
    const methods = publicMethods(SRC, "HistoryArchive");
    const declared = { ...WRITES_USER_TEXT, ...OTHER };
    expect(methods.filter((m) => !declared[m]), "declare the new method: does it write user text into the archive?").toEqual([]);
    expect(Object.keys(declared).filter((m) => !methods.includes(m)), "stale declaration").toEqual([]);
    expect(Object.keys(WRITES_USER_TEXT).filter((m) => OTHER[m])).toEqual([]);
  });

  it("every ArchiveRow field is declared TEXT or NOT_TEXT, and no declaration is stale", () => {
    const fields = interfaceFields(SRC, "ArchiveRow");
    expect(fields.filter((f) => !TEXT_FIELDS[f] && !NOT_TEXT[f]), "declare the new field: can user text reach it?").toEqual([]);
    expect([...Object.keys(TEXT_FIELDS), ...Object.keys(NOT_TEXT)].filter((f) => !fields.includes(f))).toEqual([]);
    for (const [f, why] of Object.entries({ ...TEXT_FIELDS, ...NOT_TEXT, ...WRITES_USER_TEXT, ...OTHER })) expect(why.length, `${f}'s reason is too thin`).toBeGreaterThan(40);
  });

  it("every SQL write to the archive table is inside put(), and put() cleans every TEXT field", () => {
    const writes = [...SRC.matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE)\s+archive\b/g)].map((m) => m.index!);
    expect(writes.length, "no write found; the pattern is blind").toBeGreaterThan(0);
    const put = methodBody(SRC, "put");
    const putAt = SRC.indexOf(put);
    for (const at of writes) expect(at >= putAt && at < putAt + put.length, `an archive write at offset ${at} is outside put()`).toBe(true);
    for (const f of Object.keys(TEXT_FIELDS)) expect(put, `put() must pass r.${f} through clean()`).toMatch(new RegExp(`clean\\([^)]*r\\.${f}\\b`));
  });

  it("only archive.ts opens SQLite in host/history (no second writer)", () => {
    const dir = path.join(repoRoot, "host", "history");
    const openers = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && /node:sqlite/.test(fs.readFileSync(path.join(dir, f), "utf8")));
    expect(openers).toEqual(["archive.ts"]);
  });

  it("the canary sweep: a secret in every TEXT field is unreadable in the db and its WAL; vault values too", () => {
    const dir = tmp();
    const a = new HistoryArchive(path.join(dir, "history.db"), { redact: scanner, secrets: () => [VAULT_ONLY] });
    try {
      const all = Object.fromEntries(Object.keys(TEXT_FIELDS).map((f) => [f, `marker ${CANARY} and ${VAULT_ONLY} y`]));
      a.put("botA", [row(all)]);
      a.put("botA", [row({ src: "e:t2u", ...all })]);
      const hit = a.search("botA", { query: "marker" });
      expect(hit.length, "the row must be stored, just redacted").toBeGreaterThan(0);
      const disk = bytesIn(dir);
      expect(disk.length).toBeGreaterThan(1000);
      expect(disk).not.toContain(CANARY);
      expect(disk).not.toContain(VAULT_ONLY);
      expect(JSON.stringify(hit)).not.toContain(CANARY);
      expect(JSON.stringify(hit)).toContain("[secret:API_KEY]");
    } finally { a.close(); }
  });

  it("must-not-fire: ordinary text is stored verbatim, and a lookalike that is no one's secret stays", () => {
    const dir = tmp();
    const a = new HistoryArchive(path.join(dir, "history.db"), { redact: scanner, secrets: () => [VAULT_ONLY, "abc"] });
    try {
      a.put("botA", [row({ body: "The Halvor budget is $55k. Token-shaped but harmless: canary-archive-0000." })]);
      expect(a.search("botA", { query: "halvor budget" })[0]!.text).toBe("The Halvor budget is $55k. Token-shaped but harmless: canary-archive-0000.");
    } finally { a.close(); }
  });

  it("fails closed: with no redactor ready, put() refuses and stores nothing", () => {
    const dir = tmp();
    const a = new HistoryArchive(path.join(dir, "history.db"), { redact: () => null, secrets: () => [] });
    try {
      expect(() => a.put("botA", [row({ body: `leak ${CANARY}` })])).toThrow(ArchiveNotReady);
      expect(a.stats("botA").rows).toBe(0);
      expect(bytesIn(dir)).not.toContain(CANARY);
    } finally { a.close(); }
  });

  it("the sweep would catch a leak (self-test: plaintext in the dir is found)", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "history.db-wal"), `junk ${CANARY} junk`);
    expect(bytesIn(dir)).toContain(CANARY);
  });
});
