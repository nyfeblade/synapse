/**
 * SAFETY MODEL v2 (Option A, docs/superpowers/specs/2026-09-30-safety-v2-design.md): the owner's rules, compiled to
 * exact matchers and enforced in code. Pure (no node imports): the host's approval gate enforces them, the app renders
 * and previews them, and both read this one module.
 *
 *   Hard core  >  Never  >  Ask first  >  Always allow  >  everything else (structure, the mode, the reviewer)
 *
 * The hard core lives in the host (host/review/hard-core.ts); this module is the rules, presets, guidelines, the
 * plain-English compiler, the preview and the migration of the old ask-first rules.
 */

export type RuleType = "allow" | "ask" | "never";
export type ActionKind =
  | "send" | "delete" | "pay" | "upload" | "fetch-run" | "git" | "sudo" | "global-install" | "app-write" | "access"
  | "command" | "file-write" | "browse" | "mac" | "any";
export const ACTION_KINDS: readonly ActionKind[] = ["send", "delete", "pay", "upload", "fetch-run", "git", "sudo", "global-install", "app-write", "access", "command", "file-write", "browse", "mac", "any"];

export type PresetKey = "sends" | "deletes" | "payments" | "uploads" | "fetch-run" | "git" | "sudo" | "global-install" | "app-writes" | "access";
export type PresetName = "careful" | "balanced" | "hands-off";
export const PRESET_NAMES: readonly PresetName[] = ["careful", "balanced", "hands-off"];
export const DEFAULT_PRESET: PresetName = "balanced";

/** Every list is OR within itself; every non-empty list must hit (AND across lists). Empty = any. */
export interface RuleScope {
  bots?: string[];
  apps?: string[];
  accounts?: string[];
  paths?: string[];
  people?: string[];
  domains?: string[];
  /** Exceptions only: the kinds this exception lifts (absent = every kind the rule has). */
  kinds?: ActionKind[];
}
export interface RuleLimits {
  /** Money: triggers over this amount (and for a payment whose amount can't be read). */
  overAmount?: number;
  /** Rate: triggers once `max` matching actions already ran in the last hour, per Bot or across all Bots. */
  perHour?: { max: number; per: "bot" | "all" };
  /** Time: triggers inside this window, in the owner's time zone ("22:00"–"07:00" spans midnight). */
  between?: { from: string; to: string };
}
export type RuleSource = "owner" | "preset" | "card" | "migrated";
export interface SafetyRule {
  id: string;
  type: RuleType;
  /** The owner's words (or the preset's label). */
  text: string;
  kinds: ActionKind[];
  scope: RuleScope;
  limits?: RuleLimits;
  /** "Always allow this" and "Loosen": scopes this rule no longer covers. */
  except: RuleScope[];
  source: RuleSource;
  preset?: PresetKey;
  /** A preset rule that keeps no built-in exemption (trusted people, plans, Full auto's direct request, No limits). */
  strict?: boolean;
  enabled: boolean;
  /** A migrated ask-first rule whose reading isn't exact: the reviewer keeps reading it; code doesn't enforce it. */
  reviewOnly?: boolean;
  createdAt: number;
}
export interface Guideline { id: string; text: string; botId: string | null }
export interface BotNetwork { mode: "open" | "only" | "block"; hosts: string[] }
export interface SafetyState {
  version: 2;
  preset: PresetName | "custom";
  rules: SafetyRule[];
  guidelines: Guideline[];
  networks: Record<string, BotNetwork>;
}

export const SAFETY_LIMITS = { rules: 60, ruleChars: 300, guidelines: 20, guidelineChars: 500, networkHosts: 50, historyKept: 200, previewActions: 50 } as const;

/** What the gate knows about one action. */
export interface ActionFacts {
  botId: string;
  kinds: ActionKind[];
  /** The Full-auto classifier's rule id ("send.email"), when it named one. */
  classRule?: string | null;
  /** The app or place: gmail, calendar, drive, slack, a toolkit or MCP server, "mac", "box". */
  app?: string | null;
  account?: string | null;
  paths?: string[];
  /** A command that deletes or writes somewhere its words don't say ($VAR, `~` alone): an Ask first or Never rule
   *  scoped to a folder matches it (fail closed), and nothing scoped to a folder lets it through. */
  pathsUnknown?: boolean;
  /** The paths are only the command's working folder (it named none): never used to scope an exception. */
  pathsFromCwd?: boolean;
  people?: string[];
  domains?: string[];
  /** Money: the amount when one can be read; null when it can't. */
  amount?: number | null;
  /** A short description for the preview list. */
  summary?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------------------------------

export interface PresetDef { key: PresetKey; label: string; kinds: ActionKind[] }
/** Short labels, no subtitles. */
export const PRESET_RULES: readonly PresetDef[] = [
  { key: "sends", label: "Sends", kinds: ["send"] },
  { key: "deletes", label: "Deletes", kinds: ["delete"] },
  { key: "payments", label: "Payments", kinds: ["pay"] },
  { key: "uploads", label: "Uploads to unknown sites", kinds: ["upload"] },
  { key: "fetch-run", label: "Running code from the internet", kinds: ["fetch-run"] },
  { key: "git", label: "Destructive git", kinds: ["git"] },
  { key: "sudo", label: "sudo", kinds: ["sudo"] },
  { key: "global-install", label: "Global installs", kinds: ["global-install"] },
  { key: "app-writes", label: "App writes", kinds: ["app-write"] },
  { key: "access", label: "Access and keys", kinds: ["access"] },
];
export const PRESET_LABEL: Record<PresetName | "custom", string> = { careful: "Careful", balanced: "Balanced", "hands-off": "Hands-off", custom: "Custom" };

const PRESET_MEMBERS: Record<PresetName, { key: PresetKey; strict?: boolean }[]> = {
  careful: PRESET_RULES.map((p) => ({ key: p.key, ...(p.key === "sends" || p.key === "app-writes" ? { strict: true } : {}) })),
  balanced: PRESET_RULES.map((p) => ({ key: p.key })),
  "hands-off": [{ key: "deletes" }, { key: "payments" }],
};

export function presetRules(name: PresetName, at = 0): SafetyRule[] {
  return PRESET_MEMBERS[name].map(({ key, strict }) => {
    const d = PRESET_RULES.find((p) => p.key === key)!;
    return { id: `preset-${key}`, type: "ask", text: d.label, kinds: [...d.kinds], scope: {}, except: [], source: "preset", preset: key, ...(strict ? { strict: true } : {}), enabled: true, createdAt: at };
  });
}

export function defaultSafetyState(): SafetyState {
  return { version: 2, preset: DEFAULT_PRESET, rules: presetRules(DEFAULT_PRESET), guidelines: [], networks: {} };
}

/** What picking a preset changes: preset rules it adds, removes, or makes stricter or looser. Owner rules are kept. */
export function presetDiff(rules: readonly SafetyRule[], name: PresetName): { adds: string[]; removes: string[]; changes: string[] } {
  const now = new Map(rules.filter((r) => r.source === "preset" && r.enabled && r.preset).map((r) => [r.preset!, r]));
  const next = new Map(presetRules(name).map((r) => [r.preset!, r]));
  const label = (k: PresetKey) => PRESET_RULES.find((p) => p.key === k)!.label;
  const adds = [...next.keys()].filter((k) => !now.has(k)).map(label);
  const removes = [...now.keys()].filter((k) => !next.has(k)).map(label);
  const changes = [...next.keys()].filter((k) => now.has(k) && (Boolean(now.get(k)!.strict) !== Boolean(next.get(k)!.strict) || now.get(k)!.except.length > 0 || now.get(k)!.type !== "ask")).map(label);
  return { adds, removes, changes };
}

/** Replace the preset rules with a preset's; owner, card and migrated rules stay. */
export function applyPreset(state: SafetyState, name: PresetName, at = 0): SafetyState {
  return { ...state, preset: name, rules: [...presetRules(name, at), ...state.rules.filter((r) => r.source !== "preset")] };
}

/** Balanced, Careful or Hands-off when the preset rules are exactly one of them; otherwise Custom. */
export function presetOf(rules: readonly SafetyRule[]): PresetName | "custom" {
  const mine = rules.filter((r) => r.source === "preset" && r.enabled);
  for (const name of PRESET_NAMES) {
    const want = presetRules(name);
    if (want.length !== mine.length) continue;
    const same = want.every((w) => mine.some((m) => m.preset === w.preset && m.type === "ask" && Boolean(m.strict) === Boolean(w.strict) && m.except.length === 0 && isEmptyScope(m.scope) && !m.limits));
    if (same) return name;
  }
  return "custom";
}

// ---------------------------------------------------------------------------------------------------------------
// Kinds from the Full-auto classifier
// ---------------------------------------------------------------------------------------------------------------

/** The action kind (and so the preset rule) for one Full-auto classifier rule id. null = structure, never a rule. */
export function kindOfClassRule(rule: string | null | undefined): ActionKind | null {
  if (!rule) return null;
  if (rule === "security.too-long" || rule === "full-auto.quiet") return null;
  if (["destruction.force-push", "destruction.rewrite-history", "destruction.discard-work"].includes(rule)) return "git";
  if (rule.startsWith("destruction.")) return "delete";
  if (rule.startsWith("money.")) return "pay";
  if (["send.cloud-upload", "send.exfil", "send.network", "send.network-script", "send.webhook"].includes(rule)) return "upload";
  if (rule === "send.unknown-tool") return "app-write";
  if (rule.startsWith("send.")) return "send";
  if (rule === "security.fetch-and-run" || rule === "security.pipe-to-shell") return "fetch-run";
  if (rule === "security.sudo") return "sudo";
  if (rule === "security.system-install") return "global-install";
  if (rule.startsWith("security.")) return "access";
  return null;
}

export function presetKeyOfKind(k: ActionKind): PresetKey | null {
  const d = PRESET_RULES.find((p) => p.kinds.includes(k));
  return d ? d.key : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Matching and precedence
// ---------------------------------------------------------------------------------------------------------------

export interface RuleCtx {
  /** Epoch ms. */
  now: number;
  /** The owner's IANA time zone. */
  timeZone: string;
  /** How many actions this rule's kinds matched in the last hour, for this Bot (per "bot") or all Bots (per "all"). */
  count?(rule: SafetyRule, facts: ActionFacts): number;
}

const lc = (s: string) => s.trim().toLowerCase();
export function isEmptyScope(s: RuleScope): boolean {
  return !(s.bots?.length || s.apps?.length || s.accounts?.length || s.paths?.length || s.people?.length || s.domains?.length);
}
/** Whole-segment folder match: "/a/b" covers "/a/b" and "/a/b/c", never "/a/bc". "~/" is the same as the home. */
export function pathWithin(p: string, dir: string, home = ""): boolean {
  const norm = (x: string) => (home && (x === "~" || x.startsWith("~/")) ? home + x.slice(1) : x).replace(/\/+$/, "") || "/";
  const a = norm(p), d = norm(dir);
  return d === "/" ? a.startsWith("/") : a === d || a.startsWith(`${d}/`);
}
/** Whole-label domain match: "acme.com" covers "acme.com" and "mail.acme.com", never "notacme.com". "*.x" is the same. */
export function domainWithin(host: string, domain: string): boolean {
  const h = lc(host).replace(/\.$/, ""), d = lc(domain).replace(/^\*\./, "").replace(/^@/, "").replace(/\.$/, "");
  return !!d && (h === d || h.endsWith(`.${d}`));
}
export function emailDomain(addr: string): string | null {
  const m = /@([^@\s>]+)$/.exec(addr.trim());
  return m ? lc(m[1]!) : null;
}

/**
 * Does the scope cover these facts? `home` expands "~" in paths.
 *
 * `every` (Always allow rules and exceptions, which let something through): every path, person and site the action
 * reaches must be named, so a mixed send or a command touching one folder inside and one outside isn't covered.
 * `any` (Ask first and Never, which stop something): one named path, person or site is enough. An Ask first rule
 * scoped to people also covers a send whose recipients couldn't be read (fail closed).
 */
export function scopeCovers(s: RuleScope, f: ActionFacts, home = "", mode: "every" | "any" | "any-closed" = "every"): boolean {
  if (s.bots?.length && !s.bots.includes(f.botId)) return false;
  if (s.apps?.length && !(f.app && s.apps.some((a) => lc(a) === lc(f.app!)))) return false;
  if (s.accounts?.length && !(f.account && s.accounts.some((a) => lc(a) === lc(f.account!)))) return false;
  const all = mode === "every";
  const pick = <T,>(xs: T[], ok: (x: T) => boolean) => (all ? xs.every(ok) : xs.some(ok));
  if (s.paths?.length) {
    if (f.pathsUnknown) { if (all) return false; } // where it acts can't be read: stop it, never let it through
    else if (!(f.paths?.length && pick(f.paths, (p) => s.paths!.some((d) => pathWithin(p, d, home))))) return false;
  }
  // `people` are addresses; `domains` in the facts are sites (URL and command hosts), never an address's domain.
  if (s.people?.length || s.domains?.length) {
    const people = f.people ?? [];
    const hosts = f.domains ?? [];
    if (!people.length && !hosts.length) return mode === "any-closed" && f.kinds.includes("send");
    const personOk = (p: string) => (s.people ?? []).some((x) => lc(x) === lc(p)) || (s.domains ?? []).some((d) => { const dom = emailDomain(p); return !!dom && domainWithin(dom, d); });
    const hostOk = (h: string) => (s.domains ?? []).some((d) => domainWithin(h, d));
    if (all) {
      if (!people.every(personOk) || !hosts.every(hostOk)) return false;
    } else if (!people.some(personOk) && !hosts.some(hostOk)) return false;
  }
  return true;
}

/** "HH:MM" → minutes since midnight, or null. Also "10pm", "7am", "22", "noon", "midnight". */
export function parseClock(t: string): number | null {
  const s = lc(t).replace(/\s+/g, "");
  if (s === "midnight") return 0;
  if (s === "noon") return 12 * 60;
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  } else if (h > 24 || (h === 24 && min > 0)) return null;
  return (h % 24) * 60 + min;
}
export const clockText = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

/** Minutes since midnight in the owner's zone (UTC when the zone is unknown). */
export function localMinutes(now: number, timeZone: string): number {
  const read = (tz: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
    return (Number(p.hour) % 24) * 60 + Number(p.minute);
  };
  try { return read(timeZone); } catch { return read("UTC"); }
}
export function inWindow(now: number, timeZone: string, from: string, to: string): boolean {
  const a = parseClock(from), b = parseClock(to);
  if (a === null || b === null || a === b) return false;
  const t = localMinutes(now, timeZone);
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** Whether a rule's kinds cover the action's. */
export function kindsCover(rule: SafetyRule, f: ActionFacts): boolean {
  return rule.kinds.includes("any") || rule.kinds.some((k) => f.kinds.includes(k));
}

/** Does this one rule match? Limits must trigger too (a rule with limits matches only when they do). */
export function ruleMatches(rule: SafetyRule, f: ActionFacts, ctx: RuleCtx, home = ""): boolean {
  if (!rule.enabled || rule.reviewOnly) return false;
  if (!kindsCover(rule, f)) return false;
  if (!scopeCovers(rule.scope, f, home, rule.type === "allow" ? "every" : rule.type === "ask" ? "any-closed" : "any")) return false;
  if (rule.except.some((e) => exceptionCovers(e, f, home))) return false;
  const l = rule.limits;
  if (l?.overAmount !== undefined) {
    const paying = f.kinds.includes("pay");
    if (f.amount === undefined || f.amount === null) { if (!paying) return false; } // a payment with no readable amount: fail closed
    else if (!(f.amount > l.overAmount)) return false;
  }
  if (l?.between && !inWindow(ctx.now, ctx.timeZone, l.between.from, l.between.to)) return false;
  if (l?.perHour) {
    const n = ctx.count ? ctx.count(rule, f) : 0;
    if (n < l.perHour.max) return false;
  }
  return true;
}

export interface RuleDecision { type: RuleType; rule: SafetyRule }
const RANK: Record<RuleType, number> = { never: 3, ask: 2, allow: 1 };

/**
 * The rules' decision for an action: Never beats Ask first beats Always allow; null when no rule decides.
 * `sources` limits which rules take part (the gate enforces preset rules where the built-in checks run).
 */
export function decide(rules: readonly SafetyRule[], f: ActionFacts, ctx: RuleCtx, o: { sources?: RuleSource[]; strictPresets?: boolean; home?: string } = {}): RuleDecision | null {
  let best: RuleDecision | null = null;
  for (const r of rules) {
    if (o.sources && !o.sources.includes(r.source) && !(o.strictPresets && r.source === "preset" && (r.strict || r.type === "never"))) continue;
    if (!ruleMatches(r, f, ctx, o.home)) continue;
    if (!best || RANK[r.type] > RANK[best.type]) best = { type: r.type, rule: r };
  }
  return best;
}

/** The rules the gate enforces strictly, in every mode: the owner's, the ones made from cards, migrated ones, and strict preset rules. */
export const STRICT_SOURCES: RuleSource[] = ["owner", "card", "migrated"];

/** Whether an enabled preset rule for this kind still covers the action (not excepted). */
export function presetCovers(rules: readonly SafetyRule[], kind: ActionKind, f: ActionFacts, home = ""): SafetyRule | null {
  for (const r of rules) {
    if (r.source !== "preset" || !r.enabled || r.type === "allow" || !r.kinds.includes(kind)) continue;
    if (!scopeCovers(r.scope, f, home, "any")) continue;
    if (r.except.some((e) => exceptionCovers(e, f, home))) continue;
    return r;
  }
  return null;
}

/** An exception lifts the rule only where every path, person and site is named, and only for its kinds. */
export function exceptionCovers(e: RuleScope, f: ActionFacts, home = ""): boolean {
  if (isEmptyScope(e)) return false;
  if (e.kinds?.length && !e.kinds.some((k) => f.kinds.includes(k))) return false;
  return scopeCovers(e, f, home, "every");
}

/**
 * "Always allow this" on a rule's card: the narrowest scope that names this action, for the kinds given (the ones the
 * rule matched). null = nothing narrow to name: a command that named no path of its own (its working folder isn't a
 * scope), a whole app, or a place that can't be read.
 */
export function exceptionFor(f: ActionFacts, kinds?: readonly ActionKind[]): RuleScope | null {
  const k = kinds?.length ? { kinds: [...kinds] } : {};
  if (f.people?.length) return { people: [...new Set(f.people.map(lc))], ...k };
  if (f.domains?.length) return { domains: [...new Set(f.domains.map(lc))], ...k };
  if (f.paths?.length && !f.pathsFromCwd && !f.pathsUnknown) return { paths: [...new Set(f.paths)], ...k };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Amounts (the money limit)
// ---------------------------------------------------------------------------------------------------------------

const AMOUNT_KEY = /^(amount|amount_total|total|price|unit_amount|cost|value|sum|charge|payment_amount|amount_cents|total_cents)$/i;
/** The largest amount an action's arguments carry, in whole currency units; null when none can be read. */
export function amountOf(args: unknown): number | null {
  let best: number | null = null;
  const take = (n: number) => { if (Number.isFinite(n) && n >= 0) best = best === null ? n : Math.max(best, n); };
  const walk = (v: unknown, key: string | null, depth: number) => {
    if (depth > 6 || v === null || v === undefined) return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, key, depth + 1); return; }
    if (typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) walk(x, k, depth + 1); return; }
    if (key && AMOUNT_KEY.test(key)) {
      const cents = /cents$/i.test(key);
      if (typeof v === "number") take(cents ? v / 100 : v);
      else if (typeof v === "string") { const n = moneyIn(v); if (n !== null) take(cents ? n / 100 : n); }
    } else if (typeof v === "string" && /[$€£]\s?\d/.test(v)) {
      const n = moneyIn(v);
      if (n !== null) take(n);
    }
  };
  walk(args, null, 0);
  return best;
}
function moneyIn(s: string): number | null {
  const m = /(?:[$€£]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(s);
  if (!m) return null;
  return Number(m[1]!.replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Words: a rule as the owner sees it
// ---------------------------------------------------------------------------------------------------------------

export const TYPE_LABEL: Record<RuleType, string> = { allow: "Always allow", ask: "Ask first", never: "Never" };
export const KIND_LABEL: Record<ActionKind, string> = {
  send: "Sends", delete: "Deletes", pay: "Payments", upload: "Uploads", "fetch-run": "Running code from the internet", git: "Destructive git",
  sudo: "sudo", "global-install": "Global installs", "app-write": "App writes", access: "Access and keys", command: "Commands", "file-write": "File edits",
  browse: "Browsing", mac: "Mac actions", any: "Anything",
};

/** The compiled matcher, in short parts: ["Ask first", "Sends", "to bob@acme.com", "Scout", "over $50"]. */
export function describeRule(r: SafetyRule, botName: (id: string) => string = (id) => id): string[] {
  const parts = [TYPE_LABEL[r.type], r.kinds.map((k) => KIND_LABEL[k]).join(", ")];
  const s = r.scope;
  if (s.people?.length) parts.push(`to ${s.people.join(", ")}`);
  if (s.domains?.length) parts.push(`at ${s.domains.join(", ")}`);
  if (s.apps?.length) parts.push(`in ${s.apps.map(appLabel).join(", ")}`);
  if (s.accounts?.length) parts.push(`from ${s.accounts.join(", ")}`);
  if (s.paths?.length) parts.push(`in ${s.paths.join(", ")}`);
  if (s.bots?.length) parts.push(s.bots.map(botName).join(", "));
  const l = r.limits;
  if (l?.overAmount !== undefined) parts.push(`over $${l.overAmount}`);
  if (l?.perHour) parts.push(`after ${l.perHour.max} an hour${l.perHour.per === "all" ? ", all Bots" : ""}`);
  if (l?.between) parts.push(`${l.between.from}–${l.between.to}`);
  if (r.strict && r.source === "preset") parts.push("even when you asked");
  if (r.except.length) parts.push(`except ${r.except.map(scopeWords).join("; ")}`);
  return parts;
}
export function scopeWords(s: RuleScope): string {
  return [...(s.people ?? []), ...(s.domains ?? []), ...(s.apps ?? []).map(appLabel), ...(s.accounts ?? []), ...(s.paths ?? []), ...(s.bots ?? [])].join(", ") + (s.kinds?.length ? ` (${s.kinds.map((x) => KIND_LABEL[x].toLowerCase()).join(", ")})` : "");
}
export const APP_NAMES: Record<string, string> = {
  gmail: "Gmail", calendar: "Google Calendar", drive: "Google Drive", slack: "Slack", notion: "Notion", github: "GitHub", linear: "Linear",
  discord: "Discord", telegram: "Telegram", whatsapp: "WhatsApp", messages: "Messages", twitter: "X", jira: "Jira", trello: "Trello",
  asana: "Asana", dropbox: "Dropbox", s3: "Amazon S3", stripe: "Stripe", shopify: "Shopify", outlook: "Outlook", mac: "your Mac", box: "the Bots' computer",
  browser: "the browser", docs: "Google Docs", sheets: "Google Sheets",
};
export const appLabel = (a: string) => APP_NAMES[lc(a)] ?? a;

// ---------------------------------------------------------------------------------------------------------------
// The plain-English compiler (deterministic; every word must be read, or the rule is rejected)
// ---------------------------------------------------------------------------------------------------------------

export type CompileResult =
  | { ok: true; rule: Omit<SafetyRule, "id" | "createdAt" | "source" | "enabled" | "except"> & { except: RuleScope[] }; words: string[] }
  | { ok: false; reason: string };

export interface CompileCtx {
  /** Known Bots, so "for Scout" becomes a Bot scope. */
  bots?: { id: string; name: string }[];
  /** Compiled from a Bot's own settings: the rule is scoped to it. */
  botId?: string | null;
}

const KIND_WORDS: [RegExp, ActionKind][] = [
  [/^(fetch[- ]and[- ]run|running code from the internet|code from the internet|download(?:ing)? and run(?:ning)?|pipe(?:s|d)? to (?:a )?shell|piping to (?:a )?shell|curl \| (?:sh|bash))$/, "fetch-run"],
  [/^(destructive git|force[- ]push(?:es|ing)?|rewriting (?:git )?history|history rewrites?|git hooks?)$/, "git"],
  [/^(global(?:ly)? installs?|installing globally|install(?:ing)? globally|system installs?|global packages?)$/, "global-install"],
  [/^(app writes?|writes? (?:in|to) (?:my )?apps?|changes? (?:in|to) (?:my )?apps?|app changes?|connected app writes?)$/, "app-write"],
  [/^(file edits?|file writes?|writing files|editing files|changing files|file changes?|edits?|editing)$/, "file-write"],
  [/^(running commands|run commands|commands?|shell commands?|terminal commands?)$/, "command"],
  [/^(mac actions?|actions on (?:my|the) mac)$/, "mac"],
  [/^(sends?|sending|emails?|emailing|messages?|messaging|texts?|texting|posts?|posting|replies|reply|replying|invites?|inviting|publish(?:es|ing)?|tweets?|tweeting|dms?)$/, "send"],
  [/^(deletes?|deleting|deletions?|removes?|removing|erases?|erasing|wipes?|wiping|trash(?:ing)?)$/, "delete"],
  [/^(pay|pays|payments?|paying|purchases?|purchasing|buy|buys|buying|spend(?:s|ing)?|checkouts?|charges?|charging|money)$/, "pay"],
  [/^(uploads?|uploading)$/, "upload"],
  [/^(sudo|admin commands?)$/, "sudo"],
  [/^(access|access changes?|keys|passwords?|credentials?|permissions?|tokens?)$/, "access"],
  [/^(brows(?:e|es|ing)|web browsing)$/, "browse"],
  [/^(anything|everything|any actions?|all actions?|actions?|touch(?:es|ing)?|go (?:into|near))$/, "any"],
];
/** Known app names (lower case) → app id. */
const APP_WORDS: Record<string, string> = {
  gmail: "gmail", "google calendar": "calendar", calendar: "calendar", "google drive": "drive", drive: "drive", slack: "slack", notion: "notion",
  github: "github", linear: "linear", discord: "discord", telegram: "telegram", whatsapp: "whatsapp", imessage: "messages", "messages app": "messages",
  twitter: "twitter", jira: "jira", trello: "trello", asana: "asana", dropbox: "dropbox", s3: "s3", "amazon s3": "s3", stripe: "stripe", shopify: "shopify",
  outlook: "outlook", "my mac": "mac", "the mac": "mac", "your mac": "mac", mac: "mac", "the box": "box", "the bots' computer": "box", browser: "browser",
  "the browser": "browser", "google docs": "docs", "google sheets": "sheets",
};
const FILLER = new Set([
  "the", "a", "an", "any", "me", "my", "i", "it", "to", "for", "in", "on", "of", "from", "with", "before", "first", "when", "that", "which", "is", "are",
  "be", "by", "bots", "bot", "can", "please", "always", "automatically", "ask", "allow", "never", "do", "not", "don't", "dont", "and", "or", "per", "hour",
  "each", "at", "most", "more", "than", "over", "above", "between", "after", "until", "people", "person", "anyone", "someone", "via", "using", "through",
  "sites", "site", "websites", "website", "apps", "app", "account", "accounts", "folder", "folders", "files", "file", "under", "inside", "within", "any", "all",
  "let", "lets", "them", "they", "without", "asking", "no", "block", "stop", "check", "with", "you", "your", "this", "these", "those", "things", "stuff",
  "only", "just", "times", "time", "hours", "an", "one", "every", "other", "others", "domain", "domains", "address", "addresses", "limit", "cap", "up",
  "must", "should", "doing", "make", "making", "who", "whom", "where", "there", "outside", "own", "else", "across", "total", "together", "combined",
  "run", "running", "action", "actions", "will", "would", "also", "then", "never", "ever", "go", "goes", "ahead", "ok", "okay", "fine", "tell",
  "allowx", "less", "exceed", "exceeds", "exceeding", "cost", "costs", "costing", "worth", "am", "pm", "night", "nights", "overnight", "morning", "evening",
]);

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMAIN = /^@?(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;
const PATH = /^(~|\/)[^\s]*$/;

/**
 * Compile one plain-English rule. Every word must be read as a type, a kind, a scope, a limit or a filler word; any
 * other word rejects the rule with a reason (never guessed).
 */
export function compileRule(text: string, ctx: CompileCtx = {}): CompileResult {
  const raw = text.trim();
  if (!raw) return { ok: false, reason: "Write the rule first." };
  if (raw.length > SAFETY_LIMITS.ruleChars) return { ok: false, reason: `Keep a rule under ${SAFETY_LIMITS.ruleChars} characters.` };
  let s = ` ${raw.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[,;!?()"]/g, " ").replace(/\.(?=\s|$)/g, " ").replace(/\s+/g, " ")} `;

  // ---- type ----
  s = s.replace(/ (never|don'?t|do not) (allow|let|permit) /g, " never ");
  s = s.replace(/ (don'?t|do not|never) (ask|check with)( me)?( first| before)? /g, " allowx ").replace(/ without asking /g, " allowx ");
  const hasAllow = / (always allow|allow automatically|allow|let (it|them|bots?|the bot)|allowx) /.test(s);
  const hasAsk = / (ask|check with me|confirm with me|need my ok) /.test(s);
  const hasNever = / (never|don'?t|do not|block|no|not allowed|stop) /.test(s);
  const hasCap = / (at most|no more than|up to) /.test(s);
  if (/ unless | except /.test(s)) return { ok: false, reason: "Write exceptions as their own Always allow rule, or use Loosen on the rule." };
  let type: RuleType | null = null;
  if (hasAsk) type = "ask";
  else if (hasNever && hasAllow) return { ok: false, reason: "The rule says both allow and never. Pick one." };
  else if (hasNever || hasCap) type = "never";
  else if (hasAllow) type = "allow";
  if (!type) return { ok: false, reason: "Start with Always allow, Ask first or Never." };

  const scope: RuleScope = {};
  const limits: RuleLimits = {};
  // Folders keep their case (macOS paths are shown as written); they're read from the original words.
  for (const w of raw.split(/\s+/)) {
    const t = w.replace(/[,;!?()"]+$/g, "").replace(/\.$/, "");
    if (t.length > 1 && PATH.test(t)) {
      const l = (scope.paths ??= []);
      const v = t.replace(/\/+$/, "") || "/";
      if (!l.includes(v)) l.push(v);
      s = s.split(` ${t.toLowerCase()} `).join(" ");
    }
  }
  const add = (k: keyof RuleScope, v: string) => { const l: string[] = (scope[k] ??= []); if (!l.includes(v)) l.push(v); };
  const eat = (re: RegExp, f: (m: RegExpExecArray) => void) => {
    let m: RegExpExecArray | null;
    const g = new RegExp(re.source, "g");
    while ((m = g.exec(s))) { f(m); }
    s = s.replace(new RegExp(re.source, "g"), " ");
  };

  // ---- limits ----
  let bad: string | null = null;
  eat(/ (?:over|above|more than|greater than|exceeding|at least|anything over) \$ ?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))? /, (m) => {
    limits.overAmount = Number(m[1]!.replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0);
  });
  eat(/ \$ ?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))? or more /, (m) => { limits.overAmount = Number(m[1]!.replace(/,/g, "")) + (m[2] ? Number(`0.${m[2]}`) : 0) - 0.01; });
  if (/\$/.test(s)) bad = "Write a money limit as “over $50”.";
  eat(/ (?:at most|no more than|up to|more than|over|after) (\d{1,4}) ([a-z' -]+?) (?:per|an|a|each|every) hour(?: (across all bots|in total|total|for all bots|combined))? /, (m) => {
    const n = Number(m[1]);
    const phrase = m[2]!.trim();
    // "more than 5 sends an hour" (ask / never after the fifth) vs "at most 5" (the same: the sixth is stopped).
    limits.perHour = { max: n, per: m[3] ? "all" : "bot" };
    s += ` ${phrase} `; // the kind words stay for the kind pass
  });
  if (/ (?:per|an|each|every) hour /.test(s) && !limits.perHour) bad = bad ?? "Write a rate as “at most 5 sends an hour”.";
  eat(/ between (\d{1,2}(?::\d{2})? ?(?:am|pm)?|noon|midnight) and (\d{1,2}(?::\d{2})? ?(?:am|pm)?|noon|midnight) /, (m) => {
    const a = parseClock(m[1]!), b = parseClock(m[2]!);
    if (a === null || b === null || a === b) bad = "That time window can't be read. Write it as “between 22:00 and 07:00”.";
    else limits.between = { from: clockText(a), to: clockText(b) };
  });
  eat(/ (?:after|from) (\d{1,2}(?::\d{2})? ?(?:am|pm)?|noon|midnight) (?:until|till|to) (\d{1,2}(?::\d{2})? ?(?:am|pm)?|noon|midnight) /, (m) => {
    const a = parseClock(m[1]!), b = parseClock(m[2]!);
    if (a === null || b === null || a === b) bad = "That time window can't be read. Write it as “between 22:00 and 07:00”.";
    else limits.between = { from: clockText(a), to: clockText(b) };
  });
  eat(/ after (\d{1,2}(?::\d{2})? ?(?:am|pm)?) /, (m) => {
    const a = parseClock(m[1]!);
    if (a === null || a === 0) bad = "That time can't be read. Write it as “after 22:00”.";
    else limits.between = { from: clockText(a), to: "00:00" };
  });
  eat(/ before (\d{1,2}(?::\d{2})? ?(?:am|pm)?) /, (m) => {
    const b = parseClock(m[1]!);
    if (b === null || b === 0) bad = "That time can't be read. Write it as “before 07:00”.";
    else limits.between = { from: "00:00", to: clockText(b) };
  });
  eat(/ (at night|overnight) /, () => { limits.between = { from: "22:00", to: "07:00" }; });
  if (bad) return { ok: false, reason: bad };

  // ---- scopes ----
  eat(/ (?:from|using|on) (?:account |my )?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}) (?:account )?/, (m) => add("accounts", m[1]!));
  eat(/ (?:people |anyone |someone )?at (@?(?:[a-z0-9-]+\.)+[a-z]{2,}) /, (m) => add("domains", m[1]!.replace(/^@/, "")));
  for (const b of ctx.bots ?? []) {
    const name = b.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!name) continue;
    eat(new RegExp(` (?:for|by|from) ${name} `), () => add("bots", b.id));
    eat(new RegExp(` ${name} `), () => add("bots", b.id));
  }
  eat(/ (?:for )?this bot /, () => { if (ctx.botId) add("bots", ctx.botId); else bad = "“This Bot” only works in a Bot's own settings."; });
  if (bad) return { ok: false, reason: bad };
  // Multi-word app names first.
  for (const [w, id] of Object.entries(APP_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    eat(new RegExp(` ${esc} `), () => add("apps", id));
  }
  // Kind phrases (longest first, so "destructive git" isn't read as nothing).
  const kinds: ActionKind[] = [];
  const words = s.trim().split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    let hit: { n: number; k: ActionKind } | null = null;
    for (let n = Math.min(5, words.length - i); n >= 1 && !hit; n--) {
      const phrase = words.slice(i, i + n).join(" ");
      for (const [re, k] of KIND_WORDS) if (re.test(phrase)) { hit = { n, k }; break; }
    }
    if (hit) { if (!kinds.includes(hit.k)) kinds.push(hit.k); i += hit.n - 1; continue; }
    out.push(words[i]!);
  }
  const unknown: string[] = [];
  for (const w of out) {
    const t = w.replace(/^[,.;:!?"'()]+|[,.;:!?"'()]+$/g, "");
    if (!t) continue;
    if (EMAIL.test(t)) { add("people", t); continue; }
    if (PATH.test(t) && t.length > 1) { add("paths", t.replace(/\/+$/, "") || "/"); continue; }
    if (DOMAIN.test(t)) { add("domains", t.replace(/^@/, "").replace(/^\*\./, "")); continue; }
    if (/^\d+$/.test(t) && limits.perHour) continue;
    if (FILLER.has(t)) continue;
    unknown.push(t);
  }
  if (unknown.length) {
    const u = unknown.slice(0, 3).join(" ");
    return { ok: false, reason: `I couldn't turn “${u}” into an exact rule. Name the address, site, app or folder instead.` };
  }
  if (kinds.includes("any") && kinds.length > 1) kinds.splice(kinds.indexOf("any"), 1); // "delete anything in ~/x" is deletes
  if (limits.overAmount !== undefined && !kinds.includes("pay") && !kinds.includes("any")) kinds.push("pay");
  if (!kinds.length) {
    // "Never touch ~/Documents" / "Ask before anything in Slack": a scope with no kind means any action there.
    if (!isEmptyScope(scope)) kinds.push("any");
    else return { ok: false, reason: "Say what the rule is about: sends, deletes, payments, uploads, commands, file edits…" };
  }
  if (type === "allow" && kinds.includes("any") && isEmptyScope(scope)) return { ok: false, reason: "“Always allow anything” would turn the rules off. Name what, where or who." };
  if (ctx.botId && !scope.bots?.length) add("bots", ctx.botId);
  const rule = { type, text: raw, kinds, scope, ...(Object.keys(limits).length ? { limits } : {}), except: [] as RuleScope[] };
  return { ok: true, rule, words: describeRule({ ...rule, id: "", createdAt: 0, source: "owner", enabled: true }, (id) => ctx.bots?.find((b) => b.id === id)?.name ?? id) };
}

/**
 * The rule-compiler model's answer (host/review/rules.ts, the v2 schema) checked strictly: known values only, nothing
 * left unread. Anything else is rejected, never guessed.
 */
export function validateModelRule(text: string, out: unknown, ctx: CompileCtx = {}): CompileResult {
  const o = out as { type?: unknown; kinds?: unknown; scope?: unknown; limits?: unknown; unmatched?: unknown; clean?: unknown } | null;
  if (!o || typeof o !== "object") return { ok: false, reason: "That rule couldn't be read. Try simpler words." };
  if (o.clean !== true || (typeof o.unmatched === "string" && o.unmatched.trim()) || (Array.isArray(o.unmatched) && o.unmatched.length)) {
    const u = Array.isArray(o.unmatched) ? o.unmatched.join(" ") : String(o.unmatched ?? "");
    return { ok: false, reason: u.trim() ? `I couldn't turn “${u.trim().slice(0, 60)}” into an exact rule.` : "That rule couldn't be read exactly. Try simpler words." };
  }
  if (o.type !== "allow" && o.type !== "ask" && o.type !== "never") return { ok: false, reason: "Start with Always allow, Ask first or Never." };
  if (!Array.isArray(o.kinds) || !o.kinds.length || !o.kinds.every((k) => (ACTION_KINDS as readonly string[]).includes(k as string))) return { ok: false, reason: "Say what the rule is about: sends, deletes, payments…" };
  const sc = (o.scope ?? {}) as Record<string, unknown>;
  const scope: RuleScope = {};
  for (const k of ["bots", "apps", "accounts", "paths", "people", "domains"] as const) {
    const v = sc[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) return { ok: false, reason: "That rule's scope couldn't be read." };
    if (k === "people" && !v.every((x) => EMAIL.test(lc(x as string)))) return { ok: false, reason: "People must be email addresses." };
    if (k === "domains" && !v.every((x) => DOMAIN.test(lc(x as string)))) return { ok: false, reason: "Sites must be names like example.com." };
    if (k === "paths" && !v.every((x) => PATH.test(x as string))) return { ok: false, reason: "Folders must start with / or ~/." };
    if (k === "bots" && !v.every((x) => (ctx.bots ?? []).some((b) => b.id === x))) return { ok: false, reason: "That Bot isn't one of yours." };
    if (k === "apps" && !v.every((x) => Object.values(APP_WORDS).includes(lc(x as string)))) return { ok: false, reason: "That app isn't one Synapse knows by name." };
    if (v.length) scope[k] = (v as string[]).map((x) => (k === "paths" ? x : lc(x)));
  }
  const lim = (o.limits ?? {}) as Record<string, unknown>;
  const limits: RuleLimits = {};
  if (lim.overAmount !== undefined && lim.overAmount !== null) {
    if (typeof lim.overAmount !== "number" || !(lim.overAmount >= 0)) return { ok: false, reason: "The money limit couldn't be read." };
    limits.overAmount = lim.overAmount;
  }
  if (lim.perHour !== undefined && lim.perHour !== null) {
    const p = lim.perHour as { max?: unknown; per?: unknown };
    if (typeof p.max !== "number" || !Number.isInteger(p.max) || p.max < 0 || (p.per !== "bot" && p.per !== "all")) return { ok: false, reason: "The rate limit couldn't be read." };
    limits.perHour = { max: p.max, per: p.per };
  }
  if (lim.between !== undefined && lim.between !== null) {
    const b = lim.between as { from?: unknown; to?: unknown };
    const a = typeof b.from === "string" ? parseClock(b.from) : null, z = typeof b.to === "string" ? parseClock(b.to) : null;
    if (a === null || z === null || a === z) return { ok: false, reason: "The time window couldn't be read." };
    limits.between = { from: clockText(a), to: clockText(z) };
  }
  const kinds = o.kinds as ActionKind[];
  if (o.type === "allow" && kinds.includes("any") && isEmptyScope(scope)) return { ok: false, reason: "“Always allow anything” would turn the rules off. Name what, where or who." };
  if (ctx.botId && !scope.bots?.length) scope.bots = [ctx.botId];
  const rule = { type: o.type as RuleType, text: text.trim(), kinds, scope, ...(Object.keys(limits).length ? { limits } : {}), except: [] as RuleScope[] };
  return { ok: true, rule, words: describeRule({ ...rule, id: "", createdAt: 0, source: "owner", enabled: true }, (id) => ctx.bots?.find((b) => b.id === id)?.name ?? id) };
}

// ---------------------------------------------------------------------------------------------------------------
// Conflicts, preview and history
// ---------------------------------------------------------------------------------------------------------------

/** Ask and Never rules an Always allow rule would lose to (Ask first wins), for the add dialog. */
export function conflictsOf(rules: readonly SafetyRule[], r: Pick<SafetyRule, "type" | "kinds" | "scope">): SafetyRule[] {
  if (r.type !== "allow") return [];
  // Rules with a limit (money, rate, time) are left out: an exception to a limit is rarely what an Allow rule meant.
  return rules.filter((x) => x.enabled && !x.reviewOnly && x.type !== "allow" && !x.limits && (x.kinds.includes("any") || r.kinds.includes("any") || x.kinds.some((k) => r.kinds.includes(k)))
    && (isEmptyScope(x.scope) || JSON.stringify(x.scope) === JSON.stringify(r.scope)));
}

export type HistoryOutcome = "allow" | "ask" | "deny";
export interface HistoryRecord { at: number; facts: ActionFacts; outcome: HistoryOutcome }

/**
 * Preview: how many of the last 50 actions this rule would have decided differently. Each record's outcome under the
 * current rules is what happened; with the new rule, a rule decision replaces it (Never → deny, Ask → ask, Allow →
 * allow) unless a stronger existing rule already decided it. Rate limits replay inside the history itself.
 */
export function previewRule(rules: readonly SafetyRule[], candidate: SafetyRule, history: readonly HistoryRecord[], o: { timeZone: string; home?: string }): { changed: number; of: number; examples: { summary: string; from: HistoryOutcome; to: HistoryOutcome }[] } {
  const last = [...history].sort((a, b) => a.at - b.at).slice(-SAFETY_LIMITS.previewActions);
  const others = rules.filter((r) => r.id !== candidate.id);
  const examples: { summary: string; from: HistoryOutcome; to: HistoryOutcome }[] = [];
  let changed = 0;
  const outcomeOf = (d: RuleDecision | null, fallback: HistoryOutcome): HistoryOutcome => (!d ? fallback : d.type === "never" ? "deny" : d.type === "ask" ? "ask" : "allow");
  for (const [i, rec] of last.entries()) {
    const count = (rule: SafetyRule, f: ActionFacts) => last.slice(0, i).filter((p) => p.at > rec.at - 3_600_000 && p.outcome === "allow" && kindsCover(rule, p.facts) && (rule.limits?.perHour?.per === "all" || p.facts.botId === f.botId)).length;
    const ctx: RuleCtx = { now: rec.at, timeZone: o.timeZone, count };
    const before = decide(others, rec.facts, ctx, { home: o.home });
    const after = decide([...others, candidate], rec.facts, ctx, { home: o.home });
    if (after?.rule.id !== candidate.id) continue;
    const from = outcomeOf(before, rec.outcome);
    const to = outcomeOf(after, rec.outcome);
    if (from === to) continue;
    changed++;
    if (examples.length < 5) examples.push({ summary: rec.facts.summary ?? KIND_LABEL[rec.facts.kinds[0] ?? "any"], from, to });
  }
  return { changed, of: last.length, examples };
}

/** A Mac action log entry (shared/action-log.ts MacActionView) as facts, for the preview. */
export function factsFromMacAction(v: { botId: string; kind: string; op: string; targets: string[]; act?: string; command?: string }): ActionFacts {
  const kinds: ActionKind[] = ["mac"];
  if (v.kind === "delete") kinds.push("delete");
  if (v.kind === "write" || v.kind === "edit" || v.kind === "move") kinds.push("file-write");
  if (v.kind === "command") kinds.push("command");
  if (v.kind === "browser") kinds.push("browse");
  const act = (v.act ?? "").toLowerCase();
  if (/send|reply|post|invite/.test(act)) kinds.push("send");
  if (/delete|trash|remove/.test(act)) kinds.push("delete");
  if (/pay|buy|purchase|checkout/.test(act)) kinds.push("pay");
  const paths = v.kind === "command" || v.kind === "browser" || v.kind === "app" ? [] : v.targets.filter((t) => t.startsWith("/") || t.startsWith("~"));
  const domains = v.kind === "browser" ? v.targets.map((t) => { try { return new URL(t).hostname; } catch { return ""; } }).filter(Boolean) : [];
  return { botId: v.botId, kinds: [...new Set(kinds)], app: v.kind === "app" ? (act.split(".")[0] || "mac") : "mac", paths, domains, summary: [v.act ?? v.op, v.command ?? v.targets[0] ?? ""].filter(Boolean).join(" ").slice(0, 120) };
}

// ---------------------------------------------------------------------------------------------------------------
// Migration and normalisation
// ---------------------------------------------------------------------------------------------------------------

const VERB_KIND: Record<string, ActionKind> = {
  send: "send", post: "send", publish: "send", share: "send", delete: "delete", purchase: "pay", install: "global-install", run: "command",
  create: "file-write", update: "file-write",
};

/**
 * Existing ask-first rules become rules, silently. A reading with a known verb and at least one exact target is
 * enforced in code; anything broader stays with the reviewer (reviewOnly), exactly as it worked before.
 */
export function migrateAskRules(texts: readonly string[], reading: (text: string) => { verbs?: string[]; targets?: Partial<Record<"paths" | "hosts" | "domains" | "recipients" | "channels" | "repos", string[]>>; breadth?: string } | undefined, at = 0): SafetyRule[] {
  return texts.map((text, i) => {
    const c = reading(text);
    const kinds = [...new Set((c?.verbs ?? []).map((v) => VERB_KIND[v]).filter((k): k is ActionKind => !!k))];
    const t = c?.targets ?? {};
    const scope: RuleScope = {};
    if (t.recipients?.length) scope.people = t.recipients.filter((x) => EMAIL.test(lc(x))).map(lc);
    if (t.domains?.length || t.hosts?.length) scope.domains = [...(t.domains ?? []), ...(t.hosts ?? [])].filter((x) => DOMAIN.test(lc(x))).map(lc);
    if (t.paths?.length) scope.paths = t.paths.filter((x) => PATH.test(x));
    for (const k of Object.keys(scope) as (keyof RuleScope)[]) if (!scope[k]?.length) delete scope[k];
    const exact = !!c && kinds.length > 0 && !isEmptyScope(scope) && c.breadth !== "broad";
    return { id: `migrated-${i + 1}-${hashText(text)}`, type: "ask", text, kinds: kinds.length ? kinds : ["any"], scope, except: [], source: "migrated", enabled: true, ...(exact ? {} : { reviewOnly: true }), createdAt: at };
  });
}

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** A stored state read back strictly: unknown fields dropped, bad rules skipped, the preset recomputed. */
export function normalizeSafety(v: unknown): SafetyState | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<SafetyState>;
  if (o.version !== 2 || !Array.isArray(o.rules)) return null;
  const rules: SafetyRule[] = [];
  for (const r of o.rules.slice(0, SAFETY_LIMITS.rules)) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !["allow", "ask", "never"].includes(r.type) || !Array.isArray(r.kinds)) continue;
    const kinds = r.kinds.filter((k) => (ACTION_KINDS as readonly string[]).includes(k));
    if (!kinds.length) continue;
    rules.push({
      id: r.id, type: r.type, text: String(r.text ?? "").slice(0, SAFETY_LIMITS.ruleChars), kinds, scope: cleanScope(r.scope), ...(r.limits ? { limits: r.limits } : {}),
      except: Array.isArray(r.except) ? r.except.map(cleanScope).filter((e) => !isEmptyScope(e)) : [],
      source: (["owner", "preset", "card", "migrated"] as const).includes(r.source) ? r.source : "owner",
      ...(r.preset && PRESET_RULES.some((p) => p.key === r.preset) ? { preset: r.preset } : {}), ...(r.strict ? { strict: true } : {}),
      enabled: r.enabled !== false, ...(r.reviewOnly ? { reviewOnly: true } : {}), createdAt: Number(r.createdAt) || 0,
    });
  }
  const guidelines = Array.isArray(o.guidelines) ? o.guidelines.filter((g) => g && typeof g.text === "string" && g.text.trim()).slice(0, SAFETY_LIMITS.guidelines)
    .map((g) => ({ id: String(g.id), text: g.text.trim().slice(0, SAFETY_LIMITS.guidelineChars), botId: typeof g.botId === "string" ? g.botId : null })) : [];
  const networks: Record<string, BotNetwork> = {};
  for (const [id, n] of Object.entries(o.networks ?? {})) {
    const net = normalizeNetwork(n);
    if (net && net.mode !== "open") networks[id] = net;
  }
  return { version: 2, preset: presetOf(rules), rules, guidelines, networks };
}
function cleanScope(s: unknown): RuleScope {
  const o = (s ?? {}) as Record<string, unknown>;
  const out: RuleScope = {};
  for (const k of ["bots", "apps", "accounts", "paths", "people", "domains"] as const) {
    const v = o[k];
    if (Array.isArray(v)) { const l = v.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 50); if (l.length) out[k] = l; }
  }
  if (Array.isArray(o.kinds)) { const l = o.kinds.filter((x): x is ActionKind => (ACTION_KINDS as readonly string[]).includes(x as string)); if (l.length) out.kinds = l; }
  return out;
}

/** A host name or "*.domain" for the network list; null when it isn't one. */
export function normalizeHost(h: string): string | null {
  const t = lc(h).replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  return /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/.test(t) || /^\d{1,3}(\.\d{1,3}){3}$/.test(t) ? t : null;
}
export function normalizeNetwork(n: unknown): BotNetwork | null {
  const o = n as Partial<BotNetwork> | null;
  if (!o || !["open", "only", "block"].includes(o.mode as string)) return null;
  const hosts = [...new Set((Array.isArray(o.hosts) ? o.hosts : []).map((h) => (typeof h === "string" ? normalizeHost(h) : null)).filter((h): h is string => !!h))].slice(0, SAFETY_LIMITS.networkHosts);
  return { mode: o.mode as BotNetwork["mode"], hosts };
}
/** Is this host on the list? "*.x" and "x" both cover subdomains of x. */
export function hostListed(host: string, list: readonly string[]): boolean {
  return list.some((d) => domainWithin(host, d));
}

// ---------------------------------------------------------------------------------------------------------------
// The app's view and commands (Settings → Rules; the owner's app only: no Bot tool reaches them)
// ---------------------------------------------------------------------------------------------------------------

export interface SafetyRuleView extends SafetyRule { words: string[] }
export interface SafetyView {
  /** The owner's time zone, for time windows (the Mac's gate applies rules too). */
  timeZone?: string;
  preset: PresetName | "custom";
  rules: SafetyRuleView[];
  guidelines: Guideline[];
  networks: Record<string, BotNetwork>;
}
export interface MacActionFacts { botId: string; kind: string; op: string; targets: string[]; act?: string; command?: string; at?: number }
export type SafetyCompileView =
  | { ok: true; words: string[]; type: RuleType; preview: { changed: number; of: number; examples: { summary: string; from: HistoryOutcome; to: HistoryOutcome }[] }; conflicts: { id: string; text: string }[] }
  | { ok: false; reason: string };

type NoArgs = Record<string, never>;
declare module "./gateway" {
  interface GatewayCommands {
    getSafety: { args: NoArgs; result: SafetyView };
    /** Compile a plain-English rule: the exact matcher in words and the preview, or a reason it can't be read. Saves nothing. */
    compileSafetyRule: { args: { text: string; botId?: string | null; macActions?: MacActionFacts[] }; result: SafetyCompileView };
    /** `asExceptionTo`: an Always allow the owner wrote, saved as that Ask rule's exception instead. */
    addSafetyRule: { args: { text: string; botId?: string | null; asExceptionTo?: string | null }; result: SafetyView };
    updateSafetyRule: { args: { id: string; enabled?: boolean; type?: RuleType; strict?: boolean; removeExcept?: number }; result: SafetyView };
    deleteSafetyRule: { args: { id: string }; result: SafetyView };
    /** `preview`: only what picking it would change. */
    setSafetyPreset: { args: { preset: PresetName; preview?: boolean }; result: SafetyView & { diff: { adds: string[]; removes: string[]; changes: string[] } } };
    setGuidelines: { args: { guidelines: { id?: string; text: string; botId: string | null }[] }; result: SafetyView };
    setBotNetwork: { args: { botId: string; mode: BotNetwork["mode"]; hosts: string[] }; result: SafetyView };
  }
}
