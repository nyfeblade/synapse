// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { STR, type ApprovalCardView, type ToolCallEntry, type TranscriptEntry } from "@synapse/shared";
import { ActivityGroup } from "../../src/renderer/components/ActivityGroup";
import { ApprovalCard } from "../../src/renderer/components/ApprovalCard";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";

afterEach(cleanup);

const stepEntry = (over: Partial<ToolCallEntry>): ToolCallEntry => ({
  kind: "tool-call", id: "s1", requestId: "r1", segmentId: "r1:0", hidden: false, name: "Bash", step: "rm -rf /workspace/tmp/x",
  icon: "terminal", metric: null, status: "stopped", startedAt: 1000, endedAt: 1100, ...over,
});
const approval: ApprovalCardView = {
  approvalId: "ap1", requestId: "r1", surface: "box_shell", title: "Feedback Miner would like to run a command", reason: "", summary: "Run “rm -rf /workspace/tmp/x”",
  locationLine: null, details: null, command: "rm -rf /workspace/tmp/x", items: [], hasProposedRule: false, status: "stopped", cause: "stopped",
  verdict: null, ruleAddedText: null, createdAt: 1, settledAt: 2,
};

describe("new-user walk finding 3: Stop reads as stopped by you", () => {
  it("a stopped step is a 'Stopped' row with a neutral mark: no check, no 'Failed', no 'Ran'", () => {
    const items = buildTranscriptItems([stepEntry({})] as TranscriptEntry[], 2000);
    const act = items.find((i) => i.kind === "activity");
    if (act?.kind !== "activity") throw new Error("no activity item");
    expect(act.rows[0]!.verb).toBe(STR.stoppedStep("rm -rf /workspace/tmp/x"));
    expect(act.stopped).toBe(true);
    const { container } = render(<ActivityGroup item={act} />);
    expect(container.textContent).not.toMatch(/Failed|Ran /);
    expect(container.querySelector(".activity-mark.stopped")).toBeTruthy();
    expect(container.querySelector(".activity-mark svg.check, .activity-mark.done")).toBeNull();
  });

  it("the card settles as 'Stopped by you', never 'Approval expired'", () => {
    render(<ApprovalCard botId="a" approval={approval} />);
    expect(document.body.textContent).toContain(STR.settledLabel.stopped);
    expect(document.body.textContent).not.toMatch(/expired/i);
  });
});
