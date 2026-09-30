// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { NewChat } from "../../src/renderer/components/NewChat";
import { ShapeAvatar } from "../../src/renderer/components/ShapeAvatar";
import { formPath } from "../../src/renderer/avatar/face-forms";
import { EYE_INK } from "../../src/renderer/avatar/face-sim";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

const bot = (id: string, name: string, over: Partial<BotSummary> = {}): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null,
  profile: { name, title: "", description: "", avatarShape: "gem", avatarColor: "#49a393", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});

const calls: [string, unknown][] = [];
beforeEach(() => {
  calls.length = 0;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return { ok: true, result: cmd === "createAgent" ? { id: "new" } : cmd === "getAgentTranscriptTail" ? { entries: [] } : cmd === "openAgent" ? { agent: bot("a", "Planner") } : {} }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "alex" }),
  };
  useUi.setState({ ...initialState(), connection: { kind: "connected" }, userName: "alex" });
});
afterEach(cleanup);

describe("ShapeAvatar (BOT-17)", () => {
  // The stored id `octagon` is the editor's sixth form: the gem.
  it("draws the generated gem body for `octagon`, with two solid black eyes and a black mouth", () => {
    const { container } = render(<ShapeAvatar shape="gem" color="#49a393" size={36} />);
    expect(container.querySelector("svg")!.getAttribute("data-form")).toBe("gem");
    expect(container.querySelector(".avatar-body")?.getAttribute("d")).toBe(formPath("gem"));
    expect(container.querySelector("mask")).toBeNull();
    const eyes = container.querySelectorAll("rect.avatar-eye");
    expect(eyes).toHaveLength(2);
    eyes.forEach((e) => expect(e.getAttribute("fill")).toBe(EYE_INK));
    expect(container.querySelector("[data-part=mouth-line]")!.getAttribute("stroke")).toBe(EYE_INK);
  });
});

describe("Sidebar (S1–S9)", () => {
  it("lists Bots with status lines, pinned tiles with label chips, and the active row", () => {
    useUi.setState({
      bots: { a: bot("a", "Planner", { statusLine: "Approval needed: Delete 3 Friday events", marker: "blocked" }), b: bot("b", "Scout", { profile: { ...bot("b", "Scout").profile, title: "Research" } }) },
      pinned: ["b"], view: { kind: "chat", botId: "a" },
    });
    render(<Sidebar />);
    expect(screen.getByRole("group", { name: "Pinned Bots" }).textContent).toContain("Research");
    const row = screen.getByRole("link", { name: /Planner/ });
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.textContent).toContain("Approval needed: Delete 3 Friday events");
    expect(screen.getByLabelText("Needs attention")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open account menu" })).toBeTruthy();
  });

  it("opens the context menu with Pin and Delete", async () => {
    useUi.setState({ bots: { a: bot("a", "Planner") } });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Planner/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    expect(calls).toContainEqual(["setAgentPinned", { id: "a", pinned: true }]);
  });

  it("surfaces a visible error and doesn't crash when pinning fails", async () => {
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "setAgentPinned") return { ok: false, error: { code: "GATEWAY_ERROR", message: "Could not reach the computer" } };
      return { ok: true, result: {} };
    });
    useUi.setState({ bots: { a: bot("a", "Planner") } });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Planner/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
  });

  it("surfaces a visible error and doesn't crash when deleting fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    (window as unknown as { synapse: { call: unknown } }).synapse.call = vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "deleteAgent") return { ok: false, error: { code: "GATEWAY_ERROR", message: "Could not reach the computer" } };
      return { ok: true, result: {} };
    });
    useUi.setState({ bots: { a: bot("a", "Planner") } });
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Planner/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the computer");
    expect(screen.getByRole("link", { name: /Planner/ })).toBeTruthy();
  });
});

describe("Sidebar presence/marker dots live on the avatar (pinned tiles + rows)", () => {
  it("renders a Working marker on a pinned tile's avatar, with the presence class on the avatar itself", () => {
    useUi.setState({
      bots: { a: bot("a", "Planner", { presence: "working", marker: "working" }) },
      pinned: ["a"],
    });
    render(<Sidebar />);
    const tileGroup = screen.getByRole("group", { name: "Pinned Bots" });
    expect(within(tileGroup).getByLabelText("Working")).toBeTruthy();
    expect(tileGroup.querySelector(".presence-working")).toBeTruthy();
  });

  it("renders an Unread activity marker on a pinned tile", () => {
    useUi.setState({
      bots: { a: bot("a", "Planner", { marker: "unread" }) },
      pinned: ["a"],
    });
    render(<Sidebar />);
    const tileGroup = screen.getByRole("group", { name: "Pinned Bots" });
    expect(within(tileGroup).getByLabelText("Unread activity")).toBeTruthy();
  });

  it("still renders a row's marker as before (Needs attention)", () => {
    useUi.setState({ bots: { a: bot("a", "Planner", { marker: "blocked" }) } });
    render(<Sidebar />);
    expect(screen.getByLabelText("Needs attention")).toBeTruthy();
  });
});

// The sidebar derives its id list from sortedBotIds(bots) (reducer.ts), which reads each entry's own
// `.id` field rather than Object.keys(bots) — so every `bots[id]` lookup here relies on "every entry's
// `.id` equals the key it's stored under" holding. That invariant has already broken store-side twice
// (openBot/setGroupMembers keying by the caller's id instead of the response's — fixed in PR #24) and
// crashed NewChat when it did. The sidebar must not go down the same way: a mismatched or since-removed
// id should drop the row (or close the menu), never throw and take out the whole pane.
describe("Sidebar tolerates a bots map that disagrees with the sorted id list (unsafe-lookups fix)", () => {
  it("does not crash when sortedBotIds() returns an id that isn't a live key in the bots map", () => {
    // "realId" is the entry's own `.id`, but it's stored under the wrong key — exactly the shape the
    // fixed store bug used to produce, and the shape sortedBotIds() has no way to detect on its own.
    useUi.setState({ bots: { ghostKey: bot("realId", "Ghost") } });
    expect(() => render(<Sidebar />)).not.toThrow();
    expect(screen.queryByText("Ghost")).toBeNull();
  });

  it("closes the context menu instead of crashing if its Bot disappears while the menu is open", () => {
    useUi.setState({ bots: { a: bot("a", "Planner") } });
    const { rerender } = render(<Sidebar />);
    fireEvent.contextMenu(screen.getByRole("link", { name: /Planner/ }));
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeTruthy();
    // Simulates a real-time delete (from another window, or a host event) landing while the
    // context menu for that same Bot is still open.
    useUi.setState({ bots: {} });
    expect(() => rerender(<Sidebar />)).not.toThrow();
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
  });
});

describe("New chat (BOT-03, UI-04)", () => {
  it("offers Create new Bot, Create \"<name>\" Bot and recent Bots, and creates on ⌘1", async () => {
    useUi.setState({ bots: { a: bot("a", "Courier") }, view: { kind: "new-chat" } });
    render(<NewChat />);
    expect(screen.getByRole("option", { name: /Create new Bot/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("To:"), { target: { value: "Tutor" } });
    expect(screen.getByRole("option", { name: /Create "Tutor" Bot/ })).toBeTruthy();
    // New-user walk, finding 16: the typed name filters the Bots.
    expect(screen.queryByRole("option", { name: /Courier/ })).toBeNull();
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    await vi.waitFor(() => expect(calls.filter((c) => c[0] !== "listStarterTemplates")[0]).toEqual(["createAgent", { name: "Tutor", isKickstartRequested: true }]));
  });

  // Traceability N5 (gate §4): the New chat composer is "Message Bot" with Attach and the mic, and no voice-chat button (NewBot board).
  it("shows the New chat composer: Message Bot, Attach and mic (later phase, disabled), no voice chat", () => {
    useUi.setState({ bots: {}, view: { kind: "new-chat" } });
    render(<NewChat />);
    const input = screen.getByPlaceholderText("Message Bot") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Attach file" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Start voice input" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /voice chat|voice mode/i })).toBeNull();
  });
});

