import { describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ created: [] as { o: unknown; handlers: Record<string, () => void> }[] }));
vi.mock("electron", () => ({
  Notification: class {
    static isSupported() { return true; }
    handlers: Record<string, () => void> = {};
    constructor(public o: unknown) { h.created.push(this); }
    on(ev: string, f: () => void) { this.handlers[ev] = f; }
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
  it("sets and clears the dock badge", () => {
    const dock = { setBadge: vi.fn() };
    setDockBadge(3, dock);
    setDockBadge(0, dock);
    expect(dock.setBadge.mock.calls).toEqual([["3"], [""]]);
  });
});
