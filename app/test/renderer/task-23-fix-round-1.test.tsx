// @vitest-environment jsdom
// Fix round 1, Task 23 finding 1 (task-23-brief.md:364-373 vs :410-435): EventRow's `agent-exchange`
// case and ExchangeBlock duplicated the same "expandable Bot-to-Bot message list" UI verbatim from two
// different data sources (host EventEntry vs. client-buffered TranscriptItem). Extracted into a shared
// ExchangeToggle/ExchangeMessageList pair both components call, which also closes the one real gap that
// duplication had let through: ExchangeBlock applied an "inbox" class per-<li> (ORIG-09 §09.3) that
// EventRow's copy silently omitted, since both operate on the same shared AgentMessageEntry[] shape.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessageEntry, BotSummary, EventEntry, TranscriptEntry } from "@synapse/shared";
import { EventRow } from "../../src/renderer/components/EventRow";
import { useUi } from "../../src/renderer/store";
import { initialState } from "../../src/renderer/reducer";
import { readSrc as read } from "./read-src";

const bot = (id: string, name: string, color: string): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false, lastBotMessageAt: 0,
  profile: { name, title: "", description: "", avatarShape: "pebble", avatarColor: color, avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
});

afterEach(cleanup);

describe("Fix round 1, Task 23 finding 1 — shared exchange UI extraction", () => {
  it("EventRow.tsx and ExchangeBlock.tsx both call a shared exchange component instead of duplicating the markup", () => {
    const eventRowSrc = read("components/EventRow.tsx");
    const exchangeBlockSrc = read("components/ExchangeBlock.tsx");
    // Both must import the same shared module and use it (not just import unused).
    const sharedImport = /from ["']\.\/(Exchange(?:Shared|Toggle|MessageList))["']/;
    const eventRowMatch = eventRowSrc.match(sharedImport);
    const exchangeBlockMatch = exchangeBlockSrc.match(sharedImport);
    expect(eventRowMatch).not.toBeNull();
    expect(exchangeBlockMatch).not.toBeNull();
    expect(eventRowMatch![1]).toBe(exchangeBlockMatch![1]);
    // Neither file should still contain its own literal "exchange-who" <li> markup (that now lives
    // only in the shared component).
    expect(eventRowSrc).not.toMatch(/<li key=\{m\.id\}/);
    expect(exchangeBlockSrc).not.toMatch(/<li key=\{m\.id\}/);
  });

  it("EventRow's agent-exchange list applies the 'inbox' class per-<li>, same as ExchangeBlock (closes the divergence)", () => {
    useUi.setState({ ...initialState(), connection: { kind: "connected" }, bots: { p: bot("p", "Planner", "#f19d38"), s: bot("s", "Scout", "#111111") } });
    const inboxMsg: AgentMessageEntry = { kind: "message", id: "t1a1", role: "assistant", content: "delivered without a wake", chainId: "c", createdAt: 3, fromAgent: { id: "s", name: "Scout", kind: "request" }, toAgent: { id: "p", name: "Planner", kind: "request" }, inbox: true };
    const entries: TranscriptEntry[] = [inboxMsg];
    const event: EventEntry = { kind: "event", id: "t2a1", createdAt: 4, event: { type: "agent-exchange", chainId: "c", botIds: ["s"], entryIds: ["t1a1"], count: 1 } };
    const { container } = render(<EventRow entry={event} entries={entries} />);
    fireEvent.click(screen.getByRole("button", { name: /message/i }));
    const li = container.querySelector(".exchange-list li")!;
    expect(li.textContent).toMatch(/delivered without a wake/);
    expect(li.classList.contains("inbox")).toBe(true);
  });
});
