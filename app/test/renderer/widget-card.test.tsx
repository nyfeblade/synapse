// @vitest-environment jsdom
// task-6-brief.md's own Test: file (Create/Test list, task-6-brief.md:6-8). Phase 2 already shipped
// WidgetCard.tsx/Cards.tsx for CHAT-16/17 (see the Task 6 widget-shape ruling in
// implementer-rules.md and task-6-report.md's Fix round 1/2), so this exercises the brief's
// verbatim scenarios against that real component instead of recreating the file. Two schema
// adaptations from the brief's sample, both already established in the original report: `status`
// and `respondedValue` live on `SendMessageEntry` itself, not nested under `message`
// (shared/src/transcript.ts), and assertions use plain DOM checks (`.disabled`,
// `getAttribute("aria-pressed")`) instead of jest-dom matchers (`toBeDisabled`,
// `toHaveAttribute`), which this repo does not have installed (no `@testing-library/jest-dom`
// dependency, no matchers used anywhere else under app/test).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { WidgetCard } from "../../src/renderer/components/WidgetCard";
import { buildTranscriptItems } from "../../src/renderer/transcript-items";
import { installFakeBridge } from "./fake-bridge";

const entry = (status: "pending" | "answered" | "skipped", respondedValue?: string): SendMessageEntry => ({
  kind: "send-message", id: "t3s1", requestId: "req_1", createdAt: 1, status,
  ...(respondedValue !== undefined ? { respondedValue } : {}),
  message: { type: "widget", widget: { question: "Which trip?", options: [{ label: "Hudson", value: "hudson" }, { label: "Beacon", value: "beacon", style: "primary" }] } },
});

describe("WidgetCard (CHAT-16/17, task-6-brief.md)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => { bridge = installFakeBridge(); });
  afterEach(cleanup);

  it("answers with the option's value", () => {
    render(<WidgetCard botId="b1" entry={entry("pending")} />);
    fireEvent.click(screen.getByRole("button", { name: "Beacon" }));
    expect(bridge.calls.at(-1)).toEqual(["respondToWidget", { id: "b1", entryId: "t3s1", value: "beacon" }]);
  });

  it("shows the chosen answer and disables the options once answered", () => {
    render(<WidgetCard botId="b1" entry={entry("answered", "hudson")} />);
    expect(screen.getByRole("button", { name: "Hudson" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Beacon" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is a group named by its question, as task-6-brief.md's sample and the Phase 4 E2E address it (Task 48)", () => {
    render(<WidgetCard botId="b1" entry={entry("pending")} />);
    fireEvent.click(within(screen.getByRole("group", { name: "Which trip?" })).getByRole("button", { name: "Beacon" }));
    expect(bridge.calls.at(-1)).toEqual(["respondToWidget", { id: "b1", entryId: "t3s1", value: "beacon" }]);
  });

  it("is a transcript item of its own", () => {
    expect(buildTranscriptItems([entry("pending")], 2).filter((i) => i.kind === "widget")).toHaveLength(1);
  });
});
