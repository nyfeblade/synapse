import { SecretScanner } from "@synapse/host/secrets/scanner";
import { looksSecret, SECRET_PARAM } from "@synapse/host/teach/redact";

/**
 * Crash reports and exported logs go through the same redaction the host uses: SecretScanner
 * (every encoding of every known secret value → [secret:NAME]) and the Teach redactor's
 * credential heuristics (secret-named parameters, long opaque tokens), plus the token shapes
 * Synapse itself handles (Claude OAuth, GitHub, Slack, bearer/basic headers).
 */
const SHAPES: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "[redacted]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_VALUE = /("?)([A-Za-z0-9_.-]{1,40})\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\]]+)/g;

export function redactText(text: string, knownValues: string[] = []): string {
  let out = knownValues.length ? new SecretScanner(knownValues.map((value) => ({ name: "SECRET", value }))).redact(text) : text;
  for (const [re, to] of SHAPES) out = out.replace(re, to);
  out = out.replace(KEY_VALUE, (m, q: string, key: string, sep: string, value: string) => (SECRET_PARAM.test(key) && !/^\[(redacted|secret:)/.test(value.replace(/^["']/, "")) ? `${q}${key}${q}${sep}${value.startsWith('"') ? '"[redacted]"' : "[redacted]"}` : m));
  return out.split(/(\s+)/).map((w) => {
    const bare = w.replace(/^[("'[{<]+|[)"'\]}>.,;:]+$/g, "");
    return bare && !UUID.test(bare) && looksSecret(bare) && !bare.includes("[") ? w.replace(bare, "[redacted]") : w;
  }).join("");
}

/**
 * A host log line (JSON: ts, level, msg, …fields) reduced to time, level and message. Fields are
 * where a turn's text, a tool's input or a file name would be, so none of them leave the box's log.
 */
export function hostLogLine(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as { ts?: unknown; level?: unknown; msg?: unknown };
    if (typeof j?.msg !== "string") return null;
    return `${String(j.ts ?? "")} ${String(j.level ?? "")} ${j.msg}`.trim();
  } catch { return null; }
}
