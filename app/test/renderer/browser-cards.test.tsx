// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PERMISSION_PREFIX, STRB, type BrowserSessionCardView, type LocalToolCardView } from "@synapse/shared";
import { BrowserSessionCard } from "../../src/renderer/components/cards/BrowserSessionCard";
import { LocalToolCard } from "../../src/renderer/components/cards/LocalToolCard";
import { BrowserRow } from "../../src/renderer/components/BrowserRow";

const calls: [string, unknown][] = [];
let allowed = false;
beforeEach(() => {
  calls.length = 0;
  allowed = false;
  (window as unknown as { synapse: unknown }).synapse = {
    call: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); if (cmd === "setLocalBrowserAllowed") allowed = (args as { allowed: boolean }).allowed; return { ok: true, result: cmd === "getLocalBrowserAllowed" || cmd === "setLocalBrowserAllowed" ? { allowed } : {} }; }),
    onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }),
    native: { invoke: vi.fn(async (n: string, a: unknown) => { calls.push([`native:${n}`, a]); return { ok: true, result: { shown: true } }; }), on: () => () => {} },
  };
});
afterEach(cleanup);

describe("the browser session card", () => {
  const card: BrowserSessionCardView = { kind: "browser-session", session: "w_1", title: "Veltria's capital explained", url: "https://valley.test/article/2", steps: 4, screenshots: 0, status: "active" };
  it("shows the page title, the steps taken and a Show window button", async () => {
    render(<BrowserSessionCard botId="b1" entryId="t1s1" card={card} />);
    const region = screen.getByRole("region", { name: `${STRB.cardTitle}: ${card.title}` });
    expect(region.textContent).toContain("Veltria's capital explained");
    expect(region.textContent).toContain(STRB.steps(4));
    expect(region.textContent).not.toContain("screenshot");
    fireEvent.click(screen.getByRole("button", { name: STRB.showWindow }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:browser.show", { botId: "b1" }]));
  });

  it("counts screenshots when there were any, and shows a paused/stopped status", () => {
    render(<BrowserSessionCard botId="b1" entryId="t1s1" card={{ ...card, screenshots: 2, status: "paused" }} />);
    expect(screen.getByRole("region").textContent).toContain(STRB.screenshots(2));
    expect(screen.getByRole("region").textContent).toContain(STRB.status.paused);
  });
});

describe("the Mac card for a browser action", () => {
  const base: LocalToolCardView = { kind: "local-tool-permission", askId: "k1", action: "browser", target: "browser click e7", description: STRB.consequential("Click “Pay now”", "shop.test"), status: "pending", createdAt: 1, expiresAt: 2 };
  it("shows the Mac's description (what and where), not a command, and has no Mac-wide Never", () => {
    render(<LocalToolCard botId="b1" entryId="t1s1" card={base} />);
    expect(screen.getByRole("region").textContent).toContain("Click “Pay now” on shop.test");
    expect(screen.queryByRole("button", { name: "Never" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
  });

  it("the first-use card asks for the browser permission; its Always sends the card's exact target", async () => {
    render(<LocalToolCard botId="b1" entryId="t1s1" card={{ ...base, target: `${BROWSER_PERMISSION_PREFIX}browser open "https://x.test"`, description: STRB.permissionAsk("Ava") }} />);
    expect(screen.getByRole("region").textContent).toContain(STRB.cardTitlePermission);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await vi.waitFor(() => expect(calls).toContainEqual(["resolveLocalToolPermission", { id: "b1", askId: "k1", choice: "always", action: "browser", target: `${BROWSER_PERMISSION_PREFIX}browser open "https://x.test"` }]));
  });
});

describe("Bot settings: May use the browser on your Mac", () => {
  it("is off by default and the switch records it on this Mac", async () => {
    render(<BrowserRow botId="b1" />);
    const sw = await screen.findByRole("switch", { name: STRB.setting });
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(sw);
    await vi.waitFor(() => expect(calls).toContainEqual(["setLocalBrowserAllowed", { id: "b1", allowed: true }]));
    await vi.waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
  });
});

describe("Sign in to sites (bug-log 150)", () => {
  it("the browser card opens the Synapse profile as plain Chrome, then Done hands it back to the Bots", async () => {
    let active = false;
    (window as unknown as { synapse: { native: { invoke: unknown } } }).synapse.native.invoke = vi.fn(async (n: string, a: { action?: string }) => {
      calls.push([`native:${n}`, a]);
      if (n === "browser.signin" && a.action === "start") active = true;
      if (n === "browser.signin" && a.action === "done") active = false;
      return { ok: true, result: n === "browser.signin" ? { active } : { shown: true } };
    });
    render(<BrowserSessionCard botId="b1" entryId="t1s1" card={{ kind: "browser-session", session: "w_1", title: "Sign in", url: "https://accounts.google.com/", steps: 1, screenshots: 0, status: "paused" }} />);
    fireEvent.click(await screen.findByRole("button", { name: STRB.signinButton }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:browser.signin", { action: "start" }]));
    fireEvent.click(await screen.findByRole("button", { name: STRB.signinDone }));
    await vi.waitFor(() => expect(calls).toContainEqual(["native:browser.signin", { action: "done" }]));
    expect(await screen.findByRole("button", { name: STRB.signinButton })).toBeTruthy();
  });
});
