import { renderSummary, applyEvents, type Category, type SummaryEvent, type SummaryItem } from "./compactor-sim";
import { Rng } from "./rng";
import {
  ASIDE_ATTRS, ATTRS, BURIED_ATTRS, CITIES, DAYS, DOC_ATTRS, DOC_KINDS, FILLER_ORGS, MULTI_ATTRS, PEOPLE, PREFS, REPOS,
  SUPERSEDE_ATTRS, TOOLS, TOPICS, coinName, valueOf,
} from "./vocab";

/**
 * The long-term context recall corpus of docs/lab/context-bakeoff-brief.md, generated offline from a
 * seed. Everything the scorer needs is here: the raw archive (turns), our compactor's summary chain,
 * the memory files our extractor would have written, the documents, and the questions with their
 * ground truth. questions.jsonl carries only the brief's fields; the reader's extra truth (the key a
 * fact is stated under, stale values) lives in `truth`.
 */
export const KINDS = ["buried", "summarised", "superseded", "scattered", "document", "negative"] as const;
export type Kind = (typeof KINDS)[number];
export const NOT_IN_DATA = "not in the data";

export interface BenchConfig {
  seed: number; asOf: string; years: number; sessions: number; turnsPerSession: number;
  /** The brief: "every ~150 turns the old turns are replaced by a ~1,500-token summary". */
  compactEvery: number; summaryMaxTokens: number;
  documents: number; docPagesMax: number; pageChars: number; perKind: number;
}
const BASE = { seed: 20260921, asOf: "2026-09-21", years: 5, turnsPerSession: 10, compactEvery: 150, summaryMaxTokens: 1500 };
export const SCALES = {
  /** Wired into npm test with a pinned baseline. */
  small: { ...BASE, sessions: 80, documents: 6, docPagesMax: 40, pageChars: 600, perKind: 6 },
  /** The brief's corpus: ~20,000 turns over ~2,000 sessions, ~200 documents of 1–500 pages. */
  full: { ...BASE, sessions: 2000, documents: 200, docPagesMax: 500, pageChars: 1200, perKind: 40 },
} satisfies Record<string, BenchConfig>;

export interface Question { id: string; kind: Kind; question: string; answer: string; evidence: string[]; asOf: string }
export interface Truth { key: string; mode: "latest" | "all"; stale: string[] }
export interface Turn { id: string; date: string; session: number; seq: number; speaker: "user" | "assistant"; text: string }
export interface Summary { id: string; n: number; date: string; afterSeq: number; text: string; sources: string[] }
export interface Doc { id: string; title: string; pages: string[] }
export type MemTier = "profile" | "log" | "none";
export interface MemFact { date: string; tier: "profile" | "log"; kind: "fact" | "note" | "episode"; content: string; source: string }
/**
 * Gold (subject, relation, object, valid_from) triples for the planted facts, for scoring a fact
 * ledger at its CEILING. Kept apart from the questions and answers (bench/gold-facts.jsonl): a
 * realistic-extraction run must never read it. cardinality "many" marks a relation that
 * accumulates (a list) rather than replacing; evidence is the raw source the triple was stated in.
 */
export interface GoldFact { subject: string; relation: string; object: string; valid_from: string; cardinality: "one" | "many"; evidence: string }
/** What a retriever may see: the archive, never the questions, truth or gold facts. */
export interface Archive {
  asOf: string; botId: string; turns: Turn[]; summaries: Summary[]; lastBoundarySeq: number; docs: Doc[]; memoryFacts: MemFact[];
}
export interface Corpus extends Archive {
  config: BenchConfig; questions: Question[]; truth: Record<string, Truth>; gold: GoldFact[];
}
export function archiveOf(c: Corpus): Archive {
  return { asOf: c.asOf, botId: c.botId, turns: c.turns, summaries: c.summaries, lastBoundarySeq: c.lastBoundarySeq, docs: c.docs, memoryFacts: c.memoryFacts };
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const BOT_ID = "bench-bot";

interface Plant { text: string; bare?: boolean; cat: Category | "aside"; slot: string; itemText: string; mem: MemTier; memContent: string; removes?: string; gold?: GoldFact }
const SUPERSEDE_TEMPLATES: ((k: string, v: string) => string)[] = [
  (k, v) => `Let's lock it in: the ${k} is ${v}.`, (k, v) => `For the record, the ${k} is ${v}.`, (k, v) => `Noting it here: the ${k} is ${v}.`,
];
type MemOp = { op: "add"; f: MemFact } | { op: "remove"; content: string };

export function generateCorpus(cfg: BenchConfig): Corpus {
  const root = new Rng(cfg.seed);
  const rPlan = root.fork("plan"), rText = root.fork("text"), rDocs = root.fork("docs"), rName = root.fork("names");
  const end = Date.parse(`${cfg.asOf}T00:00:00Z`);
  const start = end - Math.round(cfg.years * 365.25) * DAY;
  const span = end - DAY - start;

  // ---- the skeleton: sessions spread over the years, turns alternating user / assistant ----
  const turns: Turn[] = [];
  const perDate = new Map<string, number>();
  for (let s = 0; s < cfg.sessions; s++) {
    const date = iso(start + Math.floor(((s + rPlan.next()) / cfg.sessions) * span / DAY) * DAY);
    for (let k = 0; k < cfg.turnsPerSession; k++) {
      const n = (perDate.get(date) ?? 0) + 1;
      perDate.set(date, n);
      turns.push({ id: `turn:${date}#t${n}`, date, session: s, seq: turns.length, speaker: k % 2 === 0 ? "user" : "assistant", text: "" });
    }
  }
  const lastBoundarySeq = Math.floor((turns.length - 1) / cfg.compactEvery) * cfg.compactEvery;
  const userSeqs = turns.filter((t) => t.speaker === "user" && t.seq < lastBoundarySeq).map((t) => t.seq);
  const used = new Set<number>();
  const names = new Set<string>([...FILLER_ORGS]);
  const plants = new Map<number, Plant>();
  const questions: Omit<Question, "id">[] = [];
  const truth: Truth[] = [];
  const daysBefore = (seq: number) => (end - Date.parse(`${turns[seq]!.date}T00:00:00Z`)) / DAY;
  const take = (ok: (seq: number) => boolean): number => {
    const pool = userSeqs.filter((s) => !used.has(s) && ok(s));
    if (!pool.length) throw new Error("bench corpus: no free turn for a planted fact; raise the scale");
    const s = rPlan.pick(pool);
    used.add(s);
    return s;
  };
  const goldFacts: GoldFact[] = [];
  const gold = (key: string, object: string, cardinality: GoldFact["cardinality"]): GoldFact => {
    const [subject, ...rel] = key.split(" ");
    return { subject: subject!, relation: rel.join(" "), object, valid_from: "", cardinality, evidence: "" };
  };
  const memContent = (key: string, v: string) => `The user said the ${key} is ${v}.`;
  const add = (q: Omit<Question, "id" | "asOf">, t: Truth) => { questions.push({ ...q, asOf: cfg.asOf }); truth.push(t); };

  // buried: once, 3+ years ago
  for (let i = 0; i < cfg.perKind; i++) {
    const key = `${coinName(rName, names)} ${rPlan.pick(BURIED_ATTRS)}`;
    const v = valueOf(rPlan, ATTRS[key.split(" ").slice(1).join(" ")]!);
    const seq = take((s) => daysBefore(s) >= 3 * 365 + 5);
    const mem = rPlan.weighted({ profile: 0.3, log: 0.5, none: 0.2 });
    plants.set(seq, { text: rPlan.pick([`For the record, the ${key} is ${v}.`, `We agreed the ${key} is ${v}.`, `Quick note so it's written down: the ${key} is ${v}.`]), cat: "decision", slot: key, itemText: `the ${key} is ${v}`, mem, memContent: memContent(key, v), gold: gold(key, v, "one") });
    add({ kind: "buried", question: `What did we agree the ${key} would be?`, answer: v, evidence: [turns[seq]!.id] }, { key, mode: "latest", stale: [] });
  }
  // summarised away: an aside (compact.md drops small talk), inside the last three years
  const asides = Object.keys(ASIDE_ATTRS);
  for (let i = 0; i < cfg.perKind; i++) {
    const attr = asides[i % asides.length]!;
    const key = `${coinName(rName, names)} ${attr}`;
    const v = valueOf(rPlan, attr);
    const seq = take((s) => daysBefore(s) < 3 * 365 - 5);
    const mem = rPlan.weighted({ log: 0.4, none: 0.6 });
    plants.set(seq, { text: `Random aside, not important: the ${key} is ${v}.`, cat: "aside", slot: key, itemText: "", mem, memContent: memContent(key, v), gold: gold(key, v, "one") });
    add({ kind: "summarised", question: `What is the ${key}?`, answer: v, evidence: [turns[seq]!.id] }, { key, mode: "latest", stale: [] });
  }
  // superseded: stated early (and repeated), later changed; the latest wins
  for (let i = 0; i < cfg.perKind; i++) {
    const attr = rPlan.pick(SUPERSEDE_ATTRS);
    const key = `${coinName(rName, names)} ${attr}`;
    const values: string[] = [];
    const nValues = rPlan.int(2, 3);
    while (values.length < nValues) { const v = valueOf(rPlan, ATTRS[attr]!); if (!values.includes(v)) values.push(v); }
    const first = take((s) => s < userSeqs.at(-1)! * 0.4);
    const repeats = rPlan.int(0, 2);
    const seqs = [first, ...Array.from({ length: repeats }, () => take((s) => s > first && s < userSeqs.at(-1)! * 0.5))].sort((a, b) => a - b);
    let prev = seqs.at(-1)!;
    const updates = values.slice(1).map(() => { prev = take((s) => s > prev && s < userSeqs.at(-1)! * 0.95 && s <= prev + userSeqs.at(-1)! * 0.3); return prev; });
    const mem = rPlan.weighted({ profile: 0.3, log: 0.7 });
    // MARKER-FREE (lab review): the stale and the current turn differ only in the value. One template
    // per key, no chatter around it, no "now" / "update" / "changed to" cue for a retriever to key on.
    const say = rPlan.pick(SUPERSEDE_TEMPLATES);
    const plant = (v: string, removes?: string): Plant => ({
      text: say(key, v), bare: true, cat: "decision", slot: key, itemText: `the ${key} is ${v}`, mem, memContent: memContent(key, v), removes, gold: gold(key, v, "one"),
    });
    seqs.forEach((s) => plants.set(s, plant(values[0]!)));
    updates.forEach((s, j) => plants.set(s, plant(values[j + 1]!, memContent(key, values[j]!))));
    add({ kind: "superseded", question: `What is the ${key}?`, answer: values.at(-1)!, evidence: [turns[updates.at(-1)!]!.id] }, { key, mode: "latest", stale: values.slice(0, -1) });
  }
  // scattered: 3–6 facts from different months, combined
  const multi = Object.keys(MULTI_ATTRS);
  for (let i = 0; i < cfg.perKind; i++) {
    const attr = multi[i % multi.length]!;
    const key = `${coinName(rName, names)} ${attr}`;
    const n = rPlan.int(3, 6);
    const months = new Set<string>();
    const seqs: number[] = [];
    while (seqs.length < n) {
      const s = take((x) => !months.has(turns[x]!.date.slice(0, 7)));
      months.add(turns[s]!.date.slice(0, 7));
      seqs.push(s);
    }
    seqs.sort((a, b) => a - b);
    const values: string[] = [];
    while (values.length < n) { const v = valueOf(rPlan, MULTI_ATTRS[attr]!); if (!values.includes(v)) values.push(v); }
    const mem = rPlan.weighted({ log: 0.7, none: 0.3 });
    seqs.forEach((s, j) => plants.set(s, { text: `Adding one more to the list: a ${key} is ${values[j]}.`, cat: "decision", slot: `${key}|${values[j]}`, itemText: `a ${key} is ${values[j]}`, mem, memContent: `The user said a ${key} is ${values[j]}.`, gold: gold(key, values[j]!, "many") }));
    add({ kind: "scattered", question: `List every ${key} we've named over time, oldest first.`, answer: values.join(", "), evidence: seqs.map((s) => turns[s]!.id) }, { key, mode: "all", stale: [] });
  }

  // ---- documents: 1–docPagesMax pages; the first is the flagship at exactly docPagesMax ----
  const docs: Doc[] = [];
  for (let d = 0; d < cfg.documents; d++) {
    const pages = d === 0 ? cfg.docPagesMax : Math.max(1, Math.ceil(cfg.docPagesMax * rDocs.next() ** 3));
    const org = d < cfg.perKind ? coinName(rName, names) : rDocs.pick(FILLER_ORGS);
    const title = `${org} ${rDocs.pick(DOC_KINDS)}`;
    docs.push({ id: `d${String(d + 1).padStart(3, "0")}`, title, pages: Array.from({ length: pages }, (_, p) => docPage(rDocs, title, p + 1, cfg.pageChars)) });
  }
  const docOrder = [docs[0]!, ...docs.slice(1, cfg.perKind).sort((a, b) => b.pages.length - a.pages.length)];
  for (let i = 0; i < cfg.perKind; i++) {
    const doc = docOrder[i]!;
    const org = doc.title.split(" ")[0]!;
    const attr = rPlan.pick(Object.keys(DOC_ATTRS));
    const key = `${org} ${attr}`;
    const v = valueOf(rPlan, DOC_ATTRS[attr]!);
    const page = Math.max(1, Math.round((doc.pages.length * 312) / 500));
    const text = doc.pages[page - 1]!;
    const found = text.indexOf(". ", Math.floor(text.length / 2));
    const cut = found < 0 ? text.length : found + 2;
    doc.pages[page - 1] = `${text.slice(0, cut)}${found < 0 ? " " : ""}Clause ${rDocs.int(4, 30)}.${rDocs.int(1, 9)}: the ${key} is ${v}. ${text.slice(cut)}`.trimEnd();
    const mention = take(() => true);
    plants.set(mention, { text: `I put the ${doc.title} in the shared folder, ${doc.pages.length} pages.`, cat: "identifier", slot: `doc:${doc.id}`, itemText: `The user shared the ${doc.title} (${doc.pages.length} pages)`, mem: "log", memContent: `The user shared the ${doc.title} (${doc.pages.length} pages).`, gold: { ...gold(key, v, "one"), evidence: `doc:${doc.id}#p${page}` } });
    add({ kind: "document", question: `According to the ${doc.title}, what is the ${key}?`, answer: v, evidence: [`doc:${doc.id}#p${page}`] }, { key, mode: "latest", stale: [] });
  }

  // ---- the chatter, the summary events and the memory the extractor would write ----
  const events = new Map<number, SummaryEvent[]>();
  const memOps: MemOp[] = [];
  const ev = (seq: number, e: SummaryEvent) => events.set(seq, [...(events.get(seq) ?? []), e]);
  const openTasks: { slot: string; closeAt: number }[] = [];
  let exchanges = 0;
  const topicsSince: string[] = [];
  for (const t of turns) {
    const topic = rText.pick(TOPICS), person = rText.pick(PEOPLE), day = rText.pick(DAYS);
    if (t.speaker === "user") {
      let text = rText.pick(userChatter(topic, person, day));
      topicsSince.push(topic);
      const plant = plants.get(t.seq);
      if (plant) {
        text = plant.bare ? plant.text : `${text} ${plant.text}`;
        if (plant.gold) {
          const g = { ...plant.gold, valid_from: t.date, evidence: plant.gold.evidence || t.id };
          const prev = goldFacts.findLast((x) => x.subject === g.subject && x.relation === g.relation);
          if (!(g.cardinality === "one" && prev?.object === g.object)) goldFacts.push(g); // a repeat is not a new fact
        }
        if (plant.cat !== "aside") ev(t.seq, { op: "add", item: { cat: plant.cat, slot: plant.slot, date: t.date, text: plant.itemText, sources: [t.id] } });
        if (plant.removes && plant.mem !== "none") memOps.push({ op: "remove", content: plant.removes });
        if (plant.mem !== "none") memOps.push({ op: "add", f: { date: t.date, tier: plant.mem, kind: "fact", content: plant.memContent, source: t.id } });
      } else if (rText.chance(0.45)) {
        const f = fillerStatement(rText, t, topic);
        text = `${text} ${f.text}`;
        if (f.item) ev(t.seq, { op: "add", item: f.item });
        if (f.mem) memOps.push({ op: "add", f: f.mem });
        if (f.item?.cat === "task") openTasks.push({ slot: f.item.slot, closeAt: t.seq + rText.int(10, 60) });
      }
      for (const o of openTasks.filter((x) => x.closeAt <= t.seq)) {
        ev(t.seq, { op: "close", slot: o.slot });
        openTasks.splice(openTasks.indexOf(o), 1);
      }
      t.text = text;
    } else {
      let text = rText.pick(assistantChatter(topic, person, day, rText.int(2, 6), rText.int(8, 17)));
      if (rText.chance(0.12)) {
        text = `${text} I'll check back on ${topic} ${day}.`;
        ev(t.seq, { op: "add", item: { cat: "commitment", slot: `commit:${topic}`, date: t.date, text: `Check back on ${topic} (promised ${day})`, sources: [t.id] } });
      } else if (rText.chance(0.05)) {
        const tool = rText.pick(TOOLS);
        text = `${text} The ${tool} failed with a timeout; retrying with a smaller batch worked.`;
        ev(t.seq, { op: "add", item: { cat: "error", slot: `err:${tool}`, date: t.date, text: `${tool} timed out; a smaller batch fixed it`, sources: [t.id] } });
      }
      t.text = text;
      if (++exchanges % 6 === 0) { // MEM-06: an [episode] line every 6 visible turns
        const ts = [...new Set(topicsSince.splice(0))].slice(0, 2);
        memOps.push({ op: "add", f: { date: t.date, tier: "log", kind: "episode", content: `Worked with the user on ${ts.join(" and ")}.`, source: t.id } });
      }
    }
  }

  // ---- the summary chain ----
  const summaries: Summary[] = [];
  let state: SummaryItem[] = [];
  let pending: SummaryEvent[] = [];
  for (const t of turns) {
    if (t.seq > 0 && t.seq % cfg.compactEvery === 0) {
      const n = summaries.length + 1;
      const upTo = turns[t.seq - 1]!.date;
      const r = renderSummary({ items: applyEvents(state, pending), n, upTo, botId: BOT_ID, maxTokens: cfg.summaryMaxTokens });
      state = r.items;
      pending = [];
      summaries.push({ id: `summary:${n}`, n, date: upTo, afterSeq: t.seq, text: r.text, sources: [...new Set(r.items.flatMap((i) => i.sources))] });
    }
    pending.push(...(events.get(t.seq) ?? []));
  }

  // ---- memory files: the extractor's adds (deduped like MemoryStore.add) and removes ----
  const memByKey = new Map<string, MemFact>(); // insertion order = file order
  const keyOf = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  for (const o of memOps) {
    if (o.op === "remove") memByKey.delete(keyOf(o.content));
    else if (!memByKey.has(keyOf(o.f.content))) memByKey.set(keyOf(o.f.content), o.f);
  }
  const mem = [...memByKey.values()];

  // ---- negatives: a subject that appears nowhere ----
  const haystack = [...turns.map((t) => t.text), ...docs.flatMap((d) => d.pages), ...summaries.map((s) => s.text), ...mem.map((f) => f.content)].join("\n").toLowerCase();
  for (let i = 0; i < cfg.perKind; i++) {
    let subject: string;
    do subject = coinName(rName, names); while (haystack.includes(subject.toLowerCase()));
    const attr = rPlan.pick([...SUPERSEDE_ATTRS, ...BURIED_ATTRS]);
    const key = `${subject} ${attr}`;
    add({ kind: "negative", question: `What did we agree the ${key} would be?`, answer: NOT_IN_DATA, evidence: [] }, { key, mode: "latest", stale: [] });
  }

  const qs = questions.map((q, i) => ({ id: `q-${String(i + 1).padStart(4, "0")}`, ...q }));
  return {
    config: cfg, asOf: cfg.asOf, botId: BOT_ID, turns, summaries, lastBoundarySeq, docs, memoryFacts: mem, questions: qs, gold: goldFacts,
    truth: Object.fromEntries(qs.map((q, i) => [q.id, truth[i]!])),
  };
}

export function questionsJsonl(c: Corpus): string {
  return c.questions.map((q) => JSON.stringify({ id: q.id, kind: q.kind, question: q.question, answer: q.answer, evidence: q.evidence, asOf: q.asOf })).join("\n") + "\n";
}

export function goldJsonl(c: Corpus): string {
  return c.gold.map((g) => JSON.stringify({ subject: g.subject, relation: g.relation, object: g.object, valid_from: g.valid_from, cardinality: g.cardinality, evidence: g.evidence })).join("\n") + "\n";
}

function userChatter(topic: string, person: string, day: string): string[] {
  return [
    `Morning. Can you pull together notes on ${topic} for ${person}?`,
    `${person} pinged me about ${topic} again, can you draft a reply?`,
    `What's on my calendar ${day}?`,
    `Remind me to follow up with ${person} about ${topic} ${day}.`,
    `Can you summarize the thread about ${topic}?`,
    `ugh, long day. ${topic} is eating my week`,
    `Book a table somewhere near the office ${day}, for me and ${person}.`,
    `Did ${person} ever answer about ${topic}?`,
    `ok, thanks`,
  ];
}
function assistantChatter(topic: string, person: string, day: string, n: number, h: number): string[] {
  return [
    `Done. I drafted a reply to ${person} and left it for you to review.`,
    `You have ${n} meetings ${day}; the first is with ${person} at ${h}:00.`,
    `Here's the short version of the ${topic} thread: three open questions, one decision pending.`,
    `Reminder set for ${day}.`,
    `Sounds like a lot. Want me to block focus time tomorrow morning?`,
    `Not yet. I'll flag it the moment ${person} replies.`,
    `Booked, and I added it to your calendar.`,
  ];
}

function fillerStatement(r: Rng, t: Turn, topic: string): { text: string; item?: SummaryItem; mem?: MemFact } {
  const kind = r.weighted({ preference: 0.1, decision: 0.35, identifier: 0.15, task: 0.15, smalltalk: 0.25 });
  const org = r.pick(FILLER_ORGS);
  const src = [t.id];
  if (kind === "preference") {
    // Profile facts accrue over the years (preferences per context), so profile.md outgrows its 100-line render.
    const p = `${r.pick(PREFS)} for ${topic}`;
    return { text: `Also, going forward I prefer ${p}.`, item: { cat: "preference", slot: `pref:${p}`, date: t.date, text: `The user prefers ${p}`, sources: src }, mem: { date: t.date, tier: "profile", kind: "fact", content: `The user prefers ${p}.`, source: t.id } };
  }
  if (kind === "decision") {
    const attr = r.pick(Object.keys(ATTRS));
    const key = `${org} ${attr}`;
    const v = valueOf(r, ATTRS[attr]!);
    return { text: `For ${topic}: the ${key} is ${v}.`, item: { cat: "decision", slot: key, date: t.date, text: `the ${key} is ${v}`, sources: src }, mem: { date: t.date, tier: "log", kind: "fact", content: `The user said the ${key} is ${v}.`, source: t.id } };
  }
  if (kind === "identifier") {
    const repo = r.pick(REPOS), branch = `feat-${r.int(100, 999)}`;
    return { text: `The code for ${topic} lives in github.com/acme/${repo}, branch ${branch}.`, item: { cat: "identifier", slot: `id:${topic}`, date: t.date, text: `${topic}: github.com/acme/${repo} on ${branch}`, sources: src }, mem: { date: t.date, tier: "log", kind: "fact", content: `The code for ${topic} lives in github.com/acme/${repo} on branch ${branch}.`, source: t.id } };
  }
  if (kind === "task") {
    const who = r.pick(PEOPLE);
    return { text: `Can you chase ${who} about ${topic} until it's sorted?`, item: { cat: "task", slot: `task:${who}:${topic}`, date: t.date, text: `Chase ${who} about ${topic} (asked by the user); next: email them`, sources: src }, mem: { date: t.date, tier: "log", kind: "note", content: `Waiting on ${who} about ${topic}.`, source: t.id } };
  }
  return { text: r.pick([`The weather in ${r.pick(CITIES)} was lovely this weekend.`, `I finally watched that documentary ${r.pick(PEOPLE)} recommended.`, `My coffee went cold again.`]) };
}

function docPage(r: Rng, subject: string, page: number, chars: number): string {
  const parts = [`${subject}, page ${page}.`];
  let len = parts[0]!.length;
  while (len < chars) {
    const s = r.pick([
      `Section ${page}.${r.int(1, 20)}. The parties shall deliver the ${r.pick(["report", "invoice", "schedule", "notice"])} within ${r.int(5, 60)} days of the ${r.pick(["effective date", "request", "quarter end"])}.`,
      `The ${r.pick(["supplier", "client", "licensee", "tenant"])} will keep records of all ${r.pick(["payments", "changes", "incidents", "approvals"])} for ${r.int(2, 7)} years.`,
      `Notices go to ${r.pick(PEOPLE)} at the registered address, with a copy by email.`,
      `Nothing in this ${r.pick(["section", "schedule", "annex"])} limits the rights set out in ${r.pick(["clause", "section"])} ${r.int(1, 40)}.`,
      `Minutes: ${r.pick(PEOPLE)} walked through ${r.pick(TOPICS)}; no objections were raised.`,
    ]);
    parts.push(s);
    len += s.length + 1;
  }
  return parts.join(" ");
}
