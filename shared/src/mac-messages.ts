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

const OSASCRIPT = /(^|[\s;&|(`]|\$\()(\S*\/)?osascript(\s|$)/;
const MESSAGES_APP = /\bapp(?:lication)?\s+"Messages"|Application\(\s*["']Messages["']\s*\)/i;
const AS_SEND = /\bsend\b/i;
const JXA_SEND = /\.send\(/;

const unescape = (s: string) => s.replace(/\\(["'\\])/g, "$1");

/** The Messages send in a shell command, or null when the command sends nothing through Messages. */
export function messagesSend(command: string): MessagesSend | null {
  if (!OSASCRIPT.test(command) || !MESSAGES_APP.test(command)) return null;
  const jxa = JXA_SEND.test(command);
  if (!jxa && !AS_SEND.test(command.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) return null;
  const text = jxa
    ? /\.send\(\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/.exec(command)?.[2]
    : /\bsend\s+"((?:[^"\\]|\\.)*)"/i.exec(command)?.[1];
  const contact = /whose\s+name\s+(?:is|contains|=|starts with)\s+"((?:[^"\\]|\\.)*)"/i.exec(command)?.[1];
  const handle = /\b(?:participant|buddy)\s+"((?:[^"\\]|\\.)*)"/i.exec(command)?.[1]
    ?? /\b(?:handle|to)\s*:\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/.exec(command)?.[2];
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
