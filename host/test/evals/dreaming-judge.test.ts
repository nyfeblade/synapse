import { describe, expect, it } from "vitest";
import { judge, type EvalCase } from "../../evals/dreaming/judge";

const c = (expect_: EvalCase["expect"]): EvalCase => ({ name: "t", mode: "evidence", today: "2026-09-19", memories: [{ content: "The standup is at 9 AM.", kind: "profile", origin: "explicit", date: "2026-09-01" }], expect: expect_ });
const before = [{ content: "The standup is at 9 AM.", kind: "profile", origin: "explicit" }];

describe("dreaming eval judge", () => {
  it("checks contains/absent/unchanged/maxMatching/kind and flags explicit changes and credentials", () => {
    expect(judge(c({ contains: ["10 AM"] }), before, [...before, { content: "As of 2026-09-18 the standup is at 10 AM.", kind: "log" }]).pass).toBe(true);
    expect(judge(c({ unchanged: true }), before, before).pass).toBe(true);
    const lost = judge(c({}), before, [{ content: "The standup is at 10 AM.", kind: "profile" }]);
    expect(lost.explicitChanged).toBe(true);
    expect(lost.pass).toBe(false);
    expect(judge(c({ absent: ["4821"] }), before, [...before, { content: "The user's bank PIN is 4821.", kind: "profile" }]).credentialStored).toBe(true);
    expect(judge(c({ maxMatching: { pattern: "standup", max: 1 } }), before, [...before, { content: "Standup moved.", kind: "log" }]).pass).toBe(false);
    expect(judge(c({ kind: { pattern: "v2", kind: "log" } }), before, [...before, { content: "The user shipped v2 on 2026-09-19.", kind: "log" }]).pass).toBe(true);
  });
});
