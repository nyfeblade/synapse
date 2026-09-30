// @vitest-environment jsdom
// Safety v2 on the Mac: the owner's rules and the hard core, applied by the Mac's own gate (the coordinator's policy)
// and by the Browser and MacApp controllers, with the Mac's own facts: the real path, the live page, the app and person.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STR_RULES, compileRule, type MacRulesView, type SafetyRule } from "@synapse/shared";
import { macBench, macOutcome, type MacBench } from "../../../host/security/macgate";
import { MacAppController } from "../../src/main/macapp/controller";
import type { MacHelper } from "../../src/main/macapp/helper";

let n = 0;
const rules = (...texts: string[]): MacRulesView => ({
  timeZone: "UTC",
  rules: texts.map((t) => {
    const r = compileRule(t);
    if (!r.ok) throw new Error(`${t}: ${r.reason}`);
    return { ...r.rule, id: `r${++n}`, source: "owner", enabled: true, createdAt: 0 } as SafetyRule;
  }),
});
const open: MacBench[] = [];
afterEach(() => { while (open.length) open.pop()!.dispose(); });
const bench = (mode: "ask" | "full-auto", noLimits = false) => {
  const m = macBench(mode, { project: true });
  if (noLimits) m.policy.setNoLimits("b1", true);
  open.push(m);
  return m;
};

describe("the Mac's gate applies the owner's rules", () => {
  it("a Never rule on a folder blocks a Mac file write there, in No limits, with no card", () => {
    const m = bench("full-auto", true);
    const docs = path.join(m.home, "Documents");
    fs.mkdirSync(docs);
    m.policy.setRules(rules(`Never touch ${docs}`));
    const w = macOutcome(m.policy.check(m.req("", { op: "write-file", path: path.join(docs, "taxes.txt"), command: undefined })));
    expect(w.outcome).toBe("deny");
    expect(w.detail).toContain(`Never touch ${docs}`);
    // …a command naming it by a bare name from the home folder too, and one whose target can't be read.
    expect(macOutcome(m.policy.check(m.req("rm -rf Documents", { cwd: m.home }))).outcome).toBe("deny");
    // …but not a write elsewhere.
    expect(macOutcome(m.policy.check(m.req("", { op: "write-file", path: path.join(m.home, "code", "app", "notes.md"), command: undefined }))).outcome).toBe("allow");
  });

  it("an Ask first rule needs this call's own card in every mode", () => {
    for (const [mode, nl] of [["ask", false], ["full-auto", false], ["full-auto", true]] as const) {
      const m = bench(mode, nl);
      m.policy.setRules(rules("Ask before deletes"));
      const v = macOutcome(m.policy.check(m.req("rm old.log")));
      expect(v.outcome, `${mode}${nl ? "+no-limits" : ""}`).toBe("ask");
      expect(v.detail).toContain(STR_RULES.macAsk("Ask before deletes"));
    }
  });

  it("the hard core holds on the Mac in No limits, whatever the rules allow", () => {
    const m = bench("full-auto", true);
    m.policy.setRules(rules("Always allow commands", "Always allow file edits"));
    const userData = path.join(m.home, "Library", "Application Support", "Synapse");
    expect(macOutcome(m.policy.check(m.req("", { op: "write-file", path: path.join(userData, "local-policy.key"), command: undefined }))).outcome).toBe("deny");
    expect(macOutcome(m.policy.check(m.req("orb -u root id"))).outcome).toBe("deny");
    expect(macOutcome(m.policy.check(m.req("docker run --privileged alpine"))).outcome).toBe("deny");
  });

  it("with no rules from the host yet, the Mac's gate is exactly as before", () => {
    const m = bench("full-auto");
    expect(macOutcome(m.policy.check(m.req("npm test"))).outcome).toBe("allow");
  });
});

describe("the MacApp controller applies the owner's rules to the app and the person", () => {
  const controller = () => {
    const ran: unknown[] = [];
    const helper = { request: async () => ({ ok: true as const }), warm: async () => true, close: () => {}, alive: () => true } as unknown as MacHelper;
    const osa = { run: async (s: unknown) => { ran.push(s); return { ok: true as const, json: { sent: true }, raw: "" }; } };
    const home = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "macapp-rules-"));
    return { c: new MacAppController({ helper, osa: osa as never, home, userData: home, log: () => {}, now: () => 1_000 }), ran, home };
  };
  it("a Never rule on a person stops a Mail send to them, even approved", async () => {
    const { c, ran, home } = controller();
    const r = await c.handle({ botId: "b1", botName: "Ava", approved: true, rules: rules("Never email eve@evil.example"), args: { action: "mail.send", app: "Mail", target: "eve@evil.example", title: "Hi", text: "x" } as never });
    expect(r).toMatchObject({ ok: false });
    expect((r as { needsApproval?: boolean }).needsApproval).toBeUndefined();
    expect((r as { error: string }).error).toContain("Never email eve@evil.example");
    expect(ran).toHaveLength(0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
