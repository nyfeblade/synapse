import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { fillTemplate, loadPrompt } from "../../prompts/index";
import { KINDS, SCALES, archiveOf, generateCorpus, goldJsonl, questionsJsonl, type Corpus } from "../../bench/corpus";

const small = generateCorpus(SCALES.small);
const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY;
const hash = (c: Corpus) => createHash("sha256").update(JSON.stringify([c.turns, c.summaries, c.docs, c.memoryFacts, c.questions])).digest("hex");
const allText = (c: Corpus) => [...c.turns.map((t) => t.text), ...c.summaries.map((s) => s.text), ...c.docs.flatMap((d) => d.pages), ...c.memoryFacts.map((f) => f.content)];
const turnOf = (c: Corpus, id: string) => c.turns.find((t) => t.id === id)!;
const kindQs = (k: string) => small.questions.filter((q) => q.kind === k);

describe("synthetic corpus generator", () => {
  it("is deterministic for a seed, and a different seed gives a different corpus", () => {
    expect(hash(generateCorpus(SCALES.small))).toBe(hash(small));
    expect(hash(generateCorpus({ ...SCALES.small, seed: SCALES.small.seed + 1 }))).not.toBe(hash(small));
  });

  it("builds the configured scale: sessions, speaker-tagged dated turns over the span, documents", () => {
    const c = SCALES.small;
    expect(small.turns).toHaveLength(c.sessions * c.turnsPerSession);
    expect(new Set(small.turns.map((t) => t.session)).size).toBe(c.sessions);
    expect(new Set(small.turns.map((t) => t.id)).size).toBe(small.turns.length);
    for (const t of small.turns) expect(t.id).toMatch(/^turn:\d{4}-\d{2}-\d{2}#t\d+$/);
    expect(small.turns.filter((t) => t.speaker === "user").length).toBe(small.turns.length / 2);
    expect(days(small.turns[0]!.date, c.asOf)).toBeGreaterThan(c.years * 365 - 60);
    expect(small.turns.at(-1)!.date < c.asOf).toBe(true);
    expect(small.docs).toHaveLength(c.documents);
    expect(Math.max(...small.docs.map((d) => d.pages.length))).toBe(c.docPagesMax);
    expect(Math.min(...small.docs.map((d) => d.pages.length))).toBeGreaterThanOrEqual(1);
  });

  it("plants every kind, perKind questions each, with unique q-NNNN ids", () => {
    for (const k of KINDS) expect(kindQs(k)).toHaveLength(SCALES.small.perKind);
    expect(small.questions.map((q) => q.id)).toEqual(small.questions.map((_, i) => `q-${String(i + 1).padStart(4, "0")}`));
  });

  it("buried: said once, 3+ years before asOf, never repeated", () => {
    for (const q of kindQs("buried")) {
      const t = small.truth[q.id]!;
      expect(q.evidence).toHaveLength(1);
      expect(days(turnOf(small, q.evidence[0]!).date, q.asOf)).toBeGreaterThanOrEqual(3 * 365);
      expect(small.turns.filter((x) => x.text.toLowerCase().includes(t.key.toLowerCase())).length).toBe(1);
      expect(turnOf(small, q.evidence[0]!).text).toContain(`${t.key} is ${q.answer}`);
    }
  });

  it("summarised: present in a raw turn before the last compaction, absent from every summary", () => {
    for (const q of kindQs("summarised")) {
      const t = small.truth[q.id]!;
      const turn = turnOf(small, q.evidence[0]!);
      expect(turn.text).toContain(`${t.key} is ${q.answer}`);
      expect(turn.seq).toBeLessThan(small.lastBoundarySeq);
      for (const s of small.summaries) expect(s.text.toLowerCase()).not.toContain(t.key.toLowerCase());
    }
  });

  it("superseded: an earlier value is stated first, the answer is the latest statement", () => {
    for (const q of kindQs("superseded")) {
      const t = small.truth[q.id]!;
      expect(t.stale.length).toBeGreaterThanOrEqual(1);
      expect(t.stale).not.toContain(q.answer);
      const mentions = small.turns.filter((x) => x.text.includes(`${t.key} is `));
      expect(mentions.at(-1)!.id).toBe(q.evidence[0]);
      expect(mentions.at(-1)!.text).toContain(`${t.key} is ${q.answer}`);
      expect(mentions.length).toBeGreaterThanOrEqual(2);
      expect(t.stale.some((v) => mentions[0]!.text.includes(`${t.key} is ${v}`))).toBe(true);
    }
  });

  it("superseded is MARKER-FREE: stale and current turns differ only in the value, with no wording cue", () => {
    for (const q of kindQs("superseded")) {
      const t = small.truth[q.id]!;
      const mentions = small.turns.filter((x) => x.text.includes(`${t.key} is `));
      const shapes = new Set(mentions.map((m) => [q.answer, ...t.stale].reduce((s, v) => s.replace(`${t.key} is ${v}`, `${t.key} is <V>`), m.text)));
      expect(shapes.size, [...shapes].join(" | ")).toBe(1);
      for (const m of mentions) expect(m.text).not.toMatch(/\b(now|updated?|update|changed?|change|scratch|instead|new|revised|anymore|actually)\b/i);
      expect(q.question).not.toMatch(/\bnow\b/i);
    }
  });

  it("gold triples: every planted fact, dated and sourced, enough to answer every non-negative question at the ceiling", () => {
    const g = small.gold;
    expect(g.length).toBeGreaterThan(0);
    for (const f of g) {
      expect(Object.keys(f)).toEqual(["subject", "relation", "object", "valid_from", "cardinality", "evidence"]);
      expect(f.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const q of small.questions) {
      const t = small.truth[q.id]!;
      const [subject, ...rel] = t.key.split(" ");
      const rows = g.filter((f) => f.subject === subject && f.relation === rel.join(" "));
      if (q.kind === "negative") { expect(rows).toEqual([]); continue; }
      const sorted = [...rows].sort((a, b) => (a.valid_from < b.valid_from ? -1 : a.valid_from > b.valid_from ? 1 : 0));
      expect(t.mode === "all" ? sorted.map((r) => r.object).join(", ") : sorted.at(-1)!.object).toBe(q.answer);
      expect(q.evidence.every((e) => rows.some((r) => r.evidence === e))).toBe(true);
    }
    // a repeated value is one fact, not two
    for (const q of kindQs("superseded")) expect(g.filter((f) => `${f.subject} ${f.relation}` === small.truth[q.id]!.key)).toHaveLength(small.truth[q.id]!.stale.length + 1);
  });

  it("gold triples are kept apart from the questions: no question id, kind or answer field", () => {
    const line = goldJsonl(small).split("\n")[0]!;
    for (const k of ["id", "kind", "question", "answer", "asOf"]) expect(Object.keys(JSON.parse(line) as object)).not.toContain(k);
    expect(Object.keys(archiveOf(small)).sort()).toEqual(["asOf", "botId", "docs", "lastBoundarySeq", "memoryFacts", "summaries", "turns"]);
  });

  it("scattered: 3–6 facts from different months, answer lists them oldest first", () => {
    for (const q of kindQs("scattered")) {
      expect(q.evidence.length).toBeGreaterThanOrEqual(3);
      expect(q.evidence.length).toBeLessThanOrEqual(6);
      const ts = q.evidence.map((e) => turnOf(small, e));
      expect(new Set(ts.map((t) => t.date.slice(0, 7))).size).toBe(ts.length);
      expect([...ts].sort((a, b) => a.seq - b.seq)).toEqual(ts);
      const values = q.answer.split(", ");
      ts.forEach((t, i) => expect(t.text).toContain(`${small.truth[q.id]!.key} is ${values[i]}`));
    }
  });

  it("document: the clause sits at page 312/500 of its document, and nowhere in turns, summaries or memory", () => {
    const qs = kindQs("document");
    const flagship = small.docs.find((d) => d.pages.length === SCALES.small.docPagesMax)!;
    expect(qs[0]!.evidence[0]).toBe(`doc:${flagship.id}#p${Math.round((SCALES.small.docPagesMax * 312) / 500)}`);
    for (const q of qs) {
      const [, docId, page] = /^doc:(.+)#p(\d+)$/.exec(q.evidence[0]!)!;
      const doc = small.docs.find((d) => d.id === docId)!;
      expect(Number(page)).toBe(Math.max(1, Math.round((doc.pages.length * 312) / 500)));
      const key = small.truth[q.id]!.key;
      expect(doc.pages[Number(page) - 1]).toContain(`${key} is ${q.answer}`);
      const elsewhere = [...small.turns.map((t) => t.text), ...small.summaries.map((s) => s.text), ...small.memoryFacts.map((f) => f.content)];
      expect(elsewhere.some((x) => x.includes(`${key} is`))).toBe(false);
    }
  });

  it("the full-scale flagship document is 500 pages with the clause on page 312", () => {
    expect(SCALES.full.docPagesMax).toBe(500);
    expect(Math.round((SCALES.full.docPagesMax * 312) / 500)).toBe(312);
  });

  it("negative: the subject never appears anywhere in the data", () => {
    const text = allText(small).join("\n").toLowerCase();
    for (const q of kindQs("negative")) {
      expect(q.evidence).toEqual([]);
      expect(q.answer).toBe("not in the data");
      const subject = small.truth[q.id]!.key.split(" ")[0]!.toLowerCase();
      expect(text.includes(subject)).toBe(false);
    }
  });

  it("the summary chain compacts every compactEvery turns, fits the budget and ends with the compact prompt's footer", () => {
    const c = SCALES.small;
    expect(small.summaries).toHaveLength(Math.floor((small.turns.length - 1) / c.compactEvery));
    const prompt = fillTemplate(loadPrompt("orig/compact.md"), { botName: "Bench", botId: small.botId });
    const footer = /"(Full history: [^"]+)"/.exec(prompt)![1]!;
    small.summaries.forEach((s, i) => {
      expect(s.afterSeq).toBe((i + 1) * c.compactEvery);
      expect(Math.ceil(s.text.length / 4)).toBeLessThanOrEqual(c.summaryMaxTokens);
      expect(s.text.trimEnd().endsWith(footer)).toBe(true);
    });
    expect(small.lastBoundarySeq).toBe(small.summaries.at(-1)!.afterSeq);
    // at full budget the chain is saturated: it cannot hold everything it was ever told
    expect(Math.ceil(small.summaries.at(-1)!.text.length / 4)).toBeGreaterThan(c.summaryMaxTokens * 0.8);
  });

  it("a superseded value never coexists with its update inside one summary (compact.md drops superseded plans)", () => {
    for (const q of kindQs("superseded")) {
      const t = small.truth[q.id]!;
      for (const s of small.summaries) {
        const hits = s.text.split("\n").filter((l) => l.includes(`${t.key} is `));
        expect(hits.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("questions.jsonl lines carry exactly the brief's fields, in its order", () => {
    const lines = questionsJsonl(small).trimEnd().split("\n");
    expect(lines).toHaveLength(small.questions.length);
    for (const l of lines) {
      const o = JSON.parse(l) as Record<string, unknown>;
      expect(Object.keys(o)).toEqual(["id", "kind", "question", "answer", "evidence", "asOf"]);
      expect(KINDS).toContain(o.kind);
      expect(o.asOf).toBe(SCALES.small.asOf);
    }
  });

  it("the committed bench/questions.jsonl is the full-scale generator's output in the brief's format", { timeout: 60_000 }, () => {
    const file = new URL("../../bench/questions.jsonl", import.meta.url);
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(KINDS.length * SCALES.full.perKind);
    for (const k of KINDS) expect(lines.filter((l) => l.kind === k)).toHaveLength(SCALES.full.perKind);
    for (const l of lines) expect(Object.keys(l)).toEqual(["id", "kind", "question", "answer", "evidence", "asOf"]);
    expect(lines.find((l) => l.kind === "document")!.evidence).toEqual([expect.stringMatching(/#p312$/)]);
    const full = generateCorpus(SCALES.full);
    expect(fs.readFileSync(file, "utf8")).toBe(questionsJsonl(full));
    expect(fs.readFileSync(new URL("../../bench/gold-facts.jsonl", import.meta.url), "utf8")).toBe(goldJsonl(full));
  });
});
