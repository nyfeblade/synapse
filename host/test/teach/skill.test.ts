import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TeachState } from "@synapse/shared";
import { GatewayError } from "../../gateway/errors";
import { newSlot } from "../../runner/turn-slot";
import { ALLOWED } from "../../teach/recorder";
import { evaluateRehearsal, rehearsalSummary, teachReviewProvider } from "../../teach/rehearsal";
import { installManagedSkill, installManagedSkillOnBoot, lintTeachSkill, parseSkill, setSkillStatus, TEACH_SECTIONS } from "../../teach/skill";
import { tmpConfig } from "../helpers";

const SKILL = `---
name: File an expense report
description: Use this when the user asks to file an expense in Expensify from a receipt file.
metadata:
  source: teach-a-task
  teachSession: teach-1
  status: draft
  checkpoints: 6
  parameters:
    - {name: receipt_file, type: file, required: true, description: "Receipt PDF or image", example: "/workspace/uploads/receipt.pdf"}
    - {name: amount, type: number, required: true, example: "42.10"}
    - {name: card_pin, type: secret, required: true}
---
${TEACH_SECTIONS.map((s) => `${s}\n${s === "## Failure handling" ? "If a site blocks you, use request_box_help." : s === "## Approval points" ? "- Step 6: ⚠ Approval point — Submit report" : "text"}\n`).join("\n")}`;

const TRACE = { goal: "File an expense", steps: [1, 2, 3, 4, 5].map((n) => ({ n, intent: `step ${n}`, commit: false })).concat([{ n: 6, intent: "Submit report", commit: true }]) };
const REHEARSAL_OK = { steps: [1, 2, 3, 4, 5].map((n) => ({ n, status: "ok", observedUrl: "u", note: "" })).concat([{ n: 6, status: "stopped_before_commit", observedUrl: "u", note: "" }]) };

describe("managed skill and lint (SKL-01, ORIG-08 §08.4)", () => {
  it("installs the managed skill once, with the verbatim drafting prompt", () => {
    const cfg = tmpConfig();
    expect(installManagedSkill(cfg)).toBe(true);
    expect(installManagedSkill(cfg)).toBe(false);
    const md = fs.readFileSync(path.join(cfg.claudeConfigDir, "skills", "learn-from-demonstration", "SKILL.md"), "utf8");
    expect(parseSkill(md).front).toMatchObject({ name: "learn-from-demonstration", metadata: { managed: true } });
    expect(md).toContain("<<LEARN_FROM_DEMO_V1>>");
    expect(md).toContain('options "Run a rehearsal" and "Not now".');
  });

  // ~/.claude/skills is box-writable by design, and the root helper that publishes SKILL.md now runs as box, so a
  // skill directory box can't write (a legacy host-owned one, or one a Bot made) makes the write throw. On the boot
  // path that must not take the whole host down -- it crash-looped the gateway on the live box.
  it("boot install survives a failing write and reports it", () => {
    const cfg = tmpConfig();
    const err = new Error("mktemp: failed to create file via template");
    const boom = () => { throw err; };
    expect(() => installManagedSkill(cfg, boom)).toThrow(err);
    const seen: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { seen.push(a.join(" ")); });
    try {
      expect(installManagedSkillOnBoot({ ...cfg, brain: "claude" } as typeof cfg, boom)).toBe(false);
    } finally { spy.mockRestore(); }
    expect(seen.join("\n")).toMatch(/learn-from-demonstration|managed skill/i);
    expect(seen.join("\n")).toMatch(/mktemp/);
  });

  it("accepts a well-formed teach skill and reports every problem otherwise", () => {
    expect(lintTeachSkill(SKILL)).toEqual([]);
    expect(lintTeachSkill(SKILL.replace("## Decision points\n", ""))).toContain('Missing section "## Decision points".');
    expect(lintTeachSkill(SKILL.replace("status: draft", "status: done"))).toContain("metadata.status must be draft or tested.");
    expect(lintTeachSkill(SKILL.replace("name: amount", "name: Amount"))).toContain('Parameter "Amount" must be snake_case.');
    expect(lintTeachSkill(SKILL.replace("{name: card_pin, type: secret, required: true}", '{name: card_pin, type: secret, required: true, example: "1234"}'))).toContain('Secret parameter "card_pin" must not have an example.');
    expect(lintTeachSkill(SKILL.replace("use request_box_help", "retry"))).toContain('"## Failure handling" must mention request_box_help.');
    expect(lintTeachSkill("no front matter")).toContain("The skill needs YAML front matter.");
    expect(lintTeachSkill(SKILL + "x".repeat(100_001))).toContain("The skill is longer than 100,000 characters.");
  });

  it("sets and removes the status", () => {
    const f = path.join(tmpConfig().workspace, "SKILL.md");
    fs.writeFileSync(f, SKILL);
    setSkillStatus(f, "tested");
    expect(parseSkill(fs.readFileSync(f, "utf8")).front).toMatchObject({ metadata: { status: "tested" } });
    setSkillStatus(f, null);
    expect((parseSkill(fs.readFileSync(f, "utf8")).front.metadata as Record<string, unknown>).status).toBeUndefined();
  });
});

// Controller correction: falling back to a local (bothost fs) write when cfg.brain === "claude" but
// the skill id can't be safely resolved from skillPath is fail-OPEN -- that local write is exactly
// the unsafe op the ruling exists to close off. It must refuse instead (no write at all), and only
// the "fake" brain or FUZZ mode (process.env.FUZZ === "1", the same flag app.ts's own `fuzz` uses)
// may use a local write.
describe("setSkillStatus fails closed under cfg.brain === 'claude' (no fallback to a local write)", () => {
  it("refuses (throws) and writes nothing when the path doesn't resolve to a real skill id", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    // Deeper than <skills>/<id>/SKILL.md -- skillIdFromPath refuses to guess an id for this shape.
    const dir = path.join(cfg.claudeConfigDir, "skills", "a", "b");
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, "SKILL.md");
    fs.writeFileSync(skillPath, SKILL);
    expect(() => setSkillStatus(skillPath, "tested", undefined, cfg)).toThrow();
    expect(parseSkill(fs.readFileSync(skillPath, "utf8")).front).toMatchObject({ metadata: { status: "draft" } });
  });

  it("still uses a local write when cfg.brain is 'fake' (dev/test, no box, no adversarial Bot), even for the same unresolvable path", () => {
    const cfg = tmpConfig(); // BRAIN defaults to "fake"
    const dir = path.join(cfg.claudeConfigDir, "skills", "a", "b");
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, "SKILL.md");
    fs.writeFileSync(skillPath, SKILL);
    setSkillStatus(skillPath, "tested", undefined, cfg);
    expect(parseSkill(fs.readFileSync(skillPath, "utf8")).front).toMatchObject({ metadata: { status: "tested" } });
  });

  it("still uses a local write under FUZZ=1 even when cfg.brain is 'claude'", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    const dir = path.join(cfg.claudeConfigDir, "skills", "a", "b");
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, "SKILL.md");
    fs.writeFileSync(skillPath, SKILL);
    const prev = process.env.FUZZ;
    process.env.FUZZ = "1";
    try {
      setSkillStatus(skillPath, "tested", undefined, cfg);
    } finally {
      if (prev === undefined) delete process.env.FUZZ; else process.env.FUZZ = prev;
    }
    expect(parseSkill(fs.readFileSync(skillPath, "utf8")).front).toMatchObject({ metadata: { status: "tested" } });
  });
});

describe("rehearsal evaluation (ORIG-08 §08.3)", () => {
  it("passes when every step before the first commit is ok and the run stopped there", () => {
    const r = evaluateRehearsal(REHEARSAL_OK, TRACE);
    expect(r).toEqual({ pass: true, ok: 5, total: 5, stoppedBefore: "Submit report" });
    expect(rehearsalSummary(r)).toBe('Rehearsal passed 5/5 steps and stopped before "Submit report".');
  });
  it("fails on a mismatch or when it ran past the commit", () => {
    const mismatch = { steps: REHEARSAL_OK.steps.map((s) => (s.n === 3 ? { ...s, status: "mismatch", note: "no Category menu" } : s)) };
    expect(evaluateRehearsal(mismatch, TRACE)).toMatchObject({ pass: false, ok: 4, total: 5 });
    const ranPast = { steps: REHEARSAL_OK.steps.map((s) => ({ ...s, status: "ok" })) };
    expect(evaluateRehearsal(ranPast, TRACE).pass).toBe(false);
    expect(evaluateRehearsal({ steps: [{ n: 1, status: "ok" }, { n: 2, status: "ok" }] }, { steps: [{ n: 1, commit: false }, { n: 2, commit: false }] })).toMatchObject({ pass: true, ok: 2, total: 2, stoppedBefore: null });
  });
});

describe("TeachReview tool", () => {
  function setup(initial: TeachState = "ANALYZING") {
    const cfg = tmpConfig();
    const dir = path.join(cfg.workspace, "teach-sessions", "teach-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "trace.json"), JSON.stringify(TRACE));
    const skillPath = path.join(cfg.claudeConfigDir, "skills", "file-an-expense-report", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, SKILL);
    const states: TeachState[] = [];
    // A faithful fake: enforces the real ALLOWED transition table (host/teach/recorder.ts), throwing
    // GatewayError exactly like the production TeachRecorder does on an illegal transition.
    let state: TeachState = initial;
    const recorder = {
      current: () => ({ botId: "bot-1", sessionId: "teach-1", sessionDir: dir, goal: "g" }),
      setState: (s: TeachState) => {
        if (!ALLOWED[state].includes(s)) throw new GatewayError("TEACH_STATE", `Teach a task can't go ${state} → ${s}.`, 409);
        state = s;
        states.push(s);
      },
      status: () => ({ state, botId: "bot-1", sessionId: "teach-1", sessionDir: dir, startedAtMs: 1, elapsedMs: 0, goal: "g" }),
    };
    const slot = newSlot({ botId: "bot-1", requestId: "r", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 0, startedAt: 1 });
    const tool = teachReviewProvider({ cfg, recorder })("bot-1", () => slot)[0]!;
    return { cfg, dir, skillPath, tool, states };
  }

  it("a passing rehearsal marks the skill tested; accept makes it live", async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.dir, "rehearsal.json"), JSON.stringify(REHEARSAL_OK));
    const r = await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "rehearsed" });
    expect(r.text).toContain('Rehearsal passed 5/5 steps and stopped before "Submit report".');
    expect(s.states).toEqual(["DRAFTED", "REHEARSING", "TESTED"]);
    expect(parseSkill(fs.readFileSync(s.skillPath, "utf8")).front).toMatchObject({ metadata: { status: "tested" } });
    const a = await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "accept" });
    expect(a.text).toContain("live");
    expect(s.states.at(-1)).toBe("ACCEPTED");
    expect((parseSkill(fs.readFileSync(s.skillPath, "utf8")).front.metadata as Record<string, unknown>).status).toBeUndefined();
  });

  it("allows two automatic revisions, then asks the user", async () => {
    const s = setup();
    const failOnce = async () => {
      fs.writeFileSync(path.join(s.dir, "rehearsal.json"), JSON.stringify({ steps: [{ n: 1, status: "mismatch", note: "x" }] }));
      return (await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "rehearsed" })).text;
    };
    expect(await failOnce()).toContain("revision 1 of 2");
    expect(await failOnce()).toContain("revision 2 of 2");
    expect(await failOnce()).toContain("Ask the user");
    expect(s.states.filter((x) => x === "NEEDS_FIX")).toHaveLength(3);
  });

  it("refuses skills outside the skills library, other sessions and invalid skills", async () => {
    const s = setup();
    expect((await s.tool.handler({ session: "teach-1", skill_path: "/etc/passwd", action: "accept" })).isError).toBe(true);
    expect((await s.tool.handler({ session: "teach-2", skill_path: s.skillPath, action: "accept" })).isError).toBe(true);
    fs.writeFileSync(s.skillPath, SKILL.replace("## Steps\n", ""));
    const r = await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "rehearsed" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('Missing section "## Steps".');
  });

  // Fix round 1, finding 1 (host/teach/rehearsal.ts:61-71): the "rehearsed" branch had no state
  // whitelist (unlike "accept"'s explicit `if (state !== ...) return err(...)`), so a late/duplicate
  // "rehearsed" call after the skill was already ACCEPTED fell through to an unconditional
  // move(["TESTED"|"NEEDS_FIX"]) that TeachRecorder.setState() rejects for ACCEPTED (ALLOWED.ACCEPTED
  // = [IDLE, RECORDING]), throwing an uncaught GatewayError — after rehearsalFile was already
  // fs.rmSync'd, destroying the evidence before the crash. toSdkMcpServer (host/brain/sdk-wiring.ts)
  // awaits the handler with no try/catch, so nothing upstream turns that into a graceful tool result.
  it("a late 'rehearsed' call after the skill was already accepted fails gracefully, not with a thrown error, and preserves rehearsal.json", async () => {
    const s = setup();
    const accepted = await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "accept" });
    expect(accepted.isError).toBeFalsy();
    expect(s.states.at(-1)).toBe("ACCEPTED");
    // A leftover rehearsal.json from before the accept (or a duplicate/out-of-order call).
    fs.writeFileSync(path.join(s.dir, "rehearsal.json"), JSON.stringify(REHEARSAL_OK));
    const r = await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "rehearsed" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ACCEPTED");
    // No further (illegal) state transition was attempted, and the evidence wasn't deleted.
    expect(s.states.at(-1)).toBe("ACCEPTED");
    expect(fs.existsSync(path.join(s.dir, "rehearsal.json"))).toBe(true);
  });

  // Fix round 1, finding 2 (host/teach/rehearsal.ts:47-48,55-56,66-68): skill_path was authorized only
  // by containment under the shared skills library plus lintTeachSkill's structural checks — nothing
  // tied the target SKILL.md to the caller's *current* teach session. Any Bot with an active teach
  // session could pass a different, unrelated skill's path from the shared library and flip its status.
  it("refuses to accept or mark tested a skill drafted in a different Teach a task session", async () => {
    const s = setup();
    const otherSkillPath = path.join(s.cfg.claudeConfigDir, "skills", "some-other-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(otherSkillPath), { recursive: true });
    fs.writeFileSync(otherSkillPath, SKILL.replace("teachSession: teach-1", "teachSession: teach-OTHER-SESSION"));

    const a = await s.tool.handler({ session: "teach-1", skill_path: otherSkillPath, action: "accept" });
    expect(a.isError).toBe(true);

    fs.writeFileSync(path.join(s.dir, "rehearsal.json"), JSON.stringify(REHEARSAL_OK));
    const r = await s.tool.handler({ session: "teach-1", skill_path: otherSkillPath, action: "rehearsed" });
    expect(r.isError).toBe(true);

    // The other skill was never mutated.
    expect((parseSkill(fs.readFileSync(otherSkillPath, "utf8")).front.metadata as Record<string, unknown>).status).toBe("draft");
    expect(s.states).toEqual([]);
  });
});
