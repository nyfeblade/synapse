// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotSummary } from "@synapse/shared";
import { ChatView } from "../../src/renderer/components/ChatView";
import { NewChat } from "../../src/renderer/components/NewChat";
import { Sidebar } from "../../src/renderer/components/Sidebar";
import { initialState } from "../../src/renderer/reducer";
import { useUi } from "../../src/renderer/store";

const bot = (id: string, name: string, over: Partial<BotSummary> = {}): BotSummary => ({
  id, updatedAt: 1, createdAt: 0, running: false, presence: "idle", activity: null, marker: null, statusLine: "", awaiting: null, group: null, archived: false,
  profile: { name, title: "", description: "", avatarShape: "pebble", avatarColor: "#f19d38", avatarKind: "shape" },
  settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false }, lastBotMessageAt: 0, ...over,
});
const calls: [string, unknown][] = [];
let reply: (cmd: string, args: unknown) => unknown = () => ({});

beforeEach(() => {
  calls.length = 0;
  reply = (cmd) => (cmd === "createGroup" ? { id: "g2", reused: false } : cmd === "getAgentTranscriptTail" ? { entries: [] } : cmd === "openAgent" ? { agent: bot("g2", "Planner & Scout", { group: { memberIds: ["p", "s"] } }) } : {});
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); try { return { ok: true, result: reply(cmd, args) }; } catch (e) { return { ok: false, error: { code: "X", message: (e as Error).message } }; } }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    // Phase 5 (CHAT-08): Composer's dictation subscribes to window.synapse.native on mount.
    native: { invoke: vi.fn(async () => ({ ok: true, result: {} })), on: () => () => {} },
  };
  Element.prototype.scrollIntoView = vi.fn();
  useUi.setState({
    ...initialState(), connection: { kind: "connected" },
    bots: {
      p: bot("p", "Planner", { updatedAt: 5 }), s: bot("s", "Scout", { updatedAt: 4 }), l: bot("l", "Ledger", { updatedAt: 3 }), c: bot("c", "Courier", { updatedAt: 2 }),
      g: bot("g", "Planner, Scout & Ledger", { updatedAt: 9, statusLine: "Planner: Blocked Oct 24–25…", group: { memberIds: ["p", "s", "l"] } }),
    },
    transcripts: { g: [] },
  });
});
afterEach(cleanup);

describe("group shell (Group.dc.html)", () => {
  it("shows the group row with stacked avatars and the sender preview (G1)", () => {
    render(<Sidebar />);
    const row = screen.getByText("Planner, Scout & Ledger").closest("a")!;
    expect(within(row).getByText("Planner: Blocked Oct 24–25…")).toBeTruthy();
    expect(row.querySelectorAll(".group-stack svg")).toHaveLength(3);
  });

  it("creates a group from New chat with ⌘2 and 2–6 picks (N3, GRP-01)", async () => {
    useUi.setState({ view: { kind: "new-chat" } });
    render(<NewChat />);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    const create = screen.getByRole("button", { name: "Create group" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: /Planner/ }));
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: /Scout/ }));
    expect(screen.queryByRole("option", { name: /Planner, Scout & Ledger/ })).toBeNull(); // groups can't be members
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await vi.waitFor(() => expect(calls.filter((c) => c[0] !== "listStarterTemplates")[0]).toEqual(["createGroup", { memberIds: ["p", "s"] }]));
    await vi.waitFor(() => expect(useUi.getState().view).toEqual({ kind: "chat", botId: "g2" }));
  });

  it("renders the group header, composer placeholder and Members panel (G2, G9, G10)", async () => {
    useUi.setState({ view: { kind: "chat", botId: "g" }, panel: "details" });
    render(<ChatView botId="g" />);
    const title = screen.getByRole("button", { name: "View conversation details" });
    expect(title.querySelectorAll(".group-stack svg")).toHaveLength(3);
    expect(screen.getByPlaceholderText("Message Planner, Scout & Ledger")).toBeTruthy();
    const panel = screen.getByRole("complementary", { name: "Conversation details" });
    expect(within(panel).getByText("Members")).toBeTruthy();
    expect(within(panel).getAllByRole("link").map((a) => a.textContent)).toEqual(["Planner", "Scout", "Ledger"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Add Member" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Courier" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setGroupMembers", { id: "g", memberIds: ["p", "s", "l", "c"] }]));
  });

  it("surfaces a host rejection from the Add Member menu instead of failing silently (GRP-02)", async () => {
    reply = (cmd) => {
      if (cmd === "setGroupMembers") throw new Error("A group needs 2 to 6 Bots.");
      return cmd === "getAgentTranscriptTail" ? { entries: [] } : {};
    };
    useUi.setState({ view: { kind: "chat", botId: "g" }, panel: "details" });
    render(<><Sidebar /><ChatView botId="g" /></>);
    const panel = screen.getByRole("complementary", { name: "Conversation details" });
    fireEvent.click(within(panel).getByRole("button", { name: "Add Member" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Courier" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["setGroupMembers", { id: "g", memberIds: ["p", "s", "l", "c"] }]));
    expect(await screen.findByText("A group needs 2 to 6 Bots.")).toBeTruthy();
  });

  it("edits name and members in the group settings sheet and shows host errors (GRP-02)", async () => {
    reply = (cmd) => {
      if (cmd === "setGroupMembers") throw new Error("A group needs 2 to 6 Bots.");
      return cmd === "updateAgent" ? { agent: bot("g", "Trip crew", { group: { memberIds: ["p", "s", "l"] } }) } : {};
    };
    useUi.setState({ view: { kind: "chat", botId: "g" }, panel: "details" });
    render(<ChatView botId="g" />);
    // Scoped to the panel: the header now carries its own gear labelled "Group settings" too
    // (bug 192), so an unscoped query is ambiguous once both are on screen.
    const panelBeforeSheet = screen.getByRole("complementary", { name: "Conversation details" });
    fireEvent.click(within(panelBeforeSheet).getByRole("button", { name: "Group settings" }));
    const sheet = screen.getByRole("dialog", { name: "Group settings" });
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Trip crew" } });
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Scout" }));
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Ledger" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["updateAgent", { id: "g", name: "Trip crew" }]));
    expect(calls).toContainEqual(["setGroupMembers", { id: "g", memberIds: ["p"] }]);
    expect(await within(sheet).findByText("A group needs 2 to 6 Bots.")).toBeTruthy();
  });

  // Bug 192: the header's settings gear, on a group chat, targets the group — DetailsPanel already
  // routes any non-"closed" panel value to GroupPanel for a `bot.group` (see DetailsPanel.tsx), so
  // opening the column at all is opening "that group's settings" the way GroupPanel does today.
  describe("the header's settings gear on a group", () => {
    it("is labelled Group settings, closed by default", () => {
      useUi.setState({ view: { kind: "chat", botId: "g" }, panel: "closed" });
      render(<ChatView botId="g" />);
      const gear = screen.getByRole("button", { name: "Group settings" });
      expect(gear.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("button", { name: "Bot settings" })).toBeNull();
    });

    it("opens the Members panel on click", () => {
      useUi.setState({ view: { kind: "chat", botId: "g" }, panel: "closed" });
      render(<ChatView botId="g" />);
      fireEvent.click(screen.getByRole("button", { name: "Group settings" }));
      expect(useUi.getState().panel).not.toBe("closed");
      expect(screen.getByRole("complementary", { name: "Conversation details" })).toBeTruthy();
    });

    it("closes it on a second click, however the panel got there", () => {
      // panel: "details" also renders GroupPanel, which carries its own "Group settings" gear (the
      // one that opens the deeper edit sheet) — scoped to the header so the two don't collide.
      useUi.setState({ view: { kind: "chat", botId: "g" }, panel: "details" });
      const { container } = render(<ChatView botId="g" />);
      const gear = within(container.querySelector(".chat-header")!).getByRole("button", { name: "Group settings" });
      expect(gear.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(gear);
      expect(useUi.getState().panel).toBe("closed");
    });
  });
});
