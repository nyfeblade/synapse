export interface MailMessage { id: string; messageId: string; from: string; to: string[]; subject: string; date: number; text: string; unread: boolean; folder: string; labels: string[]; attachments: string[] }
type Op = "from" | "to" | "subject" | "has" | "is" | "label" | "in" | "newer_than" | "word";
export interface MailTerm { neg: boolean; op: Op; value: string }
export interface MailQuery { groups: MailTerm[][] }

const OPS = /^(from|to|subject|has|is|label|in|newer_than):(.*)$/i;
const UNIT: Record<string, number> = { h: 3_600_000, d: 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 };
const unquote = (s: string) => s.replace(/^"(.*)"$/, "$1").toLowerCase();

/** Gmail-style subset (ORIG-04 §04.5): from: to: subject: has:attachment is:unread|read label:/in: newer_than:Nh|d|m|y, words, OR, -negation. */
export function parseMailQuery(q: string): MailQuery {
  const tokens = q.match(/-?(?:\w+:)?"[^"]*"|\S+/g) ?? [];
  const groups: MailTerm[][] = [];
  let join = false;
  for (const raw of tokens) {
    if (raw === "OR") { join = groups.length > 0; continue; }
    const neg = raw.startsWith("-") && raw.length > 1;
    const body = neg ? raw.slice(1) : raw;
    const m = OPS.exec(body);
    const term: MailTerm = m ? { neg, op: m[1]!.toLowerCase() as Op, value: unquote(m[2]!) } : { neg, op: "word", value: unquote(body) };
    const bad = (term.op === "has" && term.value !== "attachment") || (term.op === "is" && term.value !== "unread" && term.value !== "read") || (term.op === "newer_than" && !/^\d+[hdmy]$/.test(term.value));
    if (bad) throw new Error(`Unsupported email query: ${raw}`);
    if (join) groups[groups.length - 1]!.push(term);
    else groups.push([term]);
    join = false;
  }
  return { groups };
}

function hit(t: MailTerm, m: MailMessage, now: number): boolean {
  const v = t.value;
  switch (t.op) {
    case "from": return m.from.toLowerCase().includes(v);
    case "to": return m.to.some((x) => x.toLowerCase().includes(v));
    case "subject": return m.subject.toLowerCase().includes(v);
    case "has": return m.attachments.length > 0;
    case "is": return v === "unread" ? m.unread : !m.unread;
    case "label":
    case "in": return m.folder.toLowerCase() === v || m.labels.some((l) => l.toLowerCase() === v);
    case "newer_than": return now - m.date <= Number(v.slice(0, -1)) * UNIT[v.slice(-1)]!;
    case "word": return m.subject.toLowerCase().includes(v) || m.text.slice(0, 8192).toLowerCase().includes(v);
  }
}

export function matchMail(q: MailQuery, m: MailMessage, nowMs: number): boolean {
  return q.groups.every((g) => g.some((t) => hit(t, m, nowMs) !== t.neg));
}
