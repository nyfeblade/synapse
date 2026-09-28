import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateChanges } from "../../memory/dreaming/apply";
import { Dreamer, type DreamLlm } from "../../memory/dreaming/dreamer";
import { EvidenceQueue, isMemorable } from "../../memory/dreaming/evidence";
import { DreamMemoryPort, factId } from "../../memory/dreaming/port";
import { isMemorable as extractorIsMemorable } from "../../memory/extractor";
import { setFsyncOnWrite } from "../../util/atomic-json";
import { log } from "../../util/log";

const NOW = Date.UTC(2026, 8, 19, 15);
let root: string;
let port: DreamMemoryPort;
const w = (rel: string, s: string) => { const p = path.join(root, "agents", "b1", "memory", rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-"));
  w("profile.md", "# Profile\n- (2026-09-01) The user lives in Boston.\n- (2026-09-01) The user prefers short replies.\n");
  w("log/2026-09.md", "- (2026-09-10) [note] The user is traveling to Denver Sep 14–16.\n");
  port = new DreamMemoryPort(root, () => NOW);
  port.ensureInit("b1");
});
const id = (c: string) => factId(c);

describe("evidence (MEM-07)", () => {
  it("skips trivial exchanges and caps 12 per Bot with 8,000-char head/tail sides", () => {
    expect(isMemorable("thanks")).toBe(false);
    expect(isMemorable("where should we meet?")).toBe(true);
    expect(isMemorable("x".repeat(41))).toBe(true);
    const q = new EvidenceQueue();
    for (let i = 0; i < 14; i++) q.add("b", { user: `u${i}`, assistant: "a", occurredAt: i });
    expect(q.size("b")).toBe(12);
    q.add("c", { user: "y".repeat(20_000), assistant: "a", occurredAt: 1 });
    const [e] = q.take("c");
    expect(e!.user.length).toBeLessThanOrEqual(8000 + 20);
    expect(e!.user).toContain("…");
    expect(q.size("c")).toBe(0);
  });

  it("isMemorable is MEM-06's own test, not a re-implementation that can diverge on punctuation", () => {
    // A trivial reply padded with commas (not trailing !.?) so extractor's full-punctuation
    // strip still gates it as trivial, but a shallower trailing-only strip would not, and its
    // padded length would clear the 40-char threshold and be (wrongly) treated as memorable.
    const commaPaddedTrivial = `thank you${",".repeat(35)}`;
    expect(commaPaddedTrivial.length).toBeGreaterThan(40);
    expect(isMemorable(commaPaddedTrivial)).toBe(extractorIsMemorable(commaPaddedTrivial));
    expect(isMemorable(commaPaddedTrivial)).toBe(false);
  });
});

describe("port", () => {
  it("reads facts with origins: pre-existing facts are legacy, later non-synthesis facts explicit", () => {
    w("profile.md", "# Profile\n- (2026-09-01) The user lives in Boston.\n- (2026-09-01) The user prefers short replies.\n- (2026-09-19) The user's dog is Pepper.\n");
    const f = port.facts("b1");
    expect(f.map((x) => [x.content, x.kind, x.origin])).toEqual([
      ["The user lives in Boston.", "profile", "legacy"],
      ["The user prefers short replies.", "profile", "legacy"],
      ["The user's dog is Pepper.", "profile", "explicit"],
      ["The user is traveling to Denver Sep 14–16.", "log", "legacy"],
    ]);
  });

  it("applies create/update/remove, leaves tombstones and changes the fingerprint", () => {
    const fp = port.fingerprint("b1");
    port.apply("b1", [
      { op: "update", id: id("The user lives in Boston."), content: "The user lives in Chicago.", kind: "profile", sourceEvidenceIds: ["e1"] },
      { op: "remove", id: id("The user is traveling to Denver Sep 14–16."), sourceEvidenceIds: ["clock"] },
      { op: "create", content: "Standups moved to 10 AM on 2026-09-18.", kind: "log", sourceEvidenceIds: ["e1"] },
    ]);
    const facts = port.facts("b1");
    expect(facts.map((x) => x.content)).toEqual(["The user lives in Chicago.", "The user prefers short replies.", "Standups moved to 10 AM on 2026-09-18."]);
    expect(facts.find((x) => x.content.startsWith("The user lives"))!.origin).toBe("synthesis");
    expect(port.tombstoned("b1").has(id("The user is traveling to Denver Sep 14–16."))).toBe(true);
    expect(port.fingerprint("b1")).not.toBe(fp);
  });
});

describe("validateChanges (ORIG-06 §06.4)", () => {
  const ctx = () => {
    w("profile.md", "# Profile\n- (2026-09-01) The user lives in Boston.\n- (2026-09-19) The user's bank is Chase.\n");
    const facts = port.facts("b1");
    return { facts, evidenceIds: ["e1"], mode: "evidence" as const, tombstones: new Set([id("The user likes jazz.")]), expiryCandidates: [] };
  };
  it("rejects bad shapes, too many changes and two changes on one id", () => {
    expect(validateChanges({}, ctx())).toMatchObject({ ok: false });
    expect(validateChanges({ changes: Array.from({ length: 65 }, () => ({ op: "create", content: "x.", kind: "log", sourceEvidenceIds: ["e1"] })) }, ctx())).toMatchObject({ ok: false });
    const bos = id("The user lives in Boston.");
    expect(validateChanges({ changes: [{ op: "update", id: bos, content: "A.", kind: "profile", sourceEvidenceIds: ["e1"] }, { op: "remove", id: bos, sourceEvidenceIds: ["e1"] }] }, ctx())).toMatchObject({ ok: false, reason: expect.stringMatching(/same fact/) });
  });
  it("drops changes to explicit facts, uncited creates, clock creates, tombstoned creates; turns duplicate updates into removes", () => {
    const c = ctx();
    const r = validateChanges({ changes: [
      { op: "remove", id: id("The user's bank is Chase."), sourceEvidenceIds: ["e1"] },
      { op: "create", content: "The user likes jazz.", kind: "profile", sourceEvidenceIds: ["e1"] },
      { op: "create", content: "It is autumn.", kind: "log", sourceEvidenceIds: ["clock"] },
      { op: "create", content: "Uncited fact.", kind: "log", sourceEvidenceIds: ["e9"] },
      { op: "update", id: id("The user lives in Boston."), content: "the user's bank is chase.", kind: "profile", sourceEvidenceIds: ["e1"] },
    ] }, c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes).toEqual([{ op: "remove", id: id("The user lives in Boston."), sourceEvidenceIds: ["e1"] }]);
    expect(r.dropped).toHaveLength(4);
  });
  it("in temporal passes, clock may remove expiry candidates but never profile facts", () => {
    const c = { ...ctx(), mode: "temporal" as const, evidenceIds: [], expiryCandidates: [id("The user lives in Boston.")] };
    const r = validateChanges({ changes: [{ op: "remove", id: id("The user lives in Boston."), sourceEvidenceIds: ["clock"] }] }, c);
    expect(r.ok && r.changes).toEqual([]);
  });
});

describe("Dreamer (MEM-07 passes)", () => {
  function mk(llm: DreamLlm, o: { busy?: () => boolean; mode?: "standard" | "dreaming"; allows?: boolean } = {}) {
    const slept: number[] = [];
    const d = new Dreamer({
      port, llm, now: () => NOW, mode: () => o.mode ?? "dreaming", busy: o.busy ?? (() => false), botName: () => "Planner", botIds: () => ["b1"],
      ladder: () => ({ level: () => "L0", usagePct: () => null, allowsBackground: () => o.allows ?? true }), sleep: async (ms) => void slept.push(ms),
    });
    return { d, slept };
  }
  const bos = () => id("The user lives in Boston.");

  it("evidence pass: synthesize → verify → apply", async () => {
    const llm: DreamLlm = { synthesize: async () => ({ changes: [{ op: "update", id: bos(), content: "The user lives in Chicago.", kind: "profile", sourceEvidenceIds: ["e1"] }] }), verify: async () => ({ approved: true }) };
    const { d } = mk(llm);
    d.onSettled({ botId: "b1", hidden: false, userText: "I moved to Chicago last week, can you update my address?", sentTexts: ["Done."], result: { finalText: "" } } as never);
    expect(await d.runPass("b1", "evidence")).toBe("applied");
    expect(port.facts("b1").map((f) => f.content)).toContain("The user lives in Chicago.");
  });

  it("re-verifies the approved subset once when at least half survive", async () => {
    let verifies = 0;
    const llm: DreamLlm = {
      synthesize: async () => ({ changes: [
        { op: "create", content: "The user's standup is at 10 AM.", kind: "profile", sourceEvidenceIds: ["e1"] },
        { op: "create", content: "The user seems stressed.", kind: "profile", sourceEvidenceIds: ["e1"] },
      ] }),
      verify: async (inp) => (++verifies === 1 ? { approved: false, rejected: [{ index: 1, why: "inference" }] } : (inp as { proposedChanges: unknown[] }).proposedChanges.length === 1 ? { approved: true } : { approved: false }),
    };
    const { d } = mk(llm);
    d.onSettled({ botId: "b1", hidden: false, userText: "Our standup moved to 10 AM starting tomorrow, remember that?", sentTexts: ["Noted."], result: {} } as never);
    expect(await d.runPass("b1", "evidence")).toBe("applied");
    const contents = port.facts("b1").map((f) => f.content);
    expect(contents).toContain("The user's standup is at 10 AM.");
    expect(contents).not.toContain("The user seems stressed.");
    expect(verifies).toBe(2);
  });

  it("waits for the idle gate, skips in Standard mode, and aborts when memory changed meanwhile", async () => {
    let calls = 0;
    const { d, slept } = mk({ synthesize: async () => ({ changes: [] }), verify: async () => ({ approved: true }) }, { busy: () => ++calls < 3 });
    d.onSettled({ botId: "b1", hidden: false, userText: "Please remember that I like window seats on flights?", sentTexts: [], result: {} } as never);
    expect(await d.runPass("b1", "evidence")).toBe("noop");
    expect(slept).toEqual([60_000, 60_000]);
    expect(await mk({ synthesize: async () => ({ changes: [] }), verify: async () => ({ approved: true }) }, { mode: "standard" }).d.runPass("b1", "evidence")).toBe("skipped");
    const racer = mk({
      synthesize: async () => { w("profile.md", "# Profile\n- (2026-09-19) Changed by a tool write.\n"); return { changes: [{ op: "create", content: "New fact.", kind: "log", sourceEvidenceIds: ["e1"] }] }; },
      verify: async () => ({ approved: true }),
    });
    racer.d.onSettled({ botId: "b1", hidden: false, userText: "Remember this new fact for me please, it matters?", sentTexts: [], result: {} } as never);
    expect(await racer.d.runPass("b1", "evidence")).toBe("stale");
  });

  it("the hourly sweep runs temporal passes only when the ladder allows (ORIG-06 §06.1, ORIG-14 L2)", async () => {
    port.setNextRefreshAt("b1", NOW - 1);
    const llm: DreamLlm = { synthesize: async () => ({ changes: [] }), verify: async () => ({ approved: true }) };
    expect(await mk(llm, { allows: false }).d.sweep()).toEqual([]);
    expect(await mk(llm).d.sweep()).toEqual(["b1"]);
    expect(port.nextRefreshAt("b1")).toBe(NOW + 24 * 3600_000);
  });
});

describe("Fix round 1 findings", () => {
  // These two assert the durability itself, so they are the exception to the suite's
  // SYNAPSE_ATOMIC_FSYNC=off (host/vitest.config.ts): they put the real fsync back for their duration.
  let wasDurable = true;
  beforeEach(() => { wasDurable = setFsyncOnWrite(true); });
  afterEach(() => { setFsyncOnWrite(wasDurable); vi.restoreAllMocks(); });

  it("finding 1: apply() fsyncs markdown-file writes before rename, mirroring writeJsonAtomic", () => {
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    port.apply("b1", [
      { op: "update", id: id("The user lives in Boston."), content: "The user lives in Chicago.", kind: "profile", sourceEvidenceIds: ["e1"] },
    ]);
    // 2 JSON writes (origins.json, tombstones.json) already fsync via writeJsonAtomic; the markdown
    // write to profile.md must ALSO fsync, for a total of 3 — not just the 2 JSON ones.
    expect(fsyncSpy.mock.calls.length).toBe(3);
  });

  it("finding 1: setNextRefreshAt goes through tmp+fsync+rename, not a bare writeFileSync on the target path", () => {
    const renameSpy = vi.spyOn(fs, "renameSync");
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    port.setNextRefreshAt("b1", NOW + 1000);
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [tmpArg, finalArg] = renameSpy.mock.calls[0]!;
    expect(String(tmpArg)).not.toBe(String(finalArg));
    expect(String(tmpArg)).toContain("next-refresh-at");
    expect(fsyncSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(port.nextRefreshAt("b1")).toBe(NOW + 1000);
  });

  it("finding 2: validateChanges drops a second create in the same batch that normalizes to the same content as an earlier accepted create", () => {
    const facts = port.facts("b1");
    const r = validateChanges({ changes: [
      { op: "create", content: "The user's dog is Pepper.", kind: "profile", sourceEvidenceIds: ["e1"] },
      { op: "create", content: "the user's dog is pepper.", kind: "profile", sourceEvidenceIds: ["e1"] },
    ] }, { facts, evidenceIds: ["e1"], mode: "evidence", tombstones: new Set(), expiryCandidates: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
  });

  it("finding 3: dreamer logs the caught error from a failed synthesize/verify call before retrying", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const boom = new Error("SDK crashed: malformed JSON");
    const llm: DreamLlm = { synthesize: async () => { throw boom; }, verify: async () => ({ approved: true }) };
    const d = new Dreamer({
      port, llm, now: () => NOW, mode: () => "dreaming", busy: () => false, botName: () => "Planner", botIds: () => ["b1"],
      ladder: () => ({ level: () => "L0", usagePct: () => null, allowsBackground: () => true }), sleep: async () => {},
    });
    d.onSettled({ botId: "b1", hidden: false, userText: "Please remember that I like window seats on flights?", sentTexts: [], result: {} } as never);
    expect(await d.runPass("b1", "evidence")).toBe("timeout");
    expect(warnSpy).toHaveBeenCalled();
    const calledWithError = warnSpy.mock.calls.some((args) => JSON.stringify(args).includes("SDK crashed"));
    expect(calledWithError).toBe(true);
  });
});

// Final integration: "redaction in memory" is authoritative — a dreaming pass writes nothing the scanner would redact.
describe("dreaming respects the secret scanner (integration)", () => {
  it("redacts a Bot's secret values in synthesized facts before they reach profile.md or the log", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dream-redact-"));
    const port = new DreamMemoryPort(root, () => Date.UTC(2026, 8, 19), (_b, t) => t.split("sk_live_dream_42").join("[REDACTED:API_KEY]"));
    port.apply("b", [
      { op: "create", kind: "profile", content: "The user's Stripe key is sk_live_dream_42", sourceEvidenceIds: [] },
      { op: "create", kind: "log", content: "Rotated sk_live_dream_42 today", sourceEvidenceIds: [] },
    ]);
    const files = [path.join(root, "agents", "b", "memory", "profile.md"), path.join(root, "agents", "b", "memory", "log", "2026-09.md")];
    for (const f of files) {
      expect(fs.readFileSync(f, "utf8")).not.toContain("sk_live_dream_42");
      expect(fs.readFileSync(f, "utf8")).toContain("[REDACTED:API_KEY]");
    }
  });
});
