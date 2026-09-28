import fs from "node:fs";
import path from "node:path";
import type { RiskTarget } from "./types";

/**
 * ORIG-01 §01.7 check 3 (E14 fix): a free-form Allow rule the model cites waives a safety floor only when the rule
 * provably covers THIS action. The check is deterministic and reads the rule's own words, never the model's.
 *
 * The rule must:
 * - name a service (Slack, email, Notion, GitHub, Shell, …) that the action is on;
 * - name at least one structured target: a #channel, an email address or domain, a URL host, an absolute path, or
 *   a repo (owner/name after "repo" or on github.com);
 * - contain no negation or exception word (never, not, no, except, don't, unless, without, but, excluding). Reading
 *   only a rule's positive clauses would need real parsing, so such a rule is undecidable (the safe choice).
 *
 * The action must name every target it touches in fields we can read, and each must fall inside the rule's values:
 * the same channel or repo, the same address or a host at or under the rule's domain, a path at or under the rule's
 * path. For a shell command, only a single simple command whose operands are all absolute paths, URLs or addresses
 * can be checked; the working directory is never the target.
 *
 * Anything that can't be decided this way is NOT covered, so the call goes to the user. That includes a rule or an
 * action carrying a URL with userinfo, `%` or a non-ASCII/IDN host, a malformed email address, an unknown field that
 * looks like an address, ID or list, and a shell command with `~`, `$`, backticks, `..`, globs, quotes, chaining,
 * relative operands, an option with an attached value, a trailing `/` (symlink), a static-analysis flag (opaque, cwd
 * outside the workspace, secret path), or a static writes:/deletes:/network target the rule does not cover.
 */

type Kind = "channels" | "addressees" | "paths" | "repos";
type Targets = Record<Kind, Set<string>>;
const empty = (): Targets => ({ channels: new Set(), addressees: new Set(), paths: new Set(), repos: new Set() });
class Undecidable extends Error {}
const undecidable = (why: string): never => { throw new Undecidable(why); };

const TLD = "(?:com|org|net|io|dev|co|ai|app|edu|gov|us|uk|de|fr|ca|au|me|so|xyz|info|biz|tech|cloud|site)";
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL_RE = /^[a-z0-9._+-]+@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/;
const NON_ASCII = /[^\x20-\x7e]/;
const NEGATION = /\b(never|not|no|except|excluding|unless|without|but|don'?t|do not|doesn'?t|isn'?t|aren'?t|won'?t|nor)\b|n't\b/i;

/** Rule services by keyword → the action services (lowercased MCP server names, or "shell") each covers. */
const SERVICES: Array<{ words: RegExp; services: string[] }> = [
  { words: /\bslack\b/i, services: ["slack"] },
  { words: /\b(g-?mail|e-?mails?|mail|inbox)\b/i, services: ["gmail", "email", "mail", "outlook"] },
  { words: /\bnotion\b/i, services: ["notion"] },
  { words: /\bgit\s?hub\b/i, services: ["github"] },
  { words: /\b(calendar|events?)\b/i, services: ["google_calendar", "calendar", "gcal"] },
  { words: /\b(google )?drive\b/i, services: ["google_drive", "drive"] },
  { words: /\blinear\b/i, services: ["linear"] },
  { words: /\bjira\b/i, services: ["jira", "atlassian"] },
  { words: /\bstripe\b/i, services: ["stripe"] },
  { words: /\b(shell|terminal)\b/i, services: ["shell"] },
];

/** Sentence punctuation that ends a rule ("… in /workspace/app/dist.") is not part of the target. */
const trimEnd = (s: string) => s.replace(/[.,;:!?)\]]+$/, "");

function normPath(raw: string): string {
  const p = trimEnd(raw);
  if (!p.startsWith("/") || p.split("/").some((seg) => seg === ".." || seg === ".") || NON_ASCII.test(p)) undecidable(`path ${p}`);
  return path.posix.normalize(p).replace(/(.)\/+$/, "$1");
}

/** A URL's host, only when it parses cleanly: no userinfo, no `%`, ASCII only, no IDN (xn--) label. */
function urlHost(raw: string): string {
  const s = trimEnd(raw);
  if (NON_ASCII.test(s) || s.includes("%") || s.includes("\\")) undecidable(`url ${s}`);
  let u: URL;
  try { u = new URL(s); } catch { return undecidable(`url ${s}`); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || /@/.test(s.split("/")[2] ?? "")) undecidable(`url ${s}`);
  const h = u.hostname.toLowerCase();
  if (!DOMAIN_RE.test(h) || h.split(".").some((l) => l.startsWith("xn--"))) undecidable(`host ${h}`);
  return h;
}

/**
 * Round 2: a URL as "host" + its path ("hooks.slack.com/services/T0/B0"), so a rule that names a path covers only
 * URLs under that path. `/` alone is dropped from a RULE URL (a bare host covers the whole host).
 */
function urlTarget(raw: string, isRule: boolean): string {
  const host = urlHost(raw);
  const u = new URL(trimEnd(raw));
  const p = u.pathname.replace(/\/+$/, "");
  if (p.split("/").some((seg) => seg === ".." || seg === ".")) undecidable(`url path ${raw}`);
  return isRule && !p ? host : `${host}${p || "/"}`;
}

/** A strict email: one `@`, no quotes, comments or non-ASCII; returns it lowercased. */
function email(raw: string): string {
  const s = trimEnd(raw.trim()).toLowerCase();
  if (NON_ASCII.test(s) || /["'()<>\\,;:\s%]/.test(s) || (s.match(/@/g) ?? []).length !== 1 || !EMAIL_RE.test(s)) undecidable(`email ${raw}`);
  return s;
}

function domain(raw: string): string {
  const s = trimEnd(raw.trim()).toLowerCase();
  if (NON_ASCII.test(s) || !DOMAIN_RE.test(s) || s.split(".").some((l) => l.startsWith("xn--"))) undecidable(`domain ${raw}`);
  return s;
}

function fromRuleText(text: string): Targets {
  if (NON_ASCII.test(text.replace(/[“”‘’…—–]/g, ""))) undecidable("non-ASCII rule");
  if (NEGATION.test(text)) undecidable("negated rule");
  const t = empty();
  let rest = text.replace(/\bhttps?:\/\/\S+/gi, (m) => { t.addressees.add(urlTarget(m, true)); return " "; });
  rest = rest.replace(/\S*@\S*/g, (m) => { t.addressees.add(email(m)); return " "; });
  rest = rest.replace(/\b(?:repo(?:sitory)?|github\.com\/)\s*([\w.-]+\/[\w.-]+)/gi, (_m, r: string) => { t.repos.add(trimEnd(r.toLowerCase())); return " "; });
  for (const m of rest.matchAll(new RegExp(`(?<![\\w@./-])((?:[a-z0-9-]+\\.)+${TLD})(?![\\w-])`, "gi"))) t.addressees.add(domain(m[1] as string));
  for (const m of rest.matchAll(/(?<![\w&])#([a-z0-9][\w-]*)/gi)) t.channels.add((m[1] as string).toLowerCase());
  for (const m of rest.matchAll(/(?<![\w:/.~-])(\/[\w.@/-]*)/g)) if ((m[1] as string).length > 1) t.paths.add(normPath(m[1] as string));
  if (/(?<![\w/])~/.test(rest)) undecidable("~ in rule");
  return t;
}

/** Argument keys whose values name WHERE an action goes. */
const ADDRESS_KEYS = /^(to|cc|bcc|recipient|recipients|email|emails|email_address|address|url|host|domain|site|webhook)$/i;
const CHANNEL_KEYS = /^(channel|channels|channel_id|channel_name)$/i;
const PATH_KEYS = /^(path|paths|file|file_path|filepath|dir|directory|dest|destination|target_path)$/i;
const REPO_KEYS = /^(repo|repository|repo_name|full_name)$/i;
/** Content fields: what is said or done, not where. Their text is never a target. */
const CONTENT_KEYS = /^(text|body|content|message|subject|title|description|summary|notes?|prompt|query|thread|page|name|tool|server|amount|currency|charge|draft|html|markdown|blocks|comment|caption|reason|working_directory|surface)$/i;
/** Keys that name people or audiences we don't parse: always undecidable. */
const AUDIENCE_KEYS = /(user|attendee|invite|member|participant|guest|assignee|reviewer|owner|share|people|contact|audience|group|team|account|org|workspace_id|to_|_to$|recipient|email)/i;
const LOOKS_TARGET = /@|:\/\/|^#|^[A-Za-z]?[A-Z0-9][A-Z0-9_-]{7,}$|^\d{6,}$/;

function addAddress(t: Targets, s: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s.trim())) t.addressees.add(urlTarget(s.trim(), false));
  else if (s.includes("@")) t.addressees.add(email(s));
  else t.addressees.add(domain(s));
}

function walk(t: Targets, v: unknown, key: string, shell: boolean): void {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return;
  if (Array.isArray(v)) {
    if (!(ADDRESS_KEYS.test(key) || CHANNEL_KEYS.test(key) || PATH_KEYS.test(key) || REPO_KEYS.test(key) || CONTENT_KEYS.test(key))) undecidable(`list under ${key}`);
    for (const x of v) walk(t, x, key, shell);
    return;
  }
  if (typeof v === "object") { for (const [k, x] of Object.entries(v)) walk(t, x, k, shell); return; }
  if (typeof v !== "string") undecidable(`value under ${key}`);
  const s = v as string;
  if (key === "command" && shell) return shellTargets(t, s);
  if (CHANNEL_KEYS.test(key)) {
    const c = s.trim().replace(/^#/, "").toLowerCase();
    if (!/^[a-z0-9][\w-]*$/.test(c)) undecidable(`channel ${s}`);
    t.channels.add(c);
  } else if (ADDRESS_KEYS.test(key)) addAddress(t, s);
  else if (PATH_KEYS.test(key)) t.paths.add(normPath(s));
  else if (REPO_KEYS.test(key)) {
    const r = s.trim().toLowerCase();
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) undecidable(`repo ${s}`);
    t.repos.add(r);
  } else if (CONTENT_KEYS.test(key) || key === "") return;
  else if (AUDIENCE_KEYS.test(key) || LOOKS_TARGET.test(s.trim())) undecidable(`unknown target-like field ${key}`);
}

/**
 * A shell command's targets, only for a single simple command whose every operand is an absolute path, a URL or an
 * email address. The working directory is never the target.
 */
function shellTargets(t: Targets, command: string): void {
  const c = command.trim();
  if (!c || NON_ASCII.test(c)) undecidable("command");
  if (/[~$`"'\\*?[\]{}!;&|<>()\n\r#%]/.test(c) || /(^|[\s/=])\.\.?(\/|\s|$)/.test(c)) undecidable("shell metacharacter, ~, $, glob, quote, chaining or ..");
  const words = c.split(/\s+/);
  const prog = words[0] as string;
  if (!/^[\w./-]+$/.test(prog) || prog.includes("=")) undecidable("program");
  let operands = 0;
  for (const w of words.slice(1)) {
    if (/^-/.test(w)) { checkOption(w); continue; }
    addOperand(t, w);
    operands++;
  }
  if (operands === 0) undecidable("no operand");
}

/**
 * Round 2: an option may carry a target INSIDE its token (`-C/`, `-t/etc`, `-o/x`, `-d@file`, `--dir=/`), where the
 * operand check never sees it. Only a bare long flag (`--recursive`), a single-letter flag (`-O`: its value, if any,
 * is the next token and is checked as an operand) or a short cluster of 2–5 letters from a
 * small set of common boolean flags passes; anything else is undecidable. A letters-only cluster can still hide an
 * attached value (`-tetc`), which is why the set leaves out value-taking letters (C, t, o, d, e, …).
 */
const SAFE_SHORT = /^-([A-Za-z]|[rRfvilnpaqsuxzjchFHLPS]{2,5})$/; // one letter: nothing is attached
function checkOption(w: string): void {
  if (w === "--") undecidable("-- ends options");
  if (w.startsWith("--")) { if (!/^--[a-z][a-z-]*$/.test(w)) undecidable(`long option with a value ${w}`); return; }
  if (!SAFE_SHORT.test(w)) undecidable(`short option ${w}`);
}

function addOperand(t: Targets, w: string): void {
  // Round 2: `link/` follows a symlink (rm -rf link/ deletes what it points to), so a trailing slash is undecidable.
  if (w.length > 1 && w.endsWith("/")) undecidable(`trailing slash ${w}`);
  if (w.startsWith("/")) t.paths.add(normPath(w));
  else if (/^https?:\/\//i.test(w)) t.addressees.add(urlTarget(w, false));
  else if (w.includes("@")) t.addressees.add(email(w));
  else undecidable(`relative or unknown operand ${w}`);
}

function actionService(surface: string, target: RiskTarget): string | null {
  if (surface === "box_shell" || surface === "host_shell" || target.action === "shell") return "shell";
  if (target.action === "mcp") {
    const server = target.arguments.server;
    return typeof server === "string" && server ? server.toLowerCase().replace(/^claude_ai_/, "") : null;
  }
  return null;
}

const addresseeCovered = (a: string, rule: Set<string>) => {
  const host = a.includes("@") ? a.slice(a.indexOf("@") + 1) : a.split("/")[0] as string;
  for (const r of rule) {
    if (r.includes("@")) { if (a === r) return true; continue; }
    // A rule URL with a path: the same host exactly, and a path at or under the rule's (segment boundary).
    if (r.includes("/")) { if (!a.includes("@") && (a === r || a.startsWith(`${r}/`))) return true; continue; }
    if (host === r || host.endsWith(`.${r}`)) return true;
  }
  return false;
};
const pathCovered = (p: string, rule: Set<string>) => [...rule].some((r) => p === r || p.startsWith(r === "/" ? "/" : `${r}/`));
const COVER: Record<Kind, (v: string, rule: Set<string>) => boolean> = {
  channels: (v, r) => r.has(v),
  repos: (v, r) => r.has(v),
  addressees: addresseeCovered,
  paths: pathCovered,
};

/** Static-analysis signals that make a shell command's real targets unknowable. */
const OPAQUE_SIGNALS = /^(opaque|cwd_outside_workspace|reads_secret_path|pipe_to_shell|privilege)$/;

/** True only when the rule text provably covers this action (see the module comment). */
/**
 * Round 3: a path as the filesystem will really see it. realpath of the deepest existing ancestor, with the parts that
 * don't exist yet re-appended, so a symlink ANYWHERE in the path (`/workspace/app/link/cron.d`, link → /etc) is
 * followed. A missing part that is itself a (dangling) symlink, or any error other than "doesn't exist" (EACCES,
 * ELOOP, ENOTDIR, …), is undecidable.
 */
function resolveReal(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(head);
      return tail.length ? path.posix.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") undecidable(`resolve ${head}: ${(e as NodeJS.ErrnoException).code}`);
      try { fs.lstatSync(head); undecidable(`dangling symlink ${head}`); } catch (e2) { if (e2 instanceof Undecidable) throw e2; }
      if (head === "/") undecidable(`resolve ${p}`);
      tail.push(path.posix.basename(head));
      head = path.posix.dirname(head);
    }
  }
}

export interface CoverageOptions {
  /**
   * The Bot's workspace as this host process sees it (cfg.workspace; the gate reads scripts there for enrichment).
   * Round 3: only paths that stay inside it after resolving are trusted. A Bot sandbox (bwrap) may mount things
   * differently elsewhere, and a host_shell path lives on the user's Mac, which this process can't see at all.
   */
  workspace?: string;
}

export function ruleCoversAction(ruleText: string, surface: string, target: RiskTarget, signals: string[] = [], opts: CoverageOptions = {}): boolean {
  try {
    const named = SERVICES.filter((s) => s.words.test(ruleText));
    const svc = actionService(surface, target);
    if (named.length === 0 || !svc || !named.some((s) => s.services.includes(svc))) return false;
    const shell = svc === "shell";
    if (shell && signals.some((s) => OPAQUE_SIGNALS.test(s))) return false;
    if (target.enrichment && shell) return false; // a script's behaviour lives in a file the rule text can't bind
    const rule = fromRuleText(ruleText);
    const act = empty();
    walk(act, target.arguments, "", shell);
    const kinds = Object.keys(rule) as Kind[];
    if (!kinds.some((k) => rule[k].size > 0)) return false;
    const actKinds = kinds.filter((k) => act[k].size > 0);
    if (actKinds.length === 0) return false;
    for (const k of actKinds) {
      if (rule[k].size === 0) return false;
      for (const v of act[k]) if (!COVER[k](v, rule[k])) return false;
    }
    // Round 3: a shell path must ALSO be covered after resolving symlinks, on both sides, inside the workspace.
    let fsCovered = (_p: string) => true;
    if (shell) {
      const anyPath = rule.paths.size > 0 || act.paths.size > 0 || signals.some((s) => /^(writes|deletes):/.test(s));
      if (surface === "host_shell" && anyPath) return false; // the user's Mac: this process can't resolve its paths
      const ws = resolveReal(normPath(opts.workspace ?? "/workspace"));
      const inWs = (p: string) => p === ws || p.startsWith(`${ws}/`);
      const ruleReal = new Set([...rule.paths].map(resolveReal).filter(inWs));
      fsCovered = (p: string) => { const r = resolveReal(p); return inWs(r) && pathCovered(r, ruleReal); };
      for (const p of act.paths) if (!fsCovered(p)) return false;
    }
    // Round 2: every target the static pass found must be covered too, whatever the operand parse saw.
    for (const s of signals) {
      const i = s.indexOf(":");
      if (i < 0) continue; // flags without a target (package_install, …); the opaque ones returned above
      const kind = s.slice(0, i);
      const value = s.slice(i + 1);
      if (kind === "writes" || kind === "deletes") {
        if (value.length > 1 && value.endsWith("/")) return false; // a symlink's target, see addOperand
        const p = normPath(value);
        if (!pathCovered(p, rule.paths) || !fsCovered(p)) return false;
      } else if (kind === "network_egress" || kind === "courier") {
        if (!addresseeCovered(domain(value), rule.addressees)) return false;
      } else return false; // a target kind this check doesn't know
    }
    return true;
  } catch (e) {
    if (e instanceof Undecidable) return false;
    return false; // any other failure is also "not covered"
  }
}
