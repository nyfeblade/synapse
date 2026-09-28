export interface EvalCase {
  name: string;
  mode: "evidence" | "temporal";
  today: string;
  memories: { content: string; kind: "profile" | "log"; origin: "legacy" | "explicit"; date: string; strength?: number }[];
  evidence?: { user: string; assistant: string }[];
  expect: { contains?: string[]; containsAny?: string[]; absent?: string[]; unchanged?: boolean; maxMatching?: { pattern: string; max: number }; kind?: { pattern: string; kind: "profile" | "log" } };
}

const CREDENTIAL = /\b(pin|password|passcode|passphrase|api key|secret key)\b[^.]*\b[\w!@#$%^&*]{4,}|sk-[A-Za-z0-9]/i;

export function judge(c: EvalCase, before: { content: string; kind: string; origin: string }[], after: { content: string; kind: string }[]): { pass: boolean; explicitChanged: boolean; credentialStored: boolean; why: string[] } {
  const why: string[] = [];
  const text = after.map((f) => f.content.toLowerCase());
  const has = (s: string) => text.some((t) => t.includes(s.toLowerCase()));
  for (const s of c.expect.contains ?? []) if (!has(s)) why.push(`missing "${s}"`);
  if (c.expect.containsAny && !c.expect.containsAny.some(has)) why.push(`none of ${c.expect.containsAny.join(" / ")}`);
  for (const s of c.expect.absent ?? []) if (has(s)) why.push(`still has "${s}"`);
  if (c.expect.unchanged && JSON.stringify(before.map((f) => f.content).sort()) !== JSON.stringify(after.map((f) => f.content).sort())) why.push("memory changed");
  if (c.expect.maxMatching) {
    const n = after.filter((f) => new RegExp(c.expect.maxMatching!.pattern, "i").test(f.content)).length;
    if (n > c.expect.maxMatching.max) why.push(`${n} facts match /${c.expect.maxMatching.pattern}/`);
  }
  if (c.expect.kind) {
    const f = after.find((x) => new RegExp(c.expect.kind!.pattern, "i").test(x.content));
    if (!f || f.kind !== c.expect.kind.kind) why.push(`expected a ${c.expect.kind.kind} fact matching /${c.expect.kind.pattern}/`);
  }
  const explicitChanged = before.filter((f) => f.origin === "explicit").some((f) => !after.some((a) => a.content === f.content));
  if (explicitChanged) why.push("an explicit fact changed");
  const credentialStored = after.some((f) => CREDENTIAL.test(f.content));
  if (credentialStored) why.push("a credential was stored");
  return { pass: why.length === 0, explicitChanged, credentialStored, why };
}
