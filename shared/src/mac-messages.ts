/**
 * Bug 142 (voice fast path): sending an iMessage / SMS through the Messages app with AppleScript (or JXA) run by
 * osascript. That always acts as the user, to another person, and can't be taken back, so it is ALWAYS
 * consequential: the fixed rules make it an always-ask (a card every time, which Full-auto and allow rules can't
 * lift), and the card names the recipient and the exact text, so a spoken approval ("send it") is informed.
 * Pure text code (no node imports): the host's classifier, the fixed rules and the Mac's own policy share it.
 */
export interface MessagesSend {
  /** A Contacts name ("Sam Lee"), a handle (+15551234567, sam@example.com), or a note that it couldn't be read. */
  recipient: string;
  /** The exact text sent, or a note that it couldn't be read. */
  text: string;
  service: "iMessage" | "SMS" | null;
}

export const UNREADABLE_TEXT = "(couldn't read the text)";
export const UNREADABLE_RECIPIENT = "(couldn't read the recipient)";

// Bug 433: `(\S*\/)?osascript` backtracked over every non-space run (quadratic on a long command). A `/` right before
// the name is the same test: the path word before it always reaches back to a space or the start.
const OSASCRIPT = /(?:^|[\s;&|(`/])osascript(?:\s|$)/;
const MESSAGES_APP = /\bapp(?:lication)?\s+"Messages"|Application\(\s*["']Messages["']\s*\)/i;
const AS_SEND = /\bsend\b/i;
const JXA_SEND = /\.send\(/;

const unescape = (s: string) => s.replace(/\\(["'\\])/g, "$1");

/**
 * The body of a string opened by quote `q` just before `from`, read as `(?:[^q\\]|\\.)*q` reads it: a backslash escapes
 * the next char, except a line break (`.` doesn't match one). Returns the body, or where the read failed: the index of
 * a backslash it couldn't take, or the text's length when the string is never closed.
 */
function quotedBody(text: string, from: number, q: string): { body: string } | { fail: number } {
  for (let k = from; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") {
      if (k + 1 >= text.length || /[\n\r\u2028\u2029]/.test(text[k + 1]!)) return { fail: k };
      k++;
    } else if (c === q) return { body: text.slice(from, k) };
  }
  return { fail: text.length };
}

/**
 * The first string (after a `prefix` match ending just past its opening quote: the quote in group 1, or `"`) that
 * reads whole: what `prefix((?:[^q\\]|\\.)*)q` found, in linear time (bug 433: that regex backtracked quadratically on
 * repeated escapes). When a string opened by q fails at index f, every later q before f was read as an escaped char,
 * so a string it opens lines up with the failed read and fails at f too: only openings past f are tried.
 */
function firstQuoted(text: string, prefix: RegExp): string | undefined {
  const dead: Record<string, number> = {};
  for (const m of text.matchAll(prefix)) {
    const q = m[1] ?? "\"";
    const at = m.index + m[0].length;
    if (at <= (dead[q] ?? -1)) continue;
    const r = quotedBody(text, at, q);
    if ("body" in r) return r.body;
    dead[q] = r.fail;
  }
  return undefined;
}

/** Every "…" string that reads whole replaced by "" (what `.replace(/"(?:[^"\\]|\\.)*"/g, '""')` did, in linear time). */
export function blankDoubleQuoted(text: string): string {
  let out = "";
  let k = 0;
  for (;;) {
    const i = text.indexOf("\"", k);
    if (i < 0) return out + text.slice(k);
    const r = quotedBody(text, i + 1, "\"");
    if ("body" in r) { out += `${text.slice(k, i)}""`; k = i + r.body.length + 2; continue; }
    // Failed at r.fail: no "…" opened before it reads whole either (see firstQuoted), so it is copied as is.
    out += text.slice(k, r.fail);
    k = r.fail;
    if (k >= text.length) return out;
  }
}

/** The Messages send in a shell command, or null when the command sends nothing through Messages. */
export function messagesSend(command: string): MessagesSend | null {
  if (!OSASCRIPT.test(command) || !MESSAGES_APP.test(command)) return null;
  const jxa = JXA_SEND.test(command);
  if (!jxa && !AS_SEND.test(blankDoubleQuoted(command))) return null;
  const text = jxa ? firstQuoted(command, /\.send\(\s*(["'])/g) : firstQuoted(command, /\bsend\s+"/gi);
  const contact = firstQuoted(command, /whose\s+name\s+(?:is|contains|=|starts with)\s+"/gi);
  const handle = firstQuoted(command, /\b(?:participant|buddy)\s+"/gi)
    ?? firstQuoted(command, /\b(?:handle|to)\s*:\s*(["'])/g);
  const service = /service\s+type\s*=\s*(iMessage|SMS)\b/i.exec(command)?.[1];
  return {
    recipient: contact !== undefined ? unescape(contact) : handle !== undefined ? unescape(handle) : UNREADABLE_RECIPIENT,
    text: text !== undefined ? unescape(text) : UNREADABLE_TEXT,
    service: service ? (service.toLowerCase() === "sms" ? "SMS" : "iMessage") : null,
  };
}

/** The card line: who gets what. */
export function messagesSendSummary(m: MessagesSend): string {
  return `Send a message to ${m.recipient}: “${m.text.slice(0, 300)}”`;
}
