// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STRL, type TranscriptEntry } from "@synapse/shared";
import { DetailsPanel } from "../../src/renderer/components/DetailsPanel";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";
import { botFixture, installFakeBridge } from "./fake-bridge";

// The Carbon look's right column: Now / Memory / Files on one bar, Bot settings and Close beside it.

const FACT = { id: "f1", date: "2026-09-14", tier: "profile", kind: "fact", content: "Sam prefers texts for scheduling", provenance: { botId: "a", botName: "Scout", recordedAt: Date.parse("2026-09-14T10:00:00Z"), source: "user", confidence: 1, chatBotId: null, messageId: null } };
const fileEntry = (id: string, name: string): TranscriptEntry => ({
  kind: "send-message", id, requestId: "r", createdAt: Date.parse("2026-09-20T09:41:00Z"),
  message: { type: "attachment", name, url: "file:///tmp/" + name, mime: "text/plain", size: 2048, pages: null, caption: null },
} as never);

describe("DetailsPanel: Now / Memory / Files", () => {
  beforeEach(() => {
    installFakeBridge({ getAgentMemories: { facts: [FACT], projects: [] }, listRoutines: { routines: [] } });
    useUi.setState({ ...initialState(), bots: { a: botFixture("a", "Scout") }, panel: "details", transcripts: { a: [fileEntry("e1", "q4-plan.docx")] } } as never);
  });
  afterEach(cleanup);

  it("Now shows the computer, the open run's plan and what is scheduled — and no memory at all", async () => {
    render(<DetailsPanel botId="a" />);
    expect(screen.getByRole("tab", { name: STRL.tabs.now }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("region", { name: "Computer" })).toBeTruthy();
    expect(screen.getByRole("region", { name: STRL.plan })).toBeTruthy();
    expect(screen.getByRole("region", { name: STRL.scheduled })).toBeTruthy();
    // The user's rule: the memory ledger does not sit in the column beside every conversation. It is
    // one click away on its own tab, and the fact's text never appears on Now.
    expect(screen.queryByRole("region", { name: STRL.remembers })).toBeNull();
    expect(screen.queryByText(/Sam prefers texts/)).toBeNull();
  });

  it("Plan lists the open run's steps with its progress, and says one short thing when nothing runs", () => {
    render(<DetailsPanel botId="a" />);
    // The seeded transcript holds no tool calls, so the card is a single faint line, not a blank box.
    expect(within(screen.getByRole("region", { name: STRL.plan })).getByText(STRL.planEmpty)).toBeTruthy();
    cleanup();
    useUi.setState({ transcripts: { a: [
      { kind: "tool-call", id: "t1", requestId: "r", segmentId: "s1", hidden: false, name: "Read", step: "Opened q3.xlsx", icon: "file", metric: null, status: "done", startedAt: 1000, endedAt: 43_000 },
      { kind: "tool-call", id: "t2", requestId: "r", segmentId: "s1", hidden: false, name: "Bash", step: "Ran the build", icon: "terminal", metric: null, status: "running", startedAt: 44_000 },
    ] as TranscriptEntry[] } });
    render(<DetailsPanel botId="a" />);
    const plan = screen.getByRole("region", { name: STRL.plan });
    expect(within(plan).getByText("Opened q3.xlsx")).toBeTruthy();
    expect(within(plan).getByText("0:42"), "a finished step shows how long it took").toBeTruthy();
    expect(within(plan).getByText(STRL.planNow), "the running step is the one happening now").toBeTruthy();
    expect(within(plan).getByText(STRL.planProgress(1, 2))).toBeTruthy();
    expect(within(plan).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
  });

  it("Files lists this conversation's files, newest first, and opens one in the transcript", () => {
    render(<DetailsPanel botId="a" />);
    fireEvent.click(screen.getByRole("tab", { name: STRL.tabs.files }));
    expect(useUi.getState().panel).toBe("files");
    const row = screen.getByRole("button", { name: /q4-plan\.docx/ });
    expect(row.textContent).toContain("2 KB");
    expect(screen.getByRole("tab", { name: STRL.tabs.files }).getAttribute("aria-selected")).toBe("true");
  });

  it("Memory opens the memory ledger, and the gear still reaches Bot settings from every tab", async () => {
    render(<DetailsPanel botId="a" />);
    fireEvent.click(screen.getByRole("tab", { name: STRL.tabs.memory }));
    expect(useUi.getState().panel).toBe("memory");
    fireEvent.click(screen.getByRole("button", { name: "Bot settings" }));
    expect(useUi.getState().panel).toBe("settings");
  });

  it("Close closes the column", () => {
    render(<DetailsPanel botId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(useUi.getState().panel).toBe("closed");
  });

  // Fix round 1 (docs/sdd, 2026-09-23; controller ruling): ChatView unmounts <DetailsPanel> outright
  // once `panel` flips to "closed" (its own gate is untouched — the box already snaps, motion-spec
  // §6.4). That unmount is what this test drives directly: a fading clone should appear in its place,
  // carrying none of the real panel's name or interactivity.
  describe("the exit clone (fix round 1)", () => {
    it("fades out instead of vanishing on unmount, stripped of its label and interactivity", () => {
      const { unmount } = render(<DetailsPanel botId="a" />);
      expect(screen.getByRole("tab", { name: STRL.tabs.now })).toBeTruthy();
      unmount();
      const ghost = document.querySelector(".panel.leaving");
      expect(ghost, "a fading clone was left behind").toBeTruthy();
      expect(ghost!.getAttribute("aria-label")).toBeNull();
      expect(ghost!.getAttribute("aria-hidden")).toBe("true");
      expect(ghost!.querySelectorAll("button:not(:disabled)")).toHaveLength(0);
    });

    it("removes itself once its exit animation ends", () => {
      const { unmount } = render(<DetailsPanel botId="a" />);
      unmount();
      const ghost = document.querySelector(".panel.leaving")!;
      fireEvent.animationEnd(ghost);
      expect(document.querySelector(".panel.leaving")).toBeNull();
    });
  });

  // Fix round 2 (docs/sdd, 2026-09-23; controller ruling): the clone kept every literal id its live
  // element carried — BotSettingsPanel's `#model-label`/`#effort-label`, RoutineDetail's
  // `#routine-when` — so a panel closing while a FRESH instance of the same view mounts right behind
  // it (switching Bots with Settings open is the real path) briefly put two elements with the SAME id
  // in the document. That breaks `getElementById` and any `aria-labelledby`/`<label for>` pointed at
  // it, silently: the DOM allows a duplicate id and only accessibility and querying ever notice.
  describe("the exit clone never duplicates a live id (fix round 2)", () => {
    it("Bot settings' #model-label and #effort-label stay unique while the old instance's clone fades", () => {
      useUi.setState({ panel: "settings" } as never);
      const { unmount } = render(<DetailsPanel botId="a" />);
      expect(document.querySelectorAll('[id="model-label"]')).toHaveLength(1);
      expect(document.querySelectorAll('[id="effort-label"]')).toHaveLength(1);
      unmount(); // starts the exit clone
      render(<DetailsPanel botId="a" />); // a fresh instance mounted right behind it (a Bot switch, in ChatView)
      expect(document.querySelectorAll('[id="model-label"]')).toHaveLength(1);
      expect(document.querySelectorAll('[id="effort-label"]')).toHaveLength(1);
    });
  });
});
