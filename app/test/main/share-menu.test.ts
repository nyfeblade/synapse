// Bot sharing: the two natives behind the Share sheet's Share… and onboarding's Paste a Bot link.
import { describe, expect, it, vi } from "vitest";
import { encodeShare } from "@synapse/shared";

const handlers = new Map<string, (a: unknown) => unknown>();
const popups: unknown[] = [];
vi.mock("electron", () => ({
  clipboard: { readText: () => "" },
  ShareMenu: class { constructor(readonly o: unknown) {} popup(p: unknown) { popups.push({ o: this.o, p }); } },
}));
vi.mock("../../src/main/native", () => ({ registerNative: (n: string, fn: (a: unknown) => unknown) => handlers.set(n, fn) }));

const { isShareLink, registerClipboardBotLink, registerShareMenu } = await import("../../src/main/native/share-menu");
const SITE = "https://synapse-site-virid.vercel.app";

describe("shareMenu", () => {
  it("only takes a Bot link on the Synapse site", () => {
    expect(isShareLink(`${SITE}/bot#b1.abc`)).toBe(true);
    for (const bad of ["https://evil.example/bot#b1.abc", `${SITE}/docs`, `${SITE}/bot#b1.a b`, 42, "file:///etc/passwd"]) expect(isShareLink(bad)).toBe(false);
  });

  it("pops the Mac's share menu for the window; FUZZ records instead", () => {
    registerShareMenu(() => null, { fuzz: false });
    handlers.get("shareMenu")!({ url: `${SITE}/bot#b1.abc` });
    expect(popups).toEqual([{ o: { urls: [`${SITE}/bot#b1.abc`] }, p: {} }]);
    expect(() => handlers.get("shareMenu")!({ url: "https://evil.example/" })).toThrow();
    registerShareMenu(() => null, { fuzz: true });
    handlers.get("shareMenu")!({ url: `${SITE}/bot#b1.x` });
    expect((globalThis as unknown as { __shareMenuCalls: unknown[] }).__shareMenuCalls).toEqual([{ url: `${SITE}/bot#b1.x` }]);
    expect(popups).toHaveLength(1);
  });
});

describe("clipboard.botLink", () => {
  it("returns only a Bot link's fragment, never the rest of the clipboard", async () => {
    let text = "";
    registerClipboardBotLink(() => text);
    const read = () => handlers.get("clipboard.botLink")!({}) as Promise<unknown>;
    const good = await encodeShare({ v: 1, name: "Scout", shape: "orb", color: "#3674d8" });
    // Security review: only a link that decodes to a valid Bot comes back.
    for (const [t, want] of [[`${SITE}/bot#${good}`, good], [`synapse://import#${good}`, good], [`${SITE}/bot#b1.abc`, null], ["b1.notabot", null], ["my bank password 1234", null], ["", null], ["b1." + "A".repeat(40_000), null]] as const) {
      text = t;
      expect(await read()).toEqual({ fragment: want });
    }
  });
});
