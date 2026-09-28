import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAppSettings, writeAppSettings } from "../../src/main/app-settings";

afterEach(() => vi.restoreAllMocks());

// Fix round 1, finding 3: writeAppSettings must match the project's own atomic-write pattern
// (host/util/atomic-json.ts and reviewer-rules.md's global constraint) — <file>.<pid>.<ts>.tmp,
// fsync before close, then rename — so a crash right after a settings write (e.g. right after the
// user flips Automatic Updates) can't leave app-settings.json missing or truncated.
describe("app-settings (Fix round 1, finding 3: atomic write)", () => {
  it("merges a patch into existing settings and round-trips through a fresh read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-settings-"));
    writeAppSettings(dir, { autoUpdate: true });
    const merged = writeAppSettings(dir, { updateFeed: "alex/bots" });
    expect(merged).toMatchObject({ autoUpdate: true, updateFeed: "alex/bots" });

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "app-settings.json"), "utf8")) as unknown;
    expect(onDisk).toMatchObject({ autoUpdate: true, updateFeed: "alex/bots" });
    expect(readAppSettings(dir, dir)).toMatchObject({ autoUpdate: true, updateFeed: "alex/bots" });
  });

  it("fsyncs the file descriptor before renaming it into place", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-settings-"));
    const order: string[] = [];
    const origRename = fs.renameSync.bind(fs);
    const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { order.push("fsync"); });
    vi.spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => { order.push("rename"); origRename(from, to); });
    writeAppSettings(dir, { theme: "dark" });
    expect(fsyncSpy).toHaveBeenCalled();
    expect(order.indexOf("fsync")).toBeLessThan(order.indexOf("rename"));
  });

  it("names the tmp file <file>.<pid>.<ts>.tmp, matching host/util/atomic-json.ts's pattern", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-settings-"));
    const names: string[] = [];
    const orig = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
      names.push(String(from));
      return orig(from, to);
    });
    writeAppSettings(dir, { theme: "light" });
    expect(names[0]).toMatch(new RegExp(`app-settings\\.json\\.${process.pid}\\.\\d+\\.tmp$`));
    // and no leftover tmp file once the write completes
    expect(fs.readdirSync(dir).some((f) => f.includes(".tmp"))).toBe(false);
  });
});

describe("keepBoxOnQuit (ARCH-12)", () => {
  it("defaults on so quitting the app leaves the computer running", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-settings-"));
    expect(readAppSettings(dir, dir).keepBoxOnQuit).toBe(true);
  });

  it("round-trips an off setting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-settings-"));
    expect(writeAppSettings(dir, { keepBoxOnQuit: false }).keepBoxOnQuit).toBe(false);
    expect(readAppSettings(dir, dir).keepBoxOnQuit).toBe(false);
  });
});
