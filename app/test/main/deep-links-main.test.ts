/**
 * Bug 286: the app registers synapse:// and, for one release, the old bots:// as an alias, so a link written before the
 * rename (a Bot's reply, a note, a bookmark) still opens the app. No real Electron: a stand-in app object.
 */
import { describe, expect, it, vi } from "vitest";

const emitted: { ch: string; p: unknown }[] = [];
vi.mock("../../src/main/native", () => ({ emitNative: (ch: string, p: unknown) => { emitted.push({ ch, p }); } }));

import { APP_SCHEMES, registerDeepLinks } from "../../src/main/native/deep-links";

function fakeApp() {
  const handlers: Record<string, (e: { preventDefault(): void }, url: string) => void> = {};
  const registered: string[] = [];
  return {
    registered, handlers,
    setAsDefaultProtocolClient: (s: string) => { registered.push(s); return true; },
    on: (ev: string, fn: (e: { preventDefault(): void }, url: string) => void) => { handlers[ev] = fn; },
  };
}

describe("the app's URL schemes", () => {
  it("are synapse:// first, then the bots:// alias", () => {
    expect(APP_SCHEMES).toEqual(["synapse", "bots"]);
  });

  it("registers both, and delivers a link in either; anything else is ignored", () => {
    vi.useFakeTimers();
    try {
      const a = fakeApp();
      registerDeepLinks(a as never, () => true);
      expect(a.registered).toEqual(["synapse", "bots"]);
      emitted.length = 0;
      for (const u of ["synapse://settings/usage/weekly-budget", "bots://bot/b1/settings/model", "https://example.com", "botsy://x"]) { a.handlers["open-url"]!({ preventDefault: () => {} }, u); vi.advanceTimersByTime(1100); }
      expect(emitted).toEqual([
        { ch: "deep-link", p: { url: "synapse://settings/usage/weekly-budget" } },
        { ch: "deep-link", p: { url: "bots://bot/b1/settings/model" } },
      ]);
    } finally { vi.useRealTimers(); }
  });
});

describe("Bot sharing: a share link brings the app forward and opens one sheet", () => {
  const withFocus = () => {
    const a = fakeApp() as ReturnType<typeof fakeApp> & { focus: ReturnType<typeof vi.fn> };
    a.focus = vi.fn();
    const win = { show: vi.fn(), restore: vi.fn(), isMinimized: () => true, isDestroyed: () => false };
    return { a, win };
  };

  it("shows and focuses the window (stealing focus from the browser)", () => {
    vi.useFakeTimers();
    try {
      const { a, win } = withFocus();
      registerDeepLinks(a as never, () => true, () => win as never);
      a.handlers["open-url"]!({ preventDefault: () => {} }, "synapse://import#b1.abc");
      expect(win.restore).toHaveBeenCalled();
      expect(win.show).toHaveBeenCalled();
      expect(a.focus).toHaveBeenCalledWith({ steal: true });
    } finally { vi.useRealTimers(); }
  });

  it("keeps one pending link before the window is ready, and drops a flood (1 s apart at most)", () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      const { a, win } = withFocus();
      registerDeepLinks(a as never, () => ready, () => win as never);
      emitted.length = 0;
      for (let i = 0; i < 20; i++) a.handlers["open-url"]!({ preventDefault: () => {} }, "synapse://import#b1.abc");
      a.handlers["open-url"]!({ preventDefault: () => {} }, "synapse://import#b1.dropped");
      vi.advanceTimersByTime(1100);
      a.handlers["open-url"]!({ preventDefault: () => {} }, "synapse://import#b1.newest");
      ready = true;
      vi.advanceTimersByTime(300);
      expect(emitted).toEqual([{ ch: "deep-link", p: { url: "synapse://import#b1.newest" } }]);
      emitted.length = 0;
      // Security review: links within 1 s of the last one are dropped, and the window comes forward at most once a second.
      vi.advanceTimersByTime(1100);
      win.show.mockClear();
      for (let i = 0; i < 20; i++) a.handlers["open-url"]!({ preventDefault: () => {} }, `synapse://import#b1.n${i}`);
      expect(emitted).toEqual([{ ch: "deep-link", p: { url: "synapse://import#b1.n0" } }]);
      expect(win.show).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1100);
      a.handlers["open-url"]!({ preventDefault: () => {} }, "synapse://import#b1.later");
      expect(emitted).toHaveLength(2);
      expect(win.show).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe("re-review lows: link rate limit", () => {
  it("every attempt restarts the 1 s window, and the window isn't brought forward while an import sheet is open", async () => {
    const { setImportSheetOpen } = await import("../../src/main/native/deep-links");
    vi.useFakeTimers();
    try {
      const a = fakeApp() as ReturnType<typeof fakeApp> & { focus: ReturnType<typeof vi.fn> };
      a.focus = vi.fn();
      const win = { show: vi.fn(), restore: vi.fn(), isMinimized: () => false, isDestroyed: () => false };
      registerDeepLinks(a as never, () => true, () => win as never);
      emitted.length = 0;
      const send = (u: string) => a.handlers["open-url"]!({ preventDefault: () => {} }, u);
      send("synapse://import#b1.a");
      for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(900); send(`synapse://import#b1.x${i}`); } // a steady stream, 0.9 s apart
      expect(emitted).toHaveLength(1);
      vi.advanceTimersByTime(1100);
      setImportSheetOpen(true);
      win.show.mockClear(); a.focus.mockClear();
      send("synapse://import#b1.b");
      expect(emitted).toHaveLength(2);
      expect(win.show).not.toHaveBeenCalled();
      expect(a.focus).not.toHaveBeenCalled();
      setImportSheetOpen(false);
    } finally { vi.useRealTimers(); }
  });
});
