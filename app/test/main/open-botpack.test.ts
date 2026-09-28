import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const emitNative = vi.fn();
const allowDroppedPath = vi.fn();
vi.mock("../../src/main/native", () => ({ emitNative }));
vi.mock("../../src/main/native/files", () => ({ allowDroppedPath }));

const { isBotpackPath, registerOpenBotpacks } = await import("../../src/main/native/open-botpacks");

class FakeApp extends EventEmitter {
  on(ev: string, fn: (...args: unknown[]) => void) { super.on(ev, fn); return this; }
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

afterEach(() => { emitNative.mockClear(); allowDroppedPath.mockClear(); vi.useRealTimers(); });

describe("isBotpackPath", () => {
  it("accepts an absolute .botpack and rejects everything else", () => {
    expect(isBotpackPath("/Users/u/Desktop/scout.botpack")).toBe(true);
    expect(isBotpackPath("/Users/u/Desktop/Scout.BOTPACK")).toBe(true);
    expect(isBotpackPath("scout.botpack")).toBe(false);
    expect(isBotpackPath("/Users/u/Desktop/notes.md")).toBe(false);
    expect(isBotpackPath("/Users/u/Desktop/scout.botpack.exe")).toBe(false);
  });
});

describe("registerOpenBotpacks", () => {
  it("queues a Finder open-file until the window is ready, then allowlists and emits import-bot-file", () => {
    vi.useFakeTimers();
    let ready = false;
    const app = new FakeApp();
    registerOpenBotpacks(app as never, () => ready);
    const ev = { preventDefault: vi.fn() };
    app.emit("open-file", ev, "/Users/u/Desktop/scout.botpack");
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(allowDroppedPath).toHaveBeenCalledWith("/Users/u/Desktop/scout.botpack");
    expect(emitNative).not.toHaveBeenCalled();
    ready = true;
    vi.advanceTimersByTime(250);
    expect(emitNative).toHaveBeenCalledWith("import-bot-file", { path: "/Users/u/Desktop/scout.botpack" });
  });

  it("ignores a second-instance argv that is not a .botpack", () => {
    const app = new FakeApp();
    registerOpenBotpacks(app as never, () => true);
    app.emit("second-instance", {}, ["/Applications/Synapse.app/Contents/MacOS/Synapse", "/tmp/notes.md"]);
    expect(allowDroppedPath).not.toHaveBeenCalled();
    expect(emitNative).not.toHaveBeenCalled();
  });

  it("delivers a .botpack from a second-instance argv immediately when ready", () => {
    const app = new FakeApp();
    registerOpenBotpacks(app as never, () => true);
    app.emit("second-instance", {}, ["/Applications/Synapse.app/Contents/MacOS/Synapse", "/tmp/team.botpack"]);
    expect(allowDroppedPath).toHaveBeenCalledWith("/tmp/team.botpack");
    expect(emitNative).toHaveBeenCalledWith("import-bot-file", { path: "/tmp/team.botpack" });
  });
});

describe("package registers .botpack", () => {
  it("declares the document type so another Synapse can open the file", () => {
    // Bug 99 moved the Info.plist keys into scripts/info-plist.mjs; package.mjs passes them through.
    const src = readFileSync(path.join(appRoot, "scripts/package.mjs"), "utf8");
    expect(src).toContain("extendInfo: extendInfo(bundleName)");
    const info = readFileSync(path.join(appRoot, "scripts/info-plist.mjs"), "utf8");
    expect(info).toContain("CFBundleDocumentTypes");
    expect(info).toContain("botpack");
  });
});
