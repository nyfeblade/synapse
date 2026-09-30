// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallEntry, Tray } from "@synapse/shared";
import { ActivityGroup } from "../../src/renderer/components/ActivityGroup";
import { Trays } from "../../src/renderer/components/Trays";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { buildTranscriptItems, type TranscriptItem } from "../../src/renderer/transcript-items";

// Bug 437: a group of failed steps showed a green check and listed each identical failure again.
let n = 0;
const step = (status: ToolCallEntry["status"], text = "Ran ls build/output", metric: ToolCallEntry["metric"] = null): ToolCallEntry => ({
  kind: "tool-call", id: `t1tc${++n}`, requestId: "r1", segmentId: "s1", hidden: false, name: "Bash", step: text, icon: "terminal",
  metric, status, startedAt: 1000 + n, endedAt: 1100 + n,
});
const ok = (text: string) => step("done", text, { verb: "Ran", noun: "command", nounPlural: "commands", count: 1 });
const activity = (steps: ToolCallEntry[]) => buildTranscriptItems(steps, 5000).find((i): i is Extract<TranscriptItem, { kind: "activity" }> => i.kind === "activity")!;

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async () => ({ ok: true, result: {} })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
  useUi.setState(initialState());
});
afterEach(cleanup);

describe("an activity group's outcome", () => {
  it("all failed is failed: a cross, never the green check", () => {
    const item = activity([step("error"), step("error"), step("error"), step("error")]);
    expect(item.outcome).toBe("failed");
    const { container } = render(<ActivityGroup item={item} />);
    expect(container.querySelector(".activity-mark")!.className).toContain("failed");
    expect(container.querySelector(".activity-mark.done")).toBeNull();
  });

  it("some failed is partial (neutral); none failed is done", () => {
    expect(activity([ok("Ran npm ci"), step("error")]).outcome).toBe("partial");
    const done = activity([ok("Ran npm ci"), ok("Ran npm test")]);
    expect(done.outcome).toBeUndefined();
    const { container } = render(<ActivityGroup item={done} />);
    expect(container.querySelector(".activity-mark")!.className).toContain("done");
  });

  it("identical consecutive failed steps are one row with a quiet ×N; the step list keeps every one", () => {
    const item = activity([step("error"), step("error"), step("error"), step("error"), step("error", "Ran cat x")]);
    expect(item.rows.map((r) => [r.verb, r.times ?? 1])).toEqual([["Failed: Ran ls build/output", 4], ["Failed: Ran cat x", 1]]);
    render(<ActivityGroup item={item} />);
    const summary = screen.getByRole("button", { name: "Show steps" });
    expect(summary.textContent).toContain("Failed: Ran ls build/output ×4");
    expect(summary.textContent!.match(/ls build\/output/g)).toHaveLength(1);
    fireEvent.click(summary);
    expect(document.querySelectorAll("ol.steps li")).toHaveLength(5);
  });

  it("a still-running group has no outcome yet", () => {
    expect(activity([step("error"), step("running")]).outcome).toBeUndefined();
  });
});

describe("a tray's request ID control", () => {
  it("is a labelled copy icon, not a bare '#'", () => {
    const tray: Tray = { id: "t", botId: "a", title: "Stopped: Piper kept failing at x", detail: null, requestId: "req_1", dedupeKey: null, count: 1, createdAt: 0, buttons: [] };
    useUi.setState({ trays: [tray] });
    render(<Trays botId="a" />);
    const b = screen.getByRole("button", { name: "Copy request ID" });
    expect(b.textContent).toBe("");
    expect(b.querySelector("svg")).not.toBeNull();
    expect(b.getAttribute("title")).toBe("Copy request ID");
  });
});
