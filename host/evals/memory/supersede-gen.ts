/**
 * Superseded-fact recall set (memory provenance). Written for this repo, independently of the context
 * lab's generator (docs/lab/context-bakeoff-brief.md): its own templates, its own RNG, its own traps.
 *
 * Every chain is MARKER-FREE: the old and the new sentence differ only in the value (no "now",
 * "updated", "changed to"), so recall can't win on wording. Distractors share words with the chains
 * (other people's dentists, other companies' budgets), and the multi-valued traps (two sisters, two
 * clients) must never collapse into one. Deterministic for a seed.
 */
export type Template = "role" | "company-attr" | "lives" | "works" | "favorite" | "meeting" | "manages" | "held-out";
export interface Chain { id: string; template: Template; tier: "profile" | "log"; old: string; new: string; oldValue: string; newValue: string; current: string; past: string }
export interface Trap { id: string; facts: string[]; values: string[]; question: string }
export interface SupersedeSet { chains: Chain[]; traps: Trap[]; distractors: string[] }

function lcg(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; };
}

const FIRST = ["Aurelio", "Birgitta", "Casimir", "Delphine", "Evander", "Fenella", "Gunnar", "Henrike", "Isidore", "Jolanta", "Kasimir", "Leocadia", "Mathis", "Noemi", "Osvaldo", "Philippa", "Quirin", "Rosalind", "Severin", "Theodora", "Ulrike", "Valentin", "Wilhelmina", "Xaver", "Yolanda", "Zdenek"];
const LAST = ["Achterberg", "Brennholt", "Castellano", "Dragomir", "Eskildsen", "Falkenrath", "Grünwald", "Halvorsen", "Iglesias", "Jankowski", "Kristiansen", "Lindqvist", "Marchetti", "Nordahl", "Oyelaran", "Pellegrini", "Quistgaard", "Rautavaara", "Sandoval", "Terzić"];
const ROLES = ["dentist", "accountant", "landlord", "physiotherapist", "notary", "veterinarian", "optometrist", "bookkeeper"];
const COMPANIES = ["Halyard", "Brightwater", "Corvina", "Tessellate", "Marisol", "Oakhaven", "Quillon", "Verdigris", "Northwind", "Pimento"];
const ATTRS = [{ a: "retainer", v: () => `$${(20 + Math.floor(rnd() * 70)) * 100} a month` }, { a: "budget", v: () => `${40 + Math.floor(rnd() * 90)}k` }, { a: "renewal date", v: () => `2027-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}` }];
const CITIES = ["Ljubljana", "Valparaiso", "Trondheim", "Hobart", "Cartagena", "Gdansk", "Nagasaki", "Windhoek", "Asheville", "Bergamo"];
const FAVS = [{ c: "coffee roaster", v: ["Kalita", "Onyx", "Tim Wendelboe", "Sey", "Coffee Collective"] }, { c: "running route", v: ["the canal loop", "the ridge trail", "the harbour path", "the old rail line"] }, { c: "airline", v: ["Finnair", "Icelandair", "KLM", "Aer Lingus"] }];
const MEETINGS = ["design review", "budget sync", "hiring panel", "roadmap check-in"];
const DAYS = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays"];
const TIMES = ["08:30", "09:15", "10:00", "11:45", "14:00", "15:30", "16:15"];
const TEAMS = ["billing", "logistics", "onboarding", "research", "support"];

let rnd = lcg(1);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const two = <T>(xs: readonly T[]): [T, T] => { const a = pick(xs); let b = pick(xs); while (b === a) b = pick(xs); return [a, b]; };
const person = () => `${pick(FIRST)} ${pick(LAST)}`;
const twoPeople = (): [string, string] => { const a = person(); let b = person(); while (b.split(" ")[1] === a.split(" ")[1]) b = person(); return [a, b]; };

export function generateSupersedeSet(seed = 11): SupersedeSet {
  rnd = lcg(seed);
  const chains: Chain[] = [];
  const used = new Set<string>();
  const add = (template: Template, tier: Chain["tier"], mk: (v: string) => string, [ov, nv]: [string, string], current: string, past: string, key: string) => {
    if (used.has(key)) return;
    used.add(key);
    chains.push({ id: `c${String(chains.length + 1).padStart(2, "0")}`, template, tier, old: mk(ov), new: mk(nv), oldValue: ov, newValue: nv, current, past });
  };
  for (const role of ROLES) add("role", "profile", (v) => `The user's ${role} is ${v}.`, twoPeople(), `Who is my ${role}?`, `Who was my ${role} before?`, `role:${role}`);
  for (let i = 0; i < 6; i++) {
    const co = COMPANIES[i]!;
    const at = ATTRS[i % ATTRS.length]!;
    let ov = at.v(), nv = at.v();
    while (nv === ov) nv = at.v();
    add("company-attr", i % 2 ? "log" : "profile", (v) => `${co}'s ${at.a} is ${v}.`, [ov, nv], `What is ${co}'s ${at.a}?`, `What did ${co}'s ${at.a} use to be?`, `co:${co}:${at.a}`);
  }
  add("lives", "profile", (v) => `The user's home city is ${v}.`, two(CITIES), "What's my home city?", "What was my home city before?", "lives");
  add("works", "profile", (v) => `The user's employer is ${v}.`, two(COMPANIES.slice(6)), "Who is my employer these days?", "Who was my employer previously?", "works");
  for (const f of FAVS) add("favorite", "profile", (v) => `The user's favorite ${f.c} is ${v}.`, two(f.v), `What's my favorite ${f.c}?`, `What was my favorite ${f.c} before?`, `fav:${f.c}`);
  for (const m of MEETINGS) {
    const [d1, d2] = two(DAYS);
    const t = pick(TIMES);
    add("meeting", "log", (v) => `The ${m} happens on ${v}.`, [`${d1} at ${t}`, `${d2} at ${t}`], `When is the ${m}?`, `When did the ${m} use to happen?`, `meet:${m}`);
  }
  for (const team of TEAMS.slice(0, 3)) add("manages", "profile", (v) => `${v} manages the ${team} team.`, twoPeople(), `Who manages the ${team} team?`, `Who managed the ${team} team before?`, `mgr:${team}`);
  // Held out: shapes the code-only keyer (memory/fact-key.ts) was NOT written for. They measure its gap honestly:
  // only the extractor's own remove + new line can supersede these.
  for (const co of COMPANIES.slice(7, 9)) add("held-out", "profile", (v) => `${v} is the user's point of contact at ${co}.`, twoPeople(), `Who is my point of contact at ${co}?`, `Who was my point of contact at ${co} before?`, `poc:${co}`);
  add("held-out", "profile", (v) => `The user drives a ${v} to work.`, ["Volvo V60", "Subaru Outback"], "What does the user drive to work?", "What did the user drive to work before?", "drives");

  // Multi-valued traps: both facts stay true.
  const [s1, s2] = twoPeople();
  const [k1, k2] = twoPeople();
  const traps: Trap[] = [
    { id: "t1", facts: [`The user's sister is ${s1}.`, `The user's sister is ${s2}.`], values: [s1, s2], question: "Tell me about my sister." },
    { id: "t2", facts: [`The user's client is ${k1}.`, `The user's client is ${k2}.`], values: [k1, k2], question: "Remind me who my client is." },
  ];

  // Distractors: same vocabulary, different subjects (never a supersession of the user's own facts).
  const distractors: string[] = [];
  const dset = new Set<string>();
  while (distractors.length < 320) {
    const k = distractors.length % 8;
    const p = person();
    const s = k === 0 ? `${p}'s ${pick(ROLES)} practice moved across town in 2025.`
      : k === 1 ? `${p} recommended a ${pick(ROLES)} near ${pick(CITIES)}.`
      : k === 2 ? `The user sent ${p} the ${pick(COMPANIES)} proposal on 2026-0${1 + Math.floor(rnd() * 8)}-2${Math.floor(rnd() * 8)}.`
      : k === 3 ? `${p} flew to ${pick(CITIES)} for the ${pick(MEETINGS)}.`
      : k === 4 ? `The user read an article by ${p} about ${pick(CITIES)} architecture.`
      : k === 5 ? `${p} from ${pick(COMPANIES)} asked about invoicing terms.`
      : k === 6 ? `The user bought a gift for ${p} at a market in ${pick(CITIES)}.`
      : `${p} joined the ${pick(TEAMS)} channel last spring.`;
    if (!dset.has(s)) { dset.add(s); distractors.push(s); }
  }
  return { chains, traps, distractors };
}
