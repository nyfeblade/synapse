import { describe, expect, it } from "vitest";
import { CookieSync, type Cookie } from "../../../computer/browser/cookie-sync";
import type { BrowserConnector, CdpBrowser } from "../../../computer/browser/connector";
import type { DisplayManager } from "../../../computer/displays";

function jar() {
  let cookies: Cookie[] = [];
  const b = {
    browserSend: async (m: string, p?: { cookies?: Cookie[] | { name: string; domain: string; path: string }[] }) => {
      if (m === "Storage.getCookies") return { cookies };
      // Like real Chromium (T29 box finding): setting an already-expired cookie deletes it; the Storage domain has no deleteCookies.
      if (m === "Storage.setCookies") { for (const c of p!.cookies! as Cookie[]) cookies = [...cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path)), ...(c.expires > 0 && c.expires * 1000 < Date.now() ? [] : [c])]; return {}; }
      if (m === "Storage.getCookies" || m === "Storage.clearCookies") return {};
      throw new Error(`Protocol error (${m}): '${m}' wasn't found`);
    },
    connected: () => true,
  } as unknown as CdpBrowser;
  return { b, get: () => cookies, set: (c: Cookie[]) => { cookies = c; } };
}
const ck = (name: string, value: string): Cookie => ({ name, value, domain: ".example.com", path: "/", expires: 2e9, secure: true, httpOnly: true });

describe("CookieSync (SEC-09)", () => {
  it("seeds a new screen from the primary, then propagates a login made on one screen to the primary and every other screen", async () => {
    const primary = jar(); const s2 = jar(); const s3 = jar();
    primary.set([ck("sid", "old")]);
    const byPort: Record<number, CdpBrowser> = { 9223: primary.b, 9224: s2.b, 9225: s3.b };
    const connector: BrowserConnector = { connect: async (port) => byPort[port]! };
    const displays = { list: () => [{ index: 2, running: true }, { index: 3, running: true }] } as unknown as DisplayManager;
    const sync = new CookieSync({ connector, displays });
    await sync.seed(2);
    await sync.seed(3);
    expect(s2.get()).toEqual([ck("sid", "old")]);
    await sync.sync(); // baseline, nothing changed
    s2.set([ck("sid", "new"), ck("pref", "1")]); // the user logged in on screen 2
    const r = await sync.sync();
    expect(r.pushed).toBeGreaterThan(0);
    expect(primary.get().find((c) => c.name === "sid")?.value).toBe("new");
    expect(s3.get().map((c) => `${c.name}=${c.value}`).sort()).toEqual(["pref=1", "sid=new"]);
  });

  it("propagates a logout (cookie removed on one screen) to the primary and every other screen", async () => {
    const primary = jar(); const s2 = jar(); const s3 = jar();
    primary.set([ck("sid", "old"), ck("pref", "1")]);
    const byPort: Record<number, CdpBrowser> = { 9223: primary.b, 9224: s2.b, 9225: s3.b };
    const connector: BrowserConnector = { connect: async (port) => byPort[port]! };
    const displays = { list: () => [{ index: 2, running: true }, { index: 3, running: true }] } as unknown as DisplayManager;
    const sync = new CookieSync({ connector, displays });
    await sync.seed(2);
    await sync.seed(3);
    await sync.sync(); // baseline, nothing changed
    s2.set([ck("pref", "1")]); // the user logged out on screen 2 (sid cookie disappeared)
    await sync.sync();
    expect(primary.get().find((c) => c.name === "sid")).toBeUndefined();
    expect(s3.get().find((c) => c.name === "sid")).toBeUndefined();
    expect(primary.get().find((c) => c.name === "pref")).toBeDefined();
    expect(s3.get().find((c) => c.name === "pref")).toBeDefined();
  });
});
