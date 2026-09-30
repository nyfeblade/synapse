import { describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ created: [] as { o: unknown; handlers: Record<string, (...a: unknown[]) => void> }[] }));
vi.mock("electron", () => ({
  Notification: class {
    static isSupported() { return true; }
    handlers: Record<string, (...a: unknown[]) => void> = {};
    constructor(public o: unknown) { h.created.push(this); }
    on(ev: string, f: (...a: unknown[]) => void) { this.handlers[ev] = f; }
    show() {}
  },
  app: { dock: { setBadge: () => {} } },
}));
import { setDockBadge, showAppNotification, showBotNotification } from "../../src/main/notify";

describe("main notifications (NTF-02, BOT-23)", () => {
  it("shows a notification whose click focuses the window and opens the Bot", () => {
    const win = { show: vi.fn(), focus: vi.fn(), isMinimized: () => false, restore: vi.fn(), webContents: { send: vi.fn() } };
    showBotNotification(win as never, { botId: "b1", title: "Courier", body: "Sent all 5." });
    expect(h.created[0]!.o).toMatchObject({ title: "Courier", body: "Sent all 5.", silent: true });
    h.created[0]!.handlers.click!();
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith("open-bot", "b1");
  });
  it("bug-log 128: an app-level notice is silent and a click brings the window forward", () => {
    const win = { show: vi.fn(), focus: vi.fn(), isMinimized: () => true, restore: vi.fn(), webContents: { send: vi.fn() } };
    showAppNotification(win as never, { title: "Your Mac is almost out of space", body: "x" });
    const n = h.created.at(-1)!;
    expect(n.o).toMatchObject({ title: "Your Mac is almost out of space", body: "x", silent: true });
    n.handlers.click!();
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
  it("smarter approvals: a card's notification has Approve and Deny, answered with the card's id", () => {
    const win = { show: vi.fn(), focus: vi.fn(), isMinimized: () => false, restore: vi.fn(), webContents: { send: vi.fn() } };
    const answer = vi.fn();
    showBotNotification(win as never, { botId: "b1", title: "Courier needs you", body: "Approval needed", approvalId: "ap1" }, answer);
    const n = h.created.at(-1)!;
    expect(n.o).toMatchObject({ actions: [{ type: "button", text: "Approve" }, { type: "button", text: "Deny" }], silent: true });
    n.handlers.action!({}, 0);
    n.handlers.action!({}, 1);
    expect(answer.mock.calls).toEqual([[{ botId: "b1", approvalId: "ap1", choice: "once" }], [{ botId: "b1", approvalId: "ap1", choice: "deny" }]]);
    expect(win.focus).not.toHaveBeenCalled();
    // Any other notification has no actions.
    showBotNotification(win as never, { botId: "b1", title: "Courier", body: "Done." }, answer);
    expect((h.created.at(-1)!.o as { actions?: unknown }).actions).toBeUndefined();
  });
  it("sets and clears the dock badge", () => {
    const dock = { setBadge: vi.fn() };
    setDockBadge(3, dock);
    setDockBadge(0, dock);
    expect(dock.setBadge.mock.calls).toEqual([["3"], [""]]);
  });
});
