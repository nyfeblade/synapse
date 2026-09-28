import { LIMITSC } from "@synapse/shared";
import type { SecretVault } from "./vault";

const b64url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** ORIG-12 §12.4 encodings. Shifted base64 keeps only the characters that don't depend on the neighbours. */
export function secretEncodings(value: string): string[] {
  const out = new Set<string>([value]);
  const buf = Buffer.from(value, "utf8");
  for (let k = 0; k < 3; k++) {
    const full = Buffer.concat([Buffer.alloc(k, 0x41), buf]).toString("base64");
    const skip = Math.ceil((k * 4) / 3);
    const inner = full.slice(skip + (k ? 1 : 0), full.length - 4);
    for (const v of [k === 0 ? full.replace(/=+$/, "") : inner]) {
      if (v.length >= LIMITSC.secretMinChars) {
        out.add(v);
        out.add(b64url(v));
      }
    }
  }
  const hex = buf.toString("hex");
  out.add(hex);
  out.add(hex.toUpperCase());
  out.add(encodeURIComponent(value));
  out.add(JSON.stringify(value).slice(1, -1));
  return [...out].filter((s) => s.length >= LIMITSC.secretMinChars);
}

/** I5: a routine webhook key (bot_ + 32 base62, host/routines/webhook-keys.ts); only its hash is stored, so it is matched by shape. */
const WEBHOOK_KEY = /\bbot_[0-9A-Za-z]{32}\b/g;

interface Node { next: Map<string, number>; fail: number; out: { len: number; name: string }[] }

/** Aho-Corasick over every encoding of every value; matches become [secret:NAME] (longest, leftmost, non-overlapping). */
export class SecretScanner {
  private nodes: Node[] = [{ next: new Map(), fail: 0, out: [] }];

  constructor(secrets: { name: string; value: string }[]) {
    for (const s of secrets) {
      if (s.value.length < LIMITSC.secretMinChars) continue;
      for (const p of secretEncodings(s.value)) this.add(p, s.name);
    }
    this.build();
  }

  private add(p: string, name: string): void {
    let n = 0;
    for (const ch of p) {
      let nx = this.nodes[n]!.next.get(ch);
      if (nx === undefined) {
        nx = this.nodes.push({ next: new Map(), fail: 0, out: [] }) - 1;
        this.nodes[n]!.next.set(ch, nx);
      }
      n = nx;
    }
    this.nodes[n]!.out.push({ len: [...p].length, name });
  }

  private build(): void {
    const q: number[] = [];
    for (const nx of this.nodes[0]!.next.values()) q.push(nx);
    while (q.length) {
      const u = q.shift() as number;
      for (const [ch, v] of this.nodes[u]!.next) {
        let f = this.nodes[u]!.fail;
        while (f && !this.nodes[f]!.next.has(ch)) f = this.nodes[f]!.fail;
        const cand = this.nodes[f]!.next.get(ch);
        this.nodes[v]!.fail = cand !== undefined && cand !== v ? cand : 0;
        this.nodes[v]!.out.push(...this.nodes[this.nodes[v]!.fail]!.out);
        q.push(v);
      }
    }
  }

  private matches(text: string): { start: number; end: number; name: string }[] {
    const chars = [...text];
    const found: { start: number; end: number; name: string }[] = [];
    let n = 0;
    chars.forEach((ch, i) => {
      while (n && !this.nodes[n]!.next.has(ch)) n = this.nodes[n]!.fail;
      n = this.nodes[n]!.next.get(ch) ?? 0;
      for (const o of this.nodes[n]!.out) found.push({ start: i - o.len + 1, end: i + 1, name: o.name });
    });
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const pick: typeof found = [];
    for (const m of found) if (!pick.length || m.start >= pick[pick.length - 1]!.end) pick.push(m);
    return pick;
  }

  redact(text: string): string {
    return this.redactValues(text).replace(WEBHOOK_KEY, "[secret:WEBHOOK_KEY]");
  }

  private redactValues(text: string): string {
    if (this.nodes.length === 1 || !text) return text;
    const ms = this.matches(text);
    if (!ms.length) return text;
    const chars = [...text];
    let out = "";
    let at = 0;
    for (const m of ms) {
      out += chars.slice(at, m.start).join("") + `[secret:${m.name}]`;
      at = m.end;
    }
    return out + chars.slice(at).join("");
  }

  firstMatch(text: string): string | null {
    const hit = this.nodes.length === 1 ? null : this.matches(text)[0]?.name ?? null;
    return hit ?? (new RegExp(WEBHOOK_KEY.source).test(text) ? "WEBHOOK_KEY" : null);
  }
}

export class ScannerRegistry {
  private cache = new Map<string, SecretScanner>();
  private sources: ((botId: string) => { name: string; value: string }[])[] = [];
  constructor(private vault: Pick<SecretVault, "values" | "onChange">) {
    vault.onChange((botId) => this.cache.delete(botId));
  }
  /** I10: more secret values per Bot (connector secrets: Slack/GitHub tokens, signing secrets, IMAP passwords). */
  addSource(src: (botId: string) => { name: string; value: string }[]): void {
    this.sources.push(src);
    this.cache.clear();
  }
  invalidate(botId: string): void {
    this.cache.delete(botId);
  }
  private for(botId: string): SecretScanner {
    let s = this.cache.get(botId);
    if (!s) {
      s = new SecretScanner([...this.vault.values(botId), ...this.sources.flatMap((f) => f(botId))]);
      this.cache.set(botId, s);
    }
    return s;
  }
  redact(botId: string, text: string): string { return this.for(botId).redact(text); }
  check(botId: string, text: string): string | null { return this.for(botId).firstMatch(text); }
}
