import path from "node:path";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../review/circuit";
import { VerdictCache } from "../../review/cache";
import { compileAll, fastPathAllowed, ruleCards, ruleHash } from "../../review/rules";
import { HostSettingsStore } from "../../store/host-settings";
import { tmpConfig } from "../helpers";

const staticRO = { tierHint: 0 as const, signals: [], floorHits: [], readOnly: true };

describe("rules (§01.5)", () => {
  it("numbers rules A1…/K1… and compiles each once with a conservative fallback", async () => {
    const cfg = tmpConfig();
    const st = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
    st.update({ allowInstructions: ["Use the Shell tool to run npm test in /workspace/app"], blockInstructions: ["Ask before reading anything in /workspace/clients", "Ask before anything irreversible"] });
    let calls = 0;
    await compileAll(st, async (input) => {
      calls++;
      const { id, behavior, text } = JSON.parse(input);
      if (text.includes("irreversible")) throw new Error("model error");
      return { id, text, behavior, surfaces: ["box_shell"], services: [], verbs: ["read"], targets: { paths: ["/workspace/clients"], hosts: [], domains: [], recipients: [], channels: [], repos: [] }, conditions: [], breadth: "narrow" };
    });
    expect(calls).toBe(3);
    const cards = ruleCards(st.get());
    expect(cards.map((c) => c.id)).toEqual(["A1", "K1", "K2"]);
    expect(cards[2]!.surfaces).toEqual(["any"]);
    await compileAll(st, async () => { throw new Error("should be cached"); });
    expect(Object.keys(st.get().autoReviewCompiled)).toContain(ruleHash("Ask before reading anything in /workspace/clients", "ask"));
  });

  it("gates the fast path on Ask-first rules that touch the command (§01.4 condition 3)", () => {
    const base = { id: "K1", text: "", behavior: "ask" as const, services: [], conditions: [], breadth: "narrow" as const };
    const tgt = (paths: string[]) => ({ paths, hosts: [], domains: [], recipients: [], channels: [], repos: [] });
    const touching = { ...base, surfaces: ["box_shell"], verbs: ["read"], targets: tgt(["/workspace/clients"]) };
    const other = { ...base, surfaces: ["mcp"], verbs: ["send"], targets: tgt([]) };
    const any = { ...base, surfaces: ["any"], verbs: [], targets: tgt([]) };
    const req = (p: string[]) => ({ surface: "box_shell" as const, staticResult: staticRO, paths: p });
    expect(fastPathAllowed(req(["/workspace/reports"]), [other])).toBe(true);
    expect(fastPathAllowed(req(["/workspace/clients/acme"]), [touching])).toBe(false);
    expect(fastPathAllowed(req(["/workspace/reports"]), [touching])).toBe(true);
    expect(fastPathAllowed(req([]), [any])).toBe(false);
    expect(fastPathAllowed({ ...req([]), staticResult: { ...staticRO, readOnly: false } }, [])).toBe(false);
  });
});

describe("VerdictCache (§01.8)", () => {
  it("keeps any verdict 60 s, low-tier allows until the next user message (max 30 min), never errors", () => {
    let t = 0;
    const c = new VerdictCache(() => t);
    const allow = { kind: "allow" as const, stage: "model" as const, verdict: null };
    c.set("k", allow, 1, 5);
    t = 59_000;
    expect(c.get("k", 5)).toEqual(allow);
    t = 61_000;
    expect(c.get("k", 5)).toEqual(allow);
    expect(c.get("k", 6)).toBeNull();
    c.set("h", { kind: "block", stage: "model", reason: "x", proposedRule: null, verdict: null }, 3, 5);
    t = 200_000;
    expect(c.get("h", 5)).toBeNull();
    c.set("e", { kind: "error", message: "x" }, 0, 5);
    expect(c.get("e", 5)).toBeNull();
    c.clear();
    expect(c.get("k", 5)).toBeNull();
  });
});

describe("CircuitBreaker (§01.10)", () => {
  it("degrades after 3 errors in 5 min, probes every 2 min after 10 min, heals on success", () => {
    let t = 0;
    const b = new CircuitBreaker(() => t);
    b.recordError(); b.recordError();
    expect(b.state).toBe("healthy");
    b.recordError();
    expect(b.state).toBe("degraded");
    t = 9 * 60_000;
    expect(b.shouldProbe()).toBe(false);
    t = 10 * 60_000 + 1;
    expect(b.shouldProbe()).toBe(true);
    b.recordError();
    expect(b.state).toBe("degraded");
    t += 2 * 60_000 + 1;
    expect(b.shouldProbe()).toBe(true);
    b.recordSuccess();
    expect(b.state).toBe("healthy");
  });
});
