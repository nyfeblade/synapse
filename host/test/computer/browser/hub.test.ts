import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BrowserHub } from "../../../computer/browser/hub";
import type { BrowserConnector, CdpBrowser, CdpPage } from "../../../computer/browser/connector";
import type { DisplayManager } from "../../../computer/displays";

let seq = 0;
function fakePage(url = "about:blank"): CdpPage & { _url: string; _closed: boolean } {
  const p = {
    targetId: `T${++seq}`, _url: url, _closed: false,
    url: () => p._url, title: async () => "t", goto: async (u: string) => { p._url = u; },
    send: (async () => ({})) as CdpPage["send"], closed: () => p._closed, bringToFront: async () => {}, screenshotWebp: async () => Buffer.from("x"),
    evaluate: async () => undefined as never, close: async () => { p._closed = true; },
    mouse: { click: async () => {}, move: async () => {}, down: async () => {}, up: async () => {}, wheel: async () => {} },
    keyboard: { type: async () => {}, press: async () => {}, insertText: async () => {} },
  };
  return p as CdpPage & { _url: string; _closed: boolean };
}
function fakeBrowser() {
  const pages: ReturnType<typeof fakePage>[] = [fakePage()];
  const b: CdpBrowser = {
    pages: async () => pages.filter((p) => !p._closed), newPage: async () => { const p = fakePage(); pages.push(p); return p; },
    targets: async () => pages.filter((p) => !p._closed).map((p) => ({ targetId: p.targetId, type: "page", url: p._url })),
    browserSend: (async () => ({})) as CdpBrowser["browserSend"], connected: () => true, close: async () => {},
  };
  return { b, pages };
}

function setup() {
  const fb = fakeBrowser();
  const connects: number[] = [];
  const connector: BrowserConnector = { connect: async (port) => { connects.push(port); return fb.b; } };
  let gen = 1;
  const displays = {
    ensure: async () => ({ botId: "b", index: 3, display: ":3", cdpPort: 9225, running: true, generation: gen }),
    info: () => ({ botId: "b", index: 3, display: ":3", cdpPort: 9225, running: true, generation: gen }),
    touch: () => {}, generation: () => gen,
  } as unknown as DisplayManager;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-"));
  const hub = new BrowserHub({ displays, connector, stateDir });
  return { hub, fb, connects, stateDir, bumpGen: () => { gen += 1; } };
}

describe("BrowserHub (BRW-06)", () => {
  it("gives each view its own tab, persists it in views-<display>.json, and reuses the connection", async () => {
    const s = setup();
    const a = await s.hub.tab("b", "session-A");
    const again = await s.hub.tab("b", "session-A");
    const other = await s.hub.tab("b", "session-B");
    expect(again.page.targetId).toBe(a.page.targetId);
    expect(other.page.targetId).not.toBe(a.page.targetId);
    expect(s.connects).toEqual([9225]);
    const state = JSON.parse(fs.readFileSync(path.join(s.stateDir, "views-3.json"), "utf8"));
    expect(Object.keys(state.views)).toEqual(["session-A", "session-B"]);
  });

  it("re-adopts a discarded tab by its last URL", async () => {
    const s = setup();
    const t = await s.hub.tab("b", "v");
    await t.page.goto("https://example.com/a", { timeoutMs: 1 });
    await s.hub.remember(t);
    (t.page as ReturnType<typeof fakePage>)._closed = true; // Chromium discarded the tab
    const t2 = await s.hub.tab("b", "v");
    expect(t2.page.targetId).not.toBe(t.page.targetId);
    expect(t2.page.url()).toBe("https://example.com/a");
  });

  it("identity changes with a page URL and with the window generation (APR-07)", async () => {
    const s = setup();
    const t = await s.hub.tab("b", "v");
    const id1 = await s.hub.identity("b");
    await t.page.goto("https://example.com/b", { timeoutMs: 1 });
    const id2 = await s.hub.identity("b");
    s.bumpGen();
    const id3 = await s.hub.identity("b");
    expect(new Set([id1, id2, id3]).size).toBe(3);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("propagates a failed re-adopt navigation instead of silently leaving about:blank", async () => {
    const s = setup();
    const t = await s.hub.tab("b", "v");
    await t.page.goto("https://example.com/a", { timeoutMs: 1 });
    await s.hub.remember(t);
    (t.page as ReturnType<typeof fakePage>)._closed = true; // Chromium discarded the tab
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const realNewPage = s.fb.b.newPage;
    s.fb.b.newPage = async () => {
      const p = await realNewPage();
      p.goto = async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); };
      return p;
    };
    const t2 = await s.hub.tab("b", "v");
    expect(t2.navigateError).toContain("ERR_NAME_NOT_RESOLVED");
    expect(t2.page.url()).toBe("about:blank");
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("stores refs per view", () => {
    const s = setup();
    s.hub.setRefs("v", new Map([["e1", 10]]));
    expect(s.hub.ref("v", "e1")).toBe(10);
    expect(s.hub.ref("v", "e9")).toBeNull();
  });
});
