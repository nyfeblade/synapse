/**
 * SAFETY v2 on the Mac: the owner's rules applied by the Mac's own gate (the coordinator's policy, the Browser and
 * MacApp controllers), with facts only the Mac can see: the real path, the live page's address and button text, the
 * app and the person a MacApp action reaches. The host gate enforces the same rules first; this holds even when the
 * host's view of a Mac action was coarse (a send that only the live page shows is a send).
 *
 * Pure (no node imports). Rate limits are counted by the host gate (it sees every Mac action first); here they never
 * trigger on their own.
 */
import { fullAutoAsk, localFullAutoAction, netRequest } from "./full-auto";
import { macAppConsequence, macAppLabelConsequence, type MacAppArgs, type MacAppConsequence } from "./macapp";
import { STRICT_SOURCES, decide, kindOfClassRule, type ActionFacts, type ActionKind, type RuleDecision, type SafetyRule } from "./safety-rules";
import { parseShell } from "./shell-parse";

/** What the Mac keeps of the owner's rules (from the host's getSafety, refreshed on the "safety" event). */
export interface MacRulesView { rules: SafetyRule[]; timeZone: string }

const lc = (s: string) => s.trim().toLowerCase();
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const hostOf = (u: string): string | null => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(u.trim());
  return m ? m[1]!.toLowerCase().replace(/^\[|\]$/g, "") : null;
};
function join(base: string, p: string, home: string): string {
  if (p === "~" || p.startsWith("~/")) return `${home.replace(/\/$/, "")}${p.slice(1)}`;
  if (p.startsWith("/")) return p;
  const out = base.split("/").filter(Boolean);
  for (const seg of p.split("/")) { if (!seg || seg === ".") continue; if (seg === "..") out.pop(); else out.push(seg); }
  return `/${out.join("/")}`;
}
const WRITERS = /^(rm|rmdir|unlink|shred|trash|srm|mv|cp|rsync|dd|tee|touch|truncate|chmod|chown|ln|mkdir|install|tar|unzip|sed|ditto)$/;
const DELETERS = /^(rm|rmdir|unlink|shred|trash|srm)$/;

const CONSEQUENCE_KIND: Record<Exclude<MacAppConsequence, null>, ActionKind> = { send: "send", destruction: "delete", money: "pay", security: "access" };

/** A Mac command or file request (run-command, write-file, edit-file, read-file …) as facts. */
export function macRequestFacts(botId: string, r: { op: string; command?: string; path?: string; cwd?: string }, o: { home: string; base: string }): ActionFacts {
  const kinds = new Set<ActionKind>(["mac"]);
  const paths = new Set<string>();
  const domains = new Set<string>();
  let unknown = false;
  const a = localFullAutoAction(r, o.base, o.home);
  if (a) {
    const v = fullAutoAsk(a, { home: o.home, workspaces: [] });
    const k = v.ask ? kindOfClassRule(v.rule) : null;
    if (k) kinds.add(k);
  }
  if (r.op === "write-file" || r.op === "edit-file" || r.op === "copy-from-box") { kinds.add("file-write"); if (r.path) paths.add(join(o.base, r.path, o.home)); }
  if (r.op === "read-file" || r.op === "list-directory" || r.op === "glob" || r.op === "grep" || r.op === "copy-to-box") { if (r.path) paths.add(join(o.base, r.path, o.home)); }
  if (r.op === "run-command" || r.op === "send-input") {
    kinds.add("command");
    const command = r.command ?? "";
    const cwd = r.cwd ? join(o.base, r.cwd, o.home) : o.base;
    for (const m of command.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi)) { const h = hostOf(m[0]); if (h) domains.add(h); }
    try {
      for (const c of parseShell(command, { cwd, home: o.home }).cmds) {
        if (DELETERS.test(c.program) || (c.program === "find" && c.argv.some((w) => w.text === "-delete"))) kinds.add("delete");
        if (/^(curl|wget|http|https|xh)$/.test(c.program)) for (const h of netRequest(c).hosts) { if (h) domains.add(h); }
        const writes = WRITERS.test(c.program);
        if (writes) kinds.add("file-write");
        for (const w of c.argv.slice(1)) {
          const x = w.text;
          if (w.dynamic) { if (writes) unknown = true; continue; }
          if (!x || x.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(x) || x.includes("=")) continue;
          if (x.startsWith("/") || x.startsWith("~") || writes || /[/.]/.test(x)) paths.add(join(c.cwd ?? cwd, x, o.home));
        }
      }
    } catch { unknown = true; }
    if (!paths.size) paths.add(cwd);
  }
  return {
    botId, kinds: [...kinds], app: "mac", paths: [...paths].slice(0, 50), domains: [...domains], summary: (r.command ?? r.path ?? r.op).slice(0, 160),
    ...(unknown ? { pathsUnknown: true } : {}),
  };
}

const SEND_WORDS = /\b(send|post|publish|reply|tweet|share|submit|comment|invite|message)\b/i;
const DELETE_WORDS = /\b(delete|remove|erase|discard|trash|cancel (?:my )?(?:account|subscription))\b/i;
const PAY_WORDS = /\b(pay|buy|purchase|order|checkout|subscribe|place order|donate)\b/i;

/** A Browser action on the Mac, judged against the live page: its address, the control's text, whether it submits. */
export function macBrowserFacts(botId: string, b: { action: string; url: string; label?: string | null; submit?: boolean; field?: "password" | "card" | null; consequential?: string | null }): ActionFacts {
  const kinds = new Set<ActionKind>(["mac", "browse"]);
  const v = fullAutoAsk({ kind: "browser", action: b.action, url: b.url, label: b.label ?? undefined, field: b.field ?? null, submit: b.submit }, { home: "", workspaces: [] });
  const k = v.ask ? kindOfClassRule(v.rule) : null;
  if (k) kinds.add(k);
  const label = `${b.label ?? ""} ${b.consequential ?? ""}`;
  const acts = b.consequential || b.submit || b.action === "click";
  if (acts && SEND_WORDS.test(label)) kinds.add("send");
  if (acts && DELETE_WORDS.test(label)) kinds.add("delete");
  if (acts && PAY_WORDS.test(label)) kinds.add("pay");
  if (b.consequential && kinds.size === 2) kinds.add("app-write"); // a consequential form that is none of the above
  const h = hostOf(b.url);
  return { botId, kinds: [...kinds], app: "browser", domains: h ? [h] : [], summary: `${b.action} ${b.label ?? ""} ${h ?? ""}`.trim().slice(0, 160) };
}

/** A MacApp action as facts: the app, the people it reaches, what it does (the consequence, or the pressed label's). */
export function macAppFacts(botId: string, a: MacAppArgs, o: { label?: string | null } = {}): ActionFacts {
  const kinds = new Set<ActionKind>(["mac"]);
  const why = macAppConsequence(a) ?? (o.label ? macAppLabelConsequence(o.label) : null);
  if (why) kinds.add(CONSEQUENCE_KIND[why]);
  const people = [...`${a.target ?? ""} ${a.people ?? ""}`.matchAll(EMAIL)].map((m) => lc(m[0]));
  const paths = typeof a.target === "string" && (a.target.startsWith("/") || a.target.startsWith("~")) ? [a.target] : [];
  const app = lc(a.app ?? (a.action.split(".")[0] ?? "mac"));
  return { botId, kinds: [...kinds], app: app === "apple mail" ? "mail" : app, people, paths, summary: `${a.action} ${a.app ?? ""}`.trim().slice(0, 160) };
}

/** The owner's rules for a Mac action, as the host gate applies them: Never beats Ask first beats Always allow. */
export function macRuleDecision(view: MacRulesView | null, f: ActionFacts, o: { now: number; home: string }): RuleDecision | null {
  if (!view?.rules.length) return null;
  return decide(view.rules, f, { now: o.now, timeZone: view.timeZone }, { sources: STRICT_SOURCES, strictPresets: true, home: o.home });
}
