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
      for (const u of ["synapse://settings/usage/weekly-budget", "bots://bot/b1/settings/model", "https://example.com", "botsy://x"]) a.handlers["open-url"]!({ preventDefault: () => {} }, u);
      expect(emitted).toEqual([
        { ch: "deep-link", p: { url: "synapse://settings/usage/weekly-budget" } },
        { ch: "deep-link", p: { url: "bots://bot/b1/settings/model" } },
      ]);
    } finally { vi.useRealTimers(); }
  });
});
