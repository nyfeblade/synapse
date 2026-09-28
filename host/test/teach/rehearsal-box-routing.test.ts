import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeachState } from "@synapse/shared";
import { newSlot } from "../../runner/turn-slot";
import { ALLOWED } from "../../teach/recorder";
import { tmpConfig } from "../helpers";

// Controller ruling: setSkillStatus (host/teach/skill.ts), used by teach/rehearsal.ts's TeachReview
// tool to flip an existing skill's status ("draft"/"tested"/accepted), must not write the box-writable
// ~/.claude/skills tree with the host's own fs, the same as SkillLibrary.write(). It derives the
// skill id from the already-validated skill_path (skillsRoot/<id>/SKILL.md, checked by
// teachReviewProvider before setSkillStatus ever runs) and routes through writeSkillFile.
vi.mock("../../skills/skill-box-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../skills/skill-box-ops")>();
  return { ...actual, writeSkillFile: vi.fn() };
});

const { writeSkillFile } = await import("../../skills/skill-box-ops");
const { teachReviewProvider } = await import("../../teach/rehearsal");
const { parseSkill } = await import("../../teach/skill");

const SKILL = `---
name: File an expense report
description: Use this when the user asks to file an expense in Expensify from a receipt file.
metadata:
  source: teach-a-task
  teachSession: teach-1
  status: draft
---
## When to use
text

## Inputs and access
text

## Steps
text

## Decision points
text

## Validation
text

## Output
text

## Approval points
- Step 6: ⚠ Approval point — Submit report

## Failure handling
If a site blocks you, use request_box_help.
`;
const TRACE = { goal: "File an expense", steps: [{ n: 1, intent: "step 1", commit: false }, { n: 2, intent: "Submit report", commit: true }] };
const REHEARSAL_OK = { steps: [{ n: 1, status: "ok", observedUrl: "u", note: "" }, { n: 2, status: "stopped_before_commit", observedUrl: "u", note: "" }] };

function setup(o: { nested?: boolean } = {}) {
  const cfg = tmpConfig({ BRAIN: "claude" });
  const dir = path.join(cfg.workspace, "teach-sessions", "teach-1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "trace.json"), JSON.stringify(TRACE));
  const skillId = "file-an-expense-report";
  // A nested path (skillsRoot/a/b/SKILL.md) still passes teachReviewProvider's own containment
  // check (starts under skillsRoot, basename SKILL.md) but doesn't resolve to a real skill id.
  const skillPath = o.nested
    ? path.join(cfg.claudeConfigDir, "skills", "a", "b", "SKILL.md")
    : path.join(cfg.claudeConfigDir, "skills", skillId, "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, SKILL);
  let state: TeachState = "ANALYZING";
  const states: TeachState[] = [];
  const recorder = {
    current: () => ({ botId: "bot-1", sessionId: "teach-1", sessionDir: dir, goal: "g" }),
    setState: (s: TeachState) => { state = s; states.push(s); },
    status: () => ({ state, botId: "bot-1", sessionId: "teach-1", sessionDir: dir, startedAtMs: 1, elapsedMs: 0, goal: "g" }),
  };
  void ALLOWED;
  const slot = newSlot({ botId: "bot-1", requestId: "r", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 0, ackToken: null, userMessageEpoch: 0, startedAt: 1 });
  const tool = teachReviewProvider({ cfg, recorder })("bot-1", () => slot)[0]!;
  return { cfg, dir, skillId, skillPath, tool };
}

describe("setSkillStatus routes through writeSkillFile when cfg.brain === 'claude'", () => {
  beforeEach(() => { vi.mocked(writeSkillFile).mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("a passing rehearsal marks the skill tested via writeSkillFile(id, content), never fs.writeFileSync directly", async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.dir, "rehearsal.json"), JSON.stringify(REHEARSAL_OK));
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const r = await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "rehearsed" });
    expect(r.isError).toBeFalsy();
    expect(writeSkillFile).toHaveBeenCalledTimes(1);
    const [id, content] = vi.mocked(writeSkillFile).mock.calls[0]!;
    expect(id).toBe(s.skillId);
    expect(parseSkill(content).front).toMatchObject({ metadata: { status: "tested" } });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("accept clears the status via writeSkillFile too, never fs.writeFileSync directly", async () => {
    const s = setup();
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const r = await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "accept" });
    expect(r.isError).toBeFalsy();
    expect(writeSkillFile).toHaveBeenCalledTimes(1);
    const [id, content] = vi.mocked(writeSkillFile).mock.calls[0]!;
    expect(id).toBe(s.skillId);
    expect((parseSkill(content).front.metadata as Record<string, unknown>).status).toBeUndefined();
    expect(writeFile).not.toHaveBeenCalled();
  });

  // Controller correction: setSkillStatus now throws (fails closed) instead of silently falling back
  // to a local write when the skill id can't be resolved under cfg.brain === "claude". The tool
  // handler must turn that into a graceful isError result -- not an uncaught exception -- the same
  // way it already does for a TeachRecorder.setState() rejection a few lines above (see the "Fix
  // round 1, finding 1" comment in host/teach/rehearsal.ts).
  it("a skill_path that doesn't resolve to a real id fails gracefully (isError), never crashes, and never falls back to a local write", async () => {
    const s = setup({ nested: true });
    fs.writeFileSync(path.join(s.dir, "rehearsal.json"), JSON.stringify(REHEARSAL_OK));
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const r = await s.tool.handler({ session: "teach-1", skill_path: s.skillPath, action: "rehearsed" });
    expect(r.isError).toBe(true);
    expect(writeSkillFile).not.toHaveBeenCalled();
    const skillWrites = writeFile.mock.calls.filter(([p]) => String(p) === s.skillPath);
    expect(skillWrites).toEqual([]);
    expect(parseSkill(fs.readFileSync(s.skillPath, "utf8")).front).toMatchObject({ metadata: { status: "draft" } });
  });
});
