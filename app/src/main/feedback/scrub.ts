import { SECRET_PARAM } from "@synapse/host/teach/redact";
import { redactText } from "../crash/redact";

/**
 * Send feedback → Attach logs: every line that could leave the Mac goes through here first. On top of
 * the crash redactor (known secret values, secret-named parameters, long opaque tokens) it removes
 * the key shapes of every provider Synapse talks to, auth headers (plain, JSON-escaped and
 * URL-encoded), secret-named URL query parameters and URL credentials, email addresses, the user's
 * name in home-folder paths, and the Mac's user name itself. Idempotent: scrubbing scrubbed text
 * changes nothing.
 */
const HEADER_NAMES = "authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie";
const SHAPES: [RegExp, string][] = [
  // Anthropic, OpenAI and anything else in the sk-… family.
  [/\bsk-[A-Za-z0-9_-]{8,}/gi, "[redacted]"],
  // Google OAuth access tokens and Gemini keys.
  [/\bAQ\.[A-Za-z0-9_.-]{8,}/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]"],
  // GitHub classic and fine-grained tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/gi, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/gi, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/gi, "[redacted]"],
  // Auth headers, whatever the scheme and however the quotes around them are escaped.
  [new RegExp(`\\b(${HEADER_NAMES})(\\\\*["']?\\s*[:=]\\s*\\\\*["']?)(?!\\[redacted\\])[^\\s"',;}\\\\]+(?:\\s+(?!\\[redacted\\])[^\\s"',;}\\\\]+)?`, "gi"), "$1$2[redacted]"],
  [/\b(Bearer|Basic|Token)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]"],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

/** "/Users/jane/…" and "/home/jane/…" → "~/…". The shared folder is nobody's name, so it stays. */
function homePaths(text: string, home?: string): string {
  let out = text;
  if (home && home.length > 1) out = out.split(home).join("~");
  return out.replace(/\/(?:Users|home)\/(?!Shared\b)[^/\s"'`:;,)\]}\\]+/g, "~");
}

/** URL credentials (scheme://user:pass@) and secret-named query parameters (?token=, &sig=, …). */
function urls(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?!\[redacted\]@)[^\s/@"'<>]+@/gi, "$1[redacted]@")
    .replace(/([?&;])([^=&\s#"'<>?]+)=(?!\[redacted\])([^&\s#"'<>\\]*)/g, (m, sep: string, key: string) => (SECRET_PARAM.test(key) ? `${sep}${key}=[redacted]` : m));
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface ScrubOptions { home?: string; knownValues?: string[]; /** The Mac's account name: removed wherever it appears as a word. */ username?: string }

function core(text: string, o: ScrubOptions): string {
  let out = urls(homePaths(text, o.home));
  for (const [re, to] of SHAPES) out = out.replace(re, to);
  if (o.username && o.username.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escRe(o.username)}(?![A-Za-z0-9])`, "gi"), "[user]");
  return redactText(out, o.knownValues ?? []);
}

/** A percent-encoded run (a form body, a query) is also read decoded; if that reading holds anything to scrub, the scrubbed decoded text replaces it. */
function encodedRuns(text: string, o: ScrubOptions): string {
  return text.replace(/[^\s"'<>]*%[0-9A-Fa-f]{2}[^\s"'<>]*/g, (run) => {
    let decoded: string;
    try { decoded = decodeURIComponent(run); } catch { return run; }
    if (decoded === run) return run;
    const clean = core(decoded, o);
    return clean === decoded ? run : clean;
  });
}

export function scrubText(text: string, o: ScrubOptions = {}): string {
  return core(encodedRuns(text, o), o);
}

/** The last `max` lines, each scrubbed and cut to 500 characters, the whole kept under `maxBytes` (oldest lines go first). */
export function scrubLines(lines: string[], o: ScrubOptions & { max?: number; maxBytes?: number } = {}): string {
  const kept = lines.slice(-(o.max ?? 300)).map((l) => scrubText(l.length > 500 ? `${l.slice(0, 500)}…` : l, o));
  const cap = o.maxBytes ?? 60 * 1024;
  while (kept.length && Buffer.byteLength(kept.join("\n")) > cap) kept.shift();
  return kept.join("\n");
}
