import { LIMITS } from "@synapse/shared";
import { TEXT } from "./texts";
import { ruleCoversAction } from "./rule-coverage";
import type { RiskTarget, Verdict } from "./types";

const FLOOR_WORDS: Record<string, string> = {
  F1: "external communication", F2: "publishing step", F3: "payment", F4: "irreversible change", F5: "sharing or permission change",
  F6: "legal commitment", F10: "system change on your Mac",
};
const NEVER = ["F7", "F8", "F9"];

export type ExactTool = "Shell" | "ExternalShell";
/** cwd: the directory the rule is limited to; null (a rule without one) means the workspace only (I2). */
export interface ExactRule { id: string; tool: ExactTool; command: string; cwd: string | null }

/** §01.7 check 8: characters that disqualify a command from an exact-command rule (comments, chaining, expansion, quotes). */
export const EXACT_REJECT = /[#;&|`$"\n\r“”„‟″]/;
const EXACT_FORM = /^Use the (Shell|ExternalShell) tool to run the exact command “([^“”„‟″\n\r]+)”(?: in “(\/[^“”„‟″\n\r]*)”)?\.$/;

/** §01.7 check 8: exact-command comparison ignores only leading and trailing spaces and tabs (bash's word separators). */
export const trimSpaces = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, "");

/** The one canonical text of an exact-command rule; a cwd other than the workspace is part of it (I2). */
export function exactRuleText(tool: ExactTool, command: string, cwd?: string | null): string {
  return `Use the ${tool} tool to run the exact command “${command}”${cwd ? ` in “${cwd}”` : ""}.`;
}

/** Items 3/11: a rule's cwd must be canonical (no `.`/`..` segment, no `//`, no trailing `/`), since it's compared to a realpath. */
const canonicalCwd = (c: string) => c === "/" || (!c.endsWith("/") && !c.includes("//") && !c.split("/").some((seg) => seg === "." || seg === ".."));

/** Parses a rule in the canonical exact-command form; anything else (extra sentences, a relative cwd) is null. */
export function parseExactRule(text: string): { tool: ExactTool; command: string; cwd: string | null } | null {
  const m = EXACT_FORM.exec(text.trim());
  if (!m || EXACT_REJECT.test(m[2] as string) || (m[3] !== undefined && (EXACT_REJECT.test(m[3]) || !canonicalCwd(m[3])))) return null;
  return { tool: m[1] as ExactTool, command: m[2] as string, cwd: m[3] ?? null };
}

/** I2: an exact rule matches only the identical cwd; a rule without one matches only the workspace. */
export function exactRuleMatches(r: ExactRule, t: { tool: ExactTool; command: string; cwd: string }, workspace: string): boolean {
  return r.tool === t.tool && r.command === trimSpaces(t.command) && (r.cwd ?? workspace) === t.cwd;
}

export function validRule(rule: string | null): boolean {
  if (!rule) return false;
  const r = rule.trim();
  return r.length <= 300 && r.startsWith("Use the ") && !/\b(any|anything|anyone|all|every|everything|everyone)\b|\*/i.test(r) && (r.match(/[.!?](\s|$)/g) ?? []).length <= 1;
}

/** ORIG-01 §01.7: deterministic checks that can only turn allow into block. */
export function postValidate(
  v: Verdict,
  o: {
    floorHits: string[];
    /** Free-form allow rule ids (exact-command rules are not in here). */
    allowIds: string[];
    redact(s: string): string;
    fallbackRule?: string | null;
    exactRules?: ExactRule[];
    target?: { tool: ExactTool; command: string; cwd?: string } | null;
    workspace?: string;
    /**
     * Check 3 (E14 fix): the free-form Allow rules' text and the action. With it, a cited rule counts only when
     * rule-coverage.ts proves it covers this action's target and service; an undecidable one does not count.
     */
    coverage?: { rules: { id: string; text: string }[]; surface: string; target: RiskTarget; signals?: string[] };
  },
): { verdict: Verdict; overrides: string[] } {
  const out: Verdict = { ...v };
  const overrides: string[] = [];
  const block = (n: number) => { out.decision = "block"; overrides.push(`override:${n}`); };
  if (o.floorHits.some((f) => NEVER.includes(f))) { block(1); out.proposed_allow_rule = null; }
  if (out.matched_ask_rule_ids.length) { if (out.decision === "allow") block(2); out.proposed_allow_rule = null; }
  const floor = out.floor_category ?? o.floorHits.find((f) => FLOOR_WORDS[f]) ?? null;
  // Check 8: an exact-command rule counts only by deterministic string equality, never because the model cited it.
  const ws = o.workspace ?? "/workspace";
  const exactHit = !!o.target && (o.exactRules ?? []).some((r) => exactRuleMatches(r, { ...o.target!, cwd: o.target!.cwd ?? ws }, ws));
  const cov = o.coverage;
  const covers = (id: string) => !cov || cov.rules.some((r) => r.id === id && ruleCoversAction(r.text, cov.surface, cov.target, cov.signals ?? [], { workspace: o.workspace }));
  if (floor && FLOOR_WORDS[floor] && out.decision === "allow" && !exactHit && !out.matched_allow_rule_ids.some((id) => o.allowIds.includes(id) && covers(id))) {
    block(3);
    out.reason = `This ${FLOOR_WORDS[floor]} needs your OK (built-in safety check).`;
  }
  if (out.injection_suspected) { if (out.decision === "allow") block(4); out.proposed_allow_rule = null; }
  if (out.decision === "allow" && out.risk_tier >= 3 && out.confidence < LIMITS.allowTier3MinConfidence) block(5);
  out.reason = o.redact(out.reason ?? "").slice(0, LIMITS.approvalReasonMax).trim() || TEXT.fallbackReason;
  // Exact-command rules come only from the host (check 8); a model proposal in that form is dropped.
  if (out.proposed_allow_rule && parseExactRule(out.proposed_allow_rule) && out.proposed_allow_rule.trim() !== o.fallbackRule) out.proposed_allow_rule = null;
  // Check 8: any final block without a valid proposal (an S7 override of an allow, or the model's own block, gate
  // H-1) gets the host's exact-command rule so Always allow can still add one (APR-12). Overrides 1/2/4, and their
  // conditions when the model already blocked (never-floor, matched ask rule, suspected injection), keep null.
  const noFallback = overrides.some((x) => ["override:1", "override:2", "override:4"].includes(x))
    || o.floorHits.some((f) => NEVER.includes(f)) || out.matched_ask_rule_ids.length > 0 || out.injection_suspected;
  if (out.decision === "block" && !validRule(out.proposed_allow_rule) && !noFallback) out.proposed_allow_rule = o.fallbackRule ?? null;
  out.proposed_allow_rule = out.decision === "block" && validRule(out.proposed_allow_rule) ? o.redact((out.proposed_allow_rule as string).trim()) : null;
  return { verdict: out, overrides };
}
