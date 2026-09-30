import { describe, expect, it } from "vitest";
import { LIMITSC, STRC, SUBAGENT_TYPES, computerTitle, type GatewayCommands, type SendMessagePayload, type SseEvent } from "../src";

describe("Phase 3 contracts", () => {
  it("uses the product name in computer titles (D13) and keeps the spec's copy otherwise", () => {
    expect(computerTitle()).toBe("Bots' computer");
    expect(STRC.inUse).toBe("Bots' computer, in use");
    expect(STRC.boxHelpBadge).toBe("Action needed");
    expect(STRC.pausedUntilHandBack("Scout")).toBe("Scout is paused until you hand it back");
    expect(STRC.updateTitle).toBe("Update Bots' computer");
    expect(STRC.updateHelp).toBe("Brings the shared computer up to date for all your Bots at once. Files and sign-ins are kept; apps and packages you installed are removed.");
    expect(STRC.resetHelp).toBe("If the computer gets stuck, start it fresh. It's restored from your most recent snapshot, so the newest changes might not survive.");
    expect(STRC.secretFooter).toBe("Kept encrypted; your Bot never sees it");
    expect(STRC.secretPlaceholder("API key")).toBe("Paste your API key");
    expect(STRC.secretInText("STRIPE_KEY")).toBe("That text contains the value of secret STRIPE_KEY. Refer to it as $STRIPE_KEY instead.");
  });
  it("carries the spec §5 constants (maxScreens=3 per pre-flight ruling MAX_SCREENS=3, spike-measured MAX_SCREENS_RECOMMENDED on a 16GB box)", () => {
    expect(LIMITSC).toMatchObject({
      maxScreens: 3, firstDisplay: 2, displayWidth: 1280, displayHeight: 800, cdpBase: 9222, thenMax: 9, textMax: 2000, keyMax: 256,
      pathMaxPoints: 64, descriptionMax: 500, settleMs: 2000, snapshotNodes: 400, snapshotDepth: 20, browserActionMs: 10_000,
      navigateMs: 25_000, cdpOutputCap: 20_000, shellDefaultBlockMs: 30_000, rewatchEveryMs: 10_000, rewatchMaxMs: 5 * 3_600_000,
      pendingWakeMaxAgeMs: 48 * 3_600_000, childrenPerBot: 4, childrenTotal: 12, subagentWallClockMs: 2 * 3_600_000,
      secretsPerBot: 100, secretValueMax: 32_768, secretsTotalMax: 98_304, secretMinChars: 4, secretWarnBelow: 8,
      diskHardBytes: 2 * 1024 ** 3, diskSoftBytes: 8 * 1024 ** 3, snapshotKeep: 5, snapshotChunkBytes: 4 * 1024 ** 2,
      previewWarmMax: 3, previewCrashLimit: 3, cursorPressDelayMs: 500, glyphActiveMs: 5000, clipboardPollMs: 500,
    });
    expect(SUBAGENT_TYPES).toEqual(["generalPurpose", "computerUse", "browserUse"]);
  });
  it("types compile for the new payloads, commands and channels", () => {
    const p: SendMessagePayload = { type: "box-help", request: { id: "bh_1", botId: "b", instruction: "Sign in", reason: "auth", domain: null, idpDomain: null, screenshotDataUrl: null, status: "pending", inControl: false, createdAt: 1, settledAt: null } };
    const e: SseEvent = { channel: "computer-action", payload: { botId: "b", index: 2, kind: "click", x: 1, y: 2, at: 3, source: "computer" } };
    const c: GatewayCommands["handBackForeverBox"]["args"] = { id: "b", requestId: "bh_1", outcome: "done" };
    const open: GatewayCommands["openComputerApp"]["args"] = { id: "b", app: "terminal" };
    expect([p.type, e.channel, c.outcome, open.app]).toEqual(["box-help", "computer-action", "done", "terminal"]);
    expect(STRC.openTerminal).toBe("Terminal");
  });
});

describe("page-fill form vs Phase 2 chat card (merge seam)", () => {
  it("isPageFormCard tells a stored SEC-04 form from a CHAT-16 form card", async () => {
    const { isPageFormCard, isPageFormCardArgs } = await import("../src/computer");
    expect(isPageFormCard({ kind: "form", title: "T", url: null, fields: [], status: "pending", answeredFields: [] } as never)).toBe(true);
    expect(isPageFormCard({ kind: "form", title: "T", fields: [] } as never)).toBe(false);
    expect(isPageFormCard({ kind: "link", url: "https://x", title: null, description: null } as never)).toBe(false);
    expect(isPageFormCardArgs({ kind: "form", url: "https://x", fields: [] })).toBe(true);
    expect(isPageFormCardArgs({ kind: "form", fields: [{ name: "a", secret: true }] })).toBe(true);
    expect(isPageFormCardArgs({ kind: "form", fields: [{ name: "a", fillTarget: { ref: "e1" } }] })).toBe(true);
    expect(isPageFormCardArgs({ kind: "form", fields: [{ name: "a", kind: "text" }] })).toBe(false);
    expect(isPageFormCardArgs({ kind: "table" })).toBe(false);
    expect(isPageFormCardArgs(undefined)).toBe(false);
  });
});
