import { SecretScanner } from "@synapse/host/secrets/scanner";
import { redactText } from "../crash/redact";

/** Telegram's limits: 4,096 characters a message, 1,024 a photo caption. */
export const TG_MAX_TEXT = 4096;
export const TG_MAX_CAPTION = 1024;
/** A very long reply is cut after this many messages (the rest stays in Synapse). */
export const TG_MAX_PARTS = 10;

/**
 * Everything the bridge sends to Telegram goes through here: the app's redaction (known secret shapes, secret-named
 * parameters, long opaque tokens), with the bot token itself as a known value. Known values are found in the whole
 * text; the shape heuristics run per path segment, so an ordinary long path ("/Users/…/2025/report.pdf") isn't taken
 * for a token as a whole (a card showing it would otherwise be unreadable and offer only Deny).
 */
export function outgoing(text: string, known: (string | null | undefined)[] = []): string {
  const values = known.filter((k): k is string => typeof k === "string" && k.length >= 8);
  const scanned = values.length ? new SecretScanner(values.map((value) => ({ name: "SECRET", value }))).redact(text) : text;
  return scanned.split(/(\/)/).map((p) => (p === "/" ? p : redactText(p))).join("");
}

/**
 * Splits text into Telegram-sized parts, preferring a paragraph, then a line, then a word break; never inside a
 * surrogate pair. At most `maxParts` parts; when cut, the last part ends with `more`.
 */
export function splitText(text: string, max = TG_MAX_TEXT, maxParts = TG_MAX_PARTS, more = "…"): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    if (rest.length <= max) { parts.push(rest); break; }
    let cut = -1;
    for (const sep of ["\n\n", "\n", " "]) {
      const i = rest.lastIndexOf(sep, max);
      if (i >= max / 2) { cut = i; break; }
    }
    if (cut < 0) cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't split a surrogate pair
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (parts.length > maxParts) {
    const kept = parts.slice(0, maxParts);
    const tail = `\n${more}`;
    const last = kept[maxParts - 1]!;
    kept[maxParts - 1] = (last.length + tail.length > max ? last.slice(0, max - tail.length) : last) + tail;
    return kept;
  }
  return parts;
}

/** One line cut to `max` characters. */
export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
