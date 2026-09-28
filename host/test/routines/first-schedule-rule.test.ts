import { describe, expect, it } from "vitest";
import { STRS } from "@synapse/shared";
import { firstScheduleRule } from "../../routines/first-schedule-rule";
import type { ReviewRequest } from "../../review/types";

const req = (botId: string, action: string, surface = "automation_write"): ReviewRequest =>
  ({ botId, surface, target: { action: "automation_write", arguments: { action }, enrichment: null } }) as unknown as ReviewRequest;

describe("first schedule needs the user's confirmation", () => {
  it("asks for a Bot's first routine create, then falls through to the normal review", () => {
    const confirmed = new Set<string>();
    const rule = firstScheduleRule((id) => confirmed.has(id));
    expect(rule(req("b1", "create"))).toBe(STRS.firstScheduleConfirm);
    confirmed.add("b1");
    expect(rule(req("b1", "create"))).toBeNull();
    expect(rule(req("b2", "update"))).toBeNull(); // only a create sets one up
    expect(rule(req("b2", "create", "box_shell"))).toBeNull();
  });
});
