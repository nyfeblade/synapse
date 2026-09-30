// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { STRV, type ApprovalCardView, type BotSummary, type ToolCallEntry, type TranscriptEntry } from "@synapse/shared";
import { ActivityGroup } from "../../src/renderer/components/ActivityGroup";
import { liveStatus } from "../../src/renderer/components/ChatView";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";
import { botPresence } from "../../src/renderer/voice/presence-label";

afterEach(cleanup);

const bot = { running: true, presence: "working", activity: { tool: "Bash", detail: "rm -rf /workspace/tmp/x" }, awaiting: { tabId: "auto-review", reason: "Approval needed: rm -rf", since: 1 } } as unknown as BotSummary;

describe("new-user walk finding 6: a Bot waiting on an approval reads as 'Needs you', not 'Working'", () => {
  it("the header chip and the sidebar row say Needs you", () => {
    expect(liveStatus(bot, false)).toEqual({ label: STRV.presenceWaiting, kind: "waiting" });
    expect(botPresence(bot, false)).toEqual({ kind: "waiting", label: STRV.presenceWaiting });
    // not waiting: unchanged
    expect(botPresence({ ...bot, awaiting: null }, false).kind).toBe("busy");
  });

  it("the waiting step shows a paused mark and no spinner or 'Running'", () => {
    const step: ToolCallEntry = { kind: "tool-call", id: "s1", requestId: "r1", segmentId: "r1:0", hidden: false, name: "Bash", step: "Running rm -rf /workspace/tmp/x", icon: "terminal", metric: null, status: "running", startedAt: 1000 };
    const approval = { approvalId: "a", requestId: "r1", status: "pending" } as ApprovalCardView;
    const entries = [step, { kind: "send-message", id: "m1", requestId: "r1", createdAt: 1001, message: { type: "auto-review-approval", approval } }] as TranscriptEntry[];
    const act = buildTranscriptItems(entries, 2000).find((i) => i.kind === "activity");
    if (act?.kind !== "activity") throw new Error("no activity");
    expect(act.waiting).toBe(true);
    const { container } = render(<ActivityGroup item={act} />);
    expect(container.querySelector(".activity-mark.waiting")).toBeTruthy();
    expect(container.querySelector(".activity-mark.running, .activity-row.live")).toBeNull();
    expect(container.textContent).not.toMatch(/Running/);
    expect(container.textContent).toContain("rm -rf /workspace/tmp/x");
  });
});
