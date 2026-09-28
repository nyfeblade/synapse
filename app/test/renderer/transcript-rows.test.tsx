// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary, EventEntry, TranscriptEntry } from "@synapse/shared";
import { Transcript } from "../../src/renderer/components/Transcript";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

const bot = (id: string, name: string, color: string): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false, lastBotMessageAt: 0,
  profile: { name, title: "", description: "", avatarShape: "pebble", avatarColor: color, avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
});
const ev = (id: string, event: EventEntry["event"]): TranscriptEntry => ({ kind: "event", id, createdAt: 1, event });
const show = (entries: TranscriptEntry[]) => {
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { p: bot("p", "Planner", "#f19d38"), s: bot("s", "Scout", "#111111"), l: bot("l", "Ledger", "#ce3d86"), g: { ...bot("g", "Planner, Scout & Ledger", "#777777"), group: { memberIds: ["p", "s", "l"] } } }, transcripts: { g: entries } });
  render(<Transcript botId="g" />);
};
// Rows are flex containers of separate spans (as on the boards), so compare text with whitespace removed.
const squash = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, "");
const rowText = (text: string) => screen.getByText((_c, el) => el?.classList.contains("event-row") === true && squash(el.textContent) === squash(text));

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

describe("Transcript rows (Group.dc.html, Approval.dc.html)", () => {
  it("renders the kept pass row with its muted suffix (GRP-13, C1)", () => {
    show([ev("t1a1", { type: "member-pass", botIds: ["l"], roomTurnId: "rt" }), ev("t2a1", { type: "member-pass", botIds: ["s", "l"], roomTurnId: "rt2" })]);
    expect(rowText("Ledger passed · nothing new to add")).toBeTruthy();
    expect(rowText("Scout and Ledger passed · nothing new to add")).toBeTruthy();
    expect(screen.getAllByText("· nothing new to add")[0]!.className).toBe("muted-2");
  });

  it("renders wake-origin rows (CHAT-23)", () => {
    show([
      ev("t1a1", { type: "wake-origin", source: "agent", botIds: ["s"] }),
      ev("t2a1", { type: "wake-origin", source: "agent", botIds: ["s", "l"] }),
      ev("t3a1", { type: "wake-origin", source: "routine", routineId: "r", routineName: "Morning inbox sweep" }),
      ev("t4a1", { type: "wake-origin", source: "revival", taskId: "x", taskTitle: "Research" }),
      ev("t5a1", { type: "wake-origin", source: "followup" }),
    ]);
    expect(rowText("Message from Scout")).toBeTruthy();
    expect(rowText("Messages from 2 Bots")).toBeTruthy();
    expect(rowText("Routine · Morning inbox sweep")).toBeTruthy();
    expect(rowText("Background task finished · Research")).toBeTruthy();
    expect(rowText("Follow-up")).toBeTruthy();
  });

  it("renders routine event rows with counts (CHAT-03)", () => {
    show([
      ev("t1a1", { type: "routine-created", routineId: "r", name: "Morning Briefing", nextRunAt: null }),
      ev("t2a1", { type: "routine-disabled", routineId: "r", name: "x", count: 3 }),
      ev("t3a1", { type: "routine-deleted", routineId: "r", name: "x", count: 6 }),
    ]);
    expect(rowText("Created Routine · Morning Briefing")).toBeTruthy();
    expect(rowText("Disabled ⏱ 3 routines")).toBeTruthy();
    expect(rowText("Deleted ⏱ 6 routines")).toBeTruthy();
  });

  it("renders member posts with name and avatar, and side exchanges that expand (GRP-14)", () => {
    const copy = (id: string, from: string, fromName: string, to: string, toName: string, content: string): TranscriptEntry => ({ kind: "message", id, role: "assistant", content, chainId: "c", createdAt: 3, fromAgent: { id: from, name: fromName, kind: "request" }, toAgent: { id: to, name: toName, kind: "request" } });
    show([
      { kind: "send-message", id: "t1s1", requestId: "r", createdAt: 2, message: { type: "text", content: "Oct 24–25 is open." }, author: { id: "p", name: "Planner" } },
      copy("t2a1", "p", "Planner", "s", "Scout", "Find cabins"), copy("t3a1", "s", "Scout", "p", "Planner", "3 found"),
      copy("t4a1", "p", "Planner", "s", "Scout", "Pick one"), copy("t5a1", "s", "Scout", "p", "Planner", "Cabin at $142"),
    ]);
    expect(screen.getByText("Planner", { selector: ".member-name" })).toBeTruthy();
    const row = screen.getByRole("button", { name: /4 messages with/ });
    expect(squash(row.textContent)).toBe(squash("4 messages with 2 Bots"));
    fireEvent.click(row);
    expect(screen.getByText("Cabin at $142")).toBeTruthy();
    const openBot = vi.fn();
    useUi.setState({ openBot });
    fireEvent.click(screen.getAllByRole("button", { name: "Scout" })[0]!);
    expect(openBot).toHaveBeenCalledWith("s");
  });

  it("renders a fan-out as 'Messaged N Bots' (B2B-02)", () => {
    const o = (id: string, to: string, name: string): TranscriptEntry => ({ kind: "message", id, role: "assistant", content: "hold Oct 24", chainId: "c", createdAt: 3, toAgent: { id: to, name, kind: "request" } });
    show([o("t1a1", "p", "Planner"), o("t2a1", "s", "Scout"), o("t3a1", "l", "Ledger")]);
    expect(squash(screen.getByRole("button", { name: /Messaged/ }).textContent)).toBe(squash("Messaged 3 Bots"));
  });
});
