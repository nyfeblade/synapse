import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readAppSettings, writeAppSettings } from "../../src/main/app-settings";
import { backgroundCheck, registerUpdater, type UpdateState } from "../../src/main/native/updater";

/**
 * Code audit 2026-09-29 §7.1: Synapse always checks for updates and shows one that's available. The
 * Automatic Updates switch decides only whether it's downloaded and made ready by itself.
 */
const st = (status: UpdateState["status"]): UpdateState => ({ version: "0.2.0", track: "stable", auto: false, feed: "a/b", status, latest: status === "available" ? "0.3.0" : null, error: null });

function fakeSvc(status: UpdateState["status"]) {
  return { check: vi.fn(async () => st(status)), download: vi.fn(async () => st("ready")) };
}

describe("the background check", () => {
  it("checks even with automatic updates off, and leaves an available update for the user", async () => {
    const svc = fakeSvc("available");
    const out = await backgroundCheck(svc, false);
    expect(svc.check).toHaveBeenCalledTimes(1);
    expect(svc.download).not.toHaveBeenCalled();
    expect(out.status).toBe("available");
  });

  it("with automatic updates on, downloads an available update", async () => {
    const svc = fakeSvc("available");
    expect((await backgroundCheck(svc, true)).status).toBe("ready");
    expect(svc.download).toHaveBeenCalledTimes(1);
  });

  it("downloads nothing when there's nothing new", async () => {
    const svc = fakeSvc("none");
    await backgroundCheck(svc, true);
    expect(svc.download).not.toHaveBeenCalled();
  });
});

describe("registerUpdater", () => {
  it("checks at launch with the switch off", async () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "upd-reg-"));
    const emitted: UpdateState[] = [];
    const handlers = new Map<string, (a: unknown) => unknown>();
    const app = { getVersion: () => "0.2.0", isPackaged: false, getPath: (n: string) => (n === "exe" ? "/Applications/Synapse.app/Contents/MacOS/Synapse" : ud), quit: () => {} } as unknown as Electron.App;
    registerUpdater({ app, feed: () => "a/b", auto: () => false, setAuto: () => {} }, (n, fn) => handlers.set(n, fn), (_c, p) => emitted.push(p as UpdateState));
    // An unpackaged build answers "no-feed": the point is that a check ran at all.
    await vi.waitFor(() => expect(emitted.map((s) => s.status)).toContain("no-feed"));
    expect(handlers.has("updates.download")).toBe(true);
  });
});

describe("the Automatic Updates setting", () => {
  it("is on for a profile that never touched it", () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "upd-set-"));
    expect(readAppSettings(ud, ud).autoUpdate).toBe(true);
    writeAppSettings(ud, { theme: "dark" });
    expect(readAppSettings(ud, ud).autoUpdate).toBe(true);
  });

  it("stays off for someone who turned it off", () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "upd-set-"));
    writeAppSettings(ud, { autoUpdate: false });
    expect(readAppSettings(ud, ud).autoUpdate).toBe(false);
  });
});
