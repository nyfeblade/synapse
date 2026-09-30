// Safety model v2 (docs/superpowers/specs/2026-09-30-safety-v2-design.md): rules, presets, compiler, preview, migration.
import { describe, expect, it } from "vitest";
import {
  amountOf, applyPreset, compileRule, conflictsOf, decide, defaultSafetyState, describeRule, exceptionFor, factsFromMacAction, inWindow, kindOfClassRule,
  migrateAskRules, normalizeSafety, presetCovers, presetDiff, presetOf, presetRules, previewRule, ruleMatches, scopeCovers, validateModelRule,
  type ActionFacts, type HistoryRecord, type RuleCtx, type SafetyRule,
} from "../src/safety-rules";

const T0 = Date.UTC(2026, 8, 30, 12, 0); // 12:00 UTC
const ctx = (o: Partial<RuleCtx> = {}): RuleCtx => ({ now: T0, timeZone: "UTC", ...o });
let n = 0;
const rule = (o: Partial<SafetyRule>): SafetyRule => ({ id: `r${++n}`, type: "ask", text: "t", kinds: ["send"], scope: {}, except: [], source: "owner", enabled: true, createdAt: 0, ...o });
const send = (o: Partial<ActionFacts> = {}): ActionFacts => ({ botId: "b1", kinds: ["send"], app: "gmail", people: ["bob@acme.com"], ...o });

describe("precedence", () => {
  it("Never beats Ask first beats Always allow, in any order", () => {
    const rules = [rule({ type: "allow" }), rule({ type: "never" }), rule({ type: "ask" })];
    expect(decide(rules, send(), ctx())?.type).toBe("never");
    expect(decide(rules.slice().reverse(), send(), ctx())?.type).toBe("never");
    expect(decide([rule({ type: "allow" }), rule({ type: "ask" })], send(), ctx())?.type).toBe("ask");
    expect(decide([rule({ type: "allow" })], send(), ctx())?.type).toBe("allow");
    expect(decide([rule({ type: "never", kinds: ["delete"] })], send(), ctx())).toBeNull();
  });
  it("a disabled rule and a review-only rule decide nothing", () => {
    expect(decide([rule({ type: "never", enabled: false }), rule({ type: "never", reviewOnly: true })], send(), ctx())).toBeNull();
  });
  it("sources limit which rules take part; strict and Never presets always do", () => {
    const p = rule({ source: "preset", type: "ask" });
    expect(decide([p], send(), ctx(), { sources: ["owner"] })).toBeNull();
    expect(decide([{ ...p, strict: true }], send(), ctx(), { sources: ["owner"], strictPresets: true })?.type).toBe("ask");
    expect(decide([{ ...p, type: "never" }], send(), ctx(), { sources: ["owner"], strictPresets: true })?.type).toBe("never");
  });
});

describe("scopes", () => {
  it("global, per Bot, per app, per account", () => {
    expect(scopeCovers({}, send())).toBe(true);
    expect(scopeCovers({ bots: ["b1"] }, send())).toBe(true);
    expect(scopeCovers({ bots: ["b2"] }, send())).toBe(false);
    expect(scopeCovers({ apps: ["Gmail"] }, send())).toBe(true);
    expect(scopeCovers({ apps: ["slack"] }, send())).toBe(false);
    expect(scopeCovers({ accounts: ["work@acme.com"] }, send({ account: "Work@acme.com" }))).toBe(true);
    expect(scopeCovers({ accounts: ["work@acme.com"] }, send({ account: "me@home.com" }))).toBe(false);
    expect(scopeCovers({ accounts: ["work@acme.com"] }, send({ account: null }))).toBe(false);
  });
  it("per folder, on whole segments, with ~", () => {
    const f = (p: string): ActionFacts => ({ botId: "b1", kinds: ["delete"], paths: [p] });
    expect(scopeCovers({ paths: ["/Users/a/Documents"] }, f("/Users/a/Documents/x.txt"))).toBe(true);
    expect(scopeCovers({ paths: ["/Users/a/Documents"] }, f("/Users/a/Documents"))).toBe(true);
    expect(scopeCovers({ paths: ["/Users/a/Documents"] }, f("/Users/a/DocumentsOld/x"))).toBe(false);
    expect(scopeCovers({ paths: ["~/Documents"] }, f("/Users/a/Documents/x"), "/Users/a")).toBe(true);
    // letting through needs every path inside; stopping needs one
    expect(scopeCovers({ paths: ["/w"] }, { botId: "b1", kinds: ["delete"], paths: ["/w/a", "/etc/x"] })).toBe(false);
    expect(scopeCovers({ paths: ["/w"] }, { botId: "b1", kinds: ["delete"], paths: ["/w/a", "/etc/x"] }, "", "any")).toBe(true);
  });
  it("per person and per domain: every recipient must be named, so a mixed send isn't covered", () => {
    expect(scopeCovers({ people: ["bob@acme.com"] }, send())).toBe(true);
    expect(scopeCovers({ people: ["bob@acme.com"] }, send({ people: ["bob@acme.com", "eve@evil.com"] }))).toBe(false);
    expect(scopeCovers({ domains: ["acme.com"] }, send({ people: ["bob@mail.acme.com"] }))).toBe(true);
    expect(scopeCovers({ domains: ["acme.com"] }, send({ people: ["bob@notacme.com"] }))).toBe(false);
    expect(scopeCovers({ domains: ["s3.amazonaws.com"] }, { botId: "b1", kinds: ["upload"], domains: ["bucket.s3.amazonaws.com"] })).toBe(true);
    expect(scopeCovers({ domains: ["s3.amazonaws.com"] }, { botId: "b1", kinds: ["upload"], domains: ["paste.ee"] })).toBe(false);
    expect(scopeCovers({ people: ["bob@acme.com"] }, { botId: "b1", kinds: ["send"] })).toBe(false); // nobody resolved: not let through
    expect(scopeCovers({ people: ["bob@acme.com"] }, { botId: "b1", kinds: ["send"] }, "", "any-closed")).toBe(true); // …but an Ask first still asks
    expect(scopeCovers({ people: ["bob@acme.com"] }, send({ people: ["bob@acme.com", "eve@evil.com"] }), "", "any")).toBe(true);
  });
  it("Ask and Never stop a mixed action; Always allow needs all of it", () => {
    const mixed = send({ people: ["bob@acme.com", "eve@evil.com"] });
    expect(ruleMatches(rule({ type: "never", scope: { people: ["eve@evil.com"] } }), mixed, ctx())).toBe(true);
    expect(ruleMatches(rule({ type: "allow", scope: { people: ["bob@acme.com"] } }), mixed, ctx())).toBe(false);
  });
  it("an exception stops a rule matching there only", () => {
    const r = rule({ except: [{ people: ["bob@acme.com"] }] });
    expect(ruleMatches(r, send(), ctx())).toBe(false);
    expect(ruleMatches(r, send({ people: ["eve@x.com"] }), ctx())).toBe(true);
  });
});

describe("limits", () => {
  it("money: over $X, and a payment with no readable amount fails closed", () => {
    const r = rule({ kinds: ["pay"], limits: { overAmount: 50 } });
    const pay = (amount: number | null): ActionFacts => ({ botId: "b1", kinds: ["pay"], amount });
    expect(ruleMatches(r, pay(49.99), ctx())).toBe(false);
    expect(ruleMatches(r, pay(50), ctx())).toBe(false);
    expect(ruleMatches(r, pay(50.01), ctx())).toBe(true);
    expect(ruleMatches(r, pay(null), ctx())).toBe(true);
  });
  it("reads amounts from fields and money text", () => {
    expect(amountOf({ amount: 120 })).toBe(120);
    expect(amountOf({ line_items: [{ price: "$1,250.50" }] })).toBe(1250.5);
    expect(amountOf({ amount_cents: 999 })).toBe(9.99);
    expect(amountOf({ note: "costs $75 total" })).toBe(75);
    expect(amountOf({ to: "x@y.com" })).toBeNull();
  });
  it("rate: at most N an hour, per Bot or across all Bots", () => {
    const r = rule({ type: "never", limits: { perHour: { max: 3, per: "bot" } } });
    expect(ruleMatches(r, send(), ctx({ count: () => 2 }))).toBe(false);
    expect(ruleMatches(r, send(), ctx({ count: () => 3 }))).toBe(true);
  });
  it("time: inside the window in the owner's zone, across midnight", () => {
    expect(inWindow(Date.UTC(2026, 8, 30, 23, 0), "UTC", "22:00", "07:00")).toBe(true);
    expect(inWindow(Date.UTC(2026, 8, 30, 6, 59), "UTC", "22:00", "07:00")).toBe(true);
    expect(inWindow(Date.UTC(2026, 8, 30, 7, 0), "UTC", "22:00", "07:00")).toBe(false);
    expect(inWindow(Date.UTC(2026, 8, 30, 12, 0), "UTC", "22:00", "07:00")).toBe(false);
    // 03:00 UTC is 23:00 in New York the evening before: inside
    expect(inWindow(Date.UTC(2026, 8, 30, 3, 0), "America/New_York", "22:00", "07:00")).toBe(true);
    expect(inWindow(Date.UTC(2026, 8, 30, 3, 0), "Asia/Tokyo", "22:00", "07:00")).toBe(false); // 12:00 in Tokyo
    const r = rule({ type: "never", limits: { between: { from: "22:00", to: "07:00" } } });
    expect(ruleMatches(r, send(), ctx({ now: Date.UTC(2026, 8, 30, 23, 30) }))).toBe(true);
    expect(ruleMatches(r, send(), ctx())).toBe(false);
  });
});

describe("compile or reject", () => {
  const bots = [{ id: "b1", name: "Scout" }];
  const ok = (t: string, c = {}) => { const r = compileRule(t, { bots, ...c }); if (!r.ok) throw new Error(`${t}: ${r.reason}`); return r.rule; };
  const no = (t: string) => { const r = compileRule(t, { bots }); expect(r.ok, t).toBe(false); return r.ok ? "" : r.reason; };

  it("reads types, kinds and scopes", () => {
    expect(ok("Ask before sending emails to bob@acme.com")).toMatchObject({ type: "ask", kinds: ["send"], scope: { people: ["bob@acme.com"] } });
    expect(ok("Always allow uploads to s3.amazonaws.com")).toMatchObject({ type: "allow", kinds: ["upload"], scope: { domains: ["s3.amazonaws.com"] } });
    expect(ok("Never delete anything in ~/Documents")).toMatchObject({ type: "never", kinds: ["delete"], scope: { paths: ["~/Documents"] } });
    expect(ok("Ask first before posting in Slack")).toMatchObject({ type: "ask", kinds: ["send"], scope: { apps: ["slack"] } });
    expect(ok("Don't ask before Scout sends to anyone at acme.com")).toMatchObject({ type: "allow", kinds: ["send"], scope: { bots: ["b1"], domains: ["acme.com"] } });
    expect(ok("Never allow force pushes")).toMatchObject({ type: "never", kinds: ["git"] });
    expect(ok("Ask before sends from work@acme.com")).toMatchObject({ scope: { accounts: ["work@acme.com"] } });
    expect(ok("Never touch ~/Taxes")).toMatchObject({ type: "never", kinds: ["any"], scope: { paths: ["~/Taxes"] } });
  });
  it("reads money, rate and time limits", () => {
    expect(ok("Ask me before anything over $50")).toMatchObject({ type: "ask", kinds: ["pay"], limits: { overAmount: 50 } });
    expect(ok("At most 5 sends per hour")).toMatchObject({ type: "never", kinds: ["send"], limits: { perHour: { max: 5, per: "bot" } } });
    expect(ok("No more than 20 emails an hour across all bots")).toMatchObject({ type: "never", limits: { perHour: { max: 20, per: "all" } } });
    expect(ok("No sends between 22:00 and 07:00")).toMatchObject({ type: "never", kinds: ["send"], limits: { between: { from: "22:00", to: "07:00" } } });
    expect(ok("Never send after 10pm")).toMatchObject({ limits: { between: { from: "22:00", to: "00:00" } } });
    expect(ok("Ask before posting at night")).toMatchObject({ type: "ask", limits: { between: { from: "22:00", to: "07:00" } } });
  });
  it("scopes a rule made in a Bot's settings to that Bot", () => {
    expect(ok("Ask before deletes", { botId: "b9" })).toMatchObject({ scope: { bots: ["b9"] } });
  });
  it("rejects what it can't read exactly, with a reason, never a guess", () => {
    expect(no("Ask before sending to my boss")).toContain("boss");
    expect(no("Be careful with the fancy stuff")).toMatch(/Always allow, Ask first or Never|couldn't/);
    expect(no("Always allow anything")).toContain("turn the rules off");
    expect(no("Ask before sends unless it's to bob@acme.com")).toMatch(/exception/i);
    expect(no("Never send between 25:00 and 07:00")).toMatch(/time/i);
    expect(no("")).toBeTruthy();
    expect(no("Allow and never block sends")).toMatch(/both/);
  });
  it("shows the compiled matcher in words", () => {
    const r = compileRule("Ask before sending emails to bob@acme.com", { bots });
    expect(r.ok && r.words).toEqual(["Ask first", "Sends", "to bob@acme.com"]);
  });
  it("checks the rule-compiler model's answer strictly", () => {
    expect(validateModelRule("x", { clean: true, type: "ask", kinds: ["send"], scope: { people: ["bob@acme.com"] }, unmatched: "" }).ok).toBe(true);
    expect(validateModelRule("x", { clean: false, type: "ask", kinds: ["send"] }).ok).toBe(false);
    expect(validateModelRule("x", { clean: true, type: "ask", kinds: ["send"], unmatched: "my boss" }).ok).toBe(false);
    expect(validateModelRule("x", { clean: true, type: "ask", kinds: ["teleport"] }).ok).toBe(false);
    expect(validateModelRule("x", { clean: true, type: "ask", kinds: ["send"], scope: { people: ["my boss"] } }).ok).toBe(false);
    expect(validateModelRule("x", { clean: true, type: "allow", kinds: ["any"] }).ok).toBe(false);
  });
});

describe("presets", () => {
  it("Balanced is the default and asks before today's categories", () => {
    const s = defaultSafetyState();
    expect(s.preset).toBe("balanced");
    expect(s.rules.map((r) => r.preset)).toEqual(["sends", "deletes", "payments", "uploads", "fetch-run", "git", "sudo", "global-install", "app-writes", "access"]);
    expect(s.rules.every((r) => r.type === "ask" && r.source === "preset" && !r.strict)).toBe(true);
  });
  it("Careful makes sends and app writes strict; Hands-off asks only for payments and deletes", () => {
    expect(presetRules("careful").filter((r) => r.strict).map((r) => r.preset)).toEqual(["sends", "app-writes"]);
    expect(presetRules("hands-off").map((r) => r.preset)).toEqual(["deletes", "payments"]);
  });
  it("picking a preset shows what changes and keeps the owner's rules", () => {
    const s = defaultSafetyState();
    expect(presetDiff(s.rules, "hands-off")).toEqual({ adds: [], removes: ["Sends", "Uploads to unknown sites", "Running code from the internet", "Destructive git", "sudo", "Global installs", "App writes", "Access and keys"], changes: [] });
    expect(presetDiff(s.rules, "careful").changes).toEqual(["Sends", "App writes"]);
    const mine = rule({ type: "never", kinds: ["delete"] });
    const next = applyPreset({ ...s, rules: [...s.rules, mine] }, "hands-off");
    expect(next.rules).toContainEqual(mine);
    expect(presetOf(next.rules)).toBe("hands-off");
  });
  it("editing a preset rule makes it Custom", () => {
    const s = defaultSafetyState();
    s.rules[0] = { ...s.rules[0]!, except: [{ people: ["bob@acme.com"] }] };
    expect(presetOf(s.rules)).toBe("custom");
  });
  it("a preset rule covers its kind until it's removed or excepted", () => {
    const s = defaultSafetyState();
    expect(presetCovers(s.rules, "upload", { botId: "b1", kinds: ["upload"], domains: ["paste.ee"] })?.preset).toBe("uploads");
    const loosened = s.rules.map((r) => (r.preset === "uploads" ? { ...r, except: [{ domains: ["s3.amazonaws.com"] }] } : r));
    expect(presetCovers(loosened, "upload", { botId: "b1", kinds: ["upload"], domains: ["b.s3.amazonaws.com"] })).toBeNull();
    expect(presetCovers(presetRules("hands-off"), "upload", { botId: "b1", kinds: ["upload"] })).toBeNull();
  });
  it("maps every Full-auto classifier rule id to a kind (or structure)", () => {
    expect(kindOfClassRule("send.email")).toBe("send");
    expect(kindOfClassRule("send.cloud-upload")).toBe("upload");
    expect(kindOfClassRule("send.unknown-tool")).toBe("app-write");
    expect(kindOfClassRule("destruction.force-push")).toBe("git");
    expect(kindOfClassRule("destruction.delete-record")).toBe("delete");
    expect(kindOfClassRule("money.purchase")).toBe("pay");
    expect(kindOfClassRule("security.pipe-to-shell")).toBe("fetch-run");
    expect(kindOfClassRule("security.sudo")).toBe("sudo");
    expect(kindOfClassRule("security.system-install")).toBe("global-install");
    expect(kindOfClassRule("security.read-credentials")).toBe("access");
    expect(kindOfClassRule("security.too-long")).toBeNull();
  });
});

describe("preview", () => {
  const hist = (xs: [Partial<ActionFacts>, HistoryRecord["outcome"]][]): HistoryRecord[] => xs.map(([f, outcome], i) => ({ at: T0 + i * 60_000, facts: { botId: "b1", kinds: ["send"], ...f }, outcome }));
  it("counts the last actions this rule would have changed", () => {
    const h = hist([[{ people: ["bob@acme.com"] }, "allow"], [{ people: ["eve@x.com"] }, "allow"], [{ kinds: ["delete"] }, "ask"], [{ people: ["bob@acme.com"] }, "ask"]]);
    const r = rule({ type: "never", scope: { people: ["bob@acme.com"] } });
    expect(previewRule([], r, h, { timeZone: "UTC" })).toMatchObject({ changed: 2, of: 4 });
    const allow = rule({ type: "allow", kinds: ["delete"] });
    expect(previewRule([], allow, h, { timeZone: "UTC" }).changed).toBe(1);
  });
  it("a stronger rule already there wins in the replay too", () => {
    const h = hist([[{}, "deny"]]);
    const never = rule({ type: "never" });
    expect(previewRule([never], rule({ type: "allow" }), h, { timeZone: "UTC" }).changed).toBe(0);
  });
  it("replays rate limits inside the history, and only the last 50", () => {
    const h = hist(Array.from({ length: 60 }, () => [{}, "allow"] as [Partial<ActionFacts>, "allow"]));
    const r = rule({ type: "never", limits: { perHour: { max: 5, per: "bot" } } });
    const p = previewRule([], r, h, { timeZone: "UTC" });
    expect(p.of).toBe(50);
    expect(p.changed).toBe(45);
  });
  it("turns a Mac action log entry into facts", () => {
    expect(factsFromMacAction({ botId: "b1", kind: "delete", op: "delete", targets: ["/Users/a/x"] })).toMatchObject({ kinds: ["mac", "delete"], paths: ["/Users/a/x"] });
    expect(factsFromMacAction({ botId: "b1", kind: "app", op: "app", targets: [], act: "mail.send" }).kinds).toContain("send");
  });
});

describe("migration, cards and storage", () => {
  it("existing ask-first rules migrate silently: exact readings enforced, broad ones stay with the reviewer", () => {
    const rules = migrateAskRules(["Ask before emailing bob@acme.com", "Ask before anything risky"], (t) => (t.includes("bob") ? { verbs: ["send"], targets: { recipients: ["bob@acme.com"] }, breadth: "narrow" } : { verbs: [], breadth: "broad" }));
    expect(rules[0]).toMatchObject({ type: "ask", kinds: ["send"], scope: { people: ["bob@acme.com"] }, source: "migrated" });
    expect(rules[0]!.reviewOnly).toBeUndefined();
    expect(rules[1]).toMatchObject({ reviewOnly: true, kinds: ["any"] });
  });
  it("Always allow this names the narrowest scope", () => {
    expect(exceptionFor(send())).toEqual({ people: ["bob@acme.com"] });
    expect(exceptionFor({ botId: "b", kinds: ["upload"], domains: ["X.s3.amazonaws.com"] })).toEqual({ domains: ["x.s3.amazonaws.com"] });
    expect(exceptionFor({ botId: "b", kinds: ["sudo"], app: "box" })).toBeNull();
  });
  it("an Always allow rule shows the Ask rules it would lose to", () => {
    const s = defaultSafetyState();
    expect(conflictsOf(s.rules, { type: "allow", kinds: ["send"], scope: { people: ["bob@acme.com"] } }).map((r) => r.preset)).toEqual(["sends"]);
  });
  it("a stored state is read back strictly", () => {
    const bad = { version: 2, rules: [{ id: "x", type: "maybe", kinds: ["send"] }, { id: "y", type: "never", kinds: ["send", "teleport"], scope: { people: [1, "a@b.co"] }, source: "evil" }], guidelines: [{ id: "g", text: " cite sources ", botId: null }], networks: { b1: { mode: "only", hosts: ["https://Example.com/x", "not a host"] } } };
    const s = normalizeSafety(bad)!;
    expect(s.rules).toHaveLength(1);
    expect(s.rules[0]).toMatchObject({ id: "y", kinds: ["send"], scope: { people: ["a@b.co"] }, source: "owner" });
    expect(s.guidelines[0]!.text).toBe("cite sources");
    expect(s.networks.b1).toEqual({ mode: "only", hosts: ["example.com"] });
    expect(normalizeSafety({ version: 1 })).toBeNull();
  });
  it("describes a rule in short parts", () => {
    expect(describeRule(rule({ type: "never", kinds: ["send"], scope: { bots: ["b1"] }, limits: { between: { from: "22:00", to: "07:00" } } }), () => "Scout")).toEqual(["Never", "Sends", "Scout", "22:00–07:00"]);
  });
});
