import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_QUIET_HOURS, focusActive, focusState, inQuietHours, ringPolicy, validQuietHours } from "../../src/main/native/bot-calls";

const at = (h: number, m = 0) => new Date(2026, 8, 22, h, m);

describe("a Bot's call: may the Mac ring?", () => {
  it("quiet hours can wrap midnight", () => {
    const q = { start: "22:00", end: "08:00" };
    expect(inQuietHours(q, at(23))).toBe(true);
    expect(inQuietHours(q, at(3))).toBe(true);
    expect(inQuietHours(q, at(8))).toBe(false);
    expect(inQuietHours(q, at(12))).toBe(false);
    expect(inQuietHours(q, at(21, 59))).toBe(false);
    expect(inQuietHours({ start: "13:00", end: "14:00" }, at(13, 30))).toBe(true);
    expect(inQuietHours(null, at(3))).toBe(false);
    expect(inQuietHours({ start: "09:00", end: "09:00" }, at(9))).toBe(false); // empty window
  });

  it("quiet hours are on by default (22:00–08:00) and validated", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ start: "22:00", end: "08:00" });
    expect(validQuietHours({ start: "07:30", end: "23:05" })).toBe(true);
    expect(validQuietHours({ start: "24:00", end: "08:00" })).toBe(false);
    expect(validQuietHours({ start: "7:30", end: "08:00" })).toBe(false);
    expect(validQuietHours("22-08")).toBe(false);
  });

  it("rings unless quiet hours or Focus say not to, and says which", () => {
    expect(ringPolicy({ quiet: DEFAULT_QUIET_HOURS, focus: false, now: at(12) })).toEqual({ ring: true, sound: true });
    expect(ringPolicy({ quiet: DEFAULT_QUIET_HOURS, focus: false, now: at(23) })).toEqual({ ring: false, why: "quiet hours" });
    expect(ringPolicy({ quiet: null, focus: true, now: at(12) })).toEqual({ ring: false, why: "Focus is on" });
  });

  it("reads an active Focus from the Do Not Disturb assertions, and treats anything unreadable as off", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "focus-"));
    expect(focusActive(home)).toBe(false);
    const dir = path.join(home, "Library/DoNotDisturb/DB");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Assertions.json"), JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: "com.apple.donotdisturb.mode.default" } }] }] }));
    expect(focusActive(home)).toBe(true);
    fs.writeFileSync(path.join(dir, "Assertions.json"), JSON.stringify({ data: [{ storeAssertionRecords: [] }] }));
    expect(focusActive(home)).toBe(false);
    fs.writeFileSync(path.join(dir, "Assertions.json"), "garbage");
    expect(focusActive(home)).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("0.1.4 first-run: a Focus state it can't read is unknown, and then the call rings quietly (macOS decides), never with the app's own ring", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "focus-"));
    try {
      expect(focusState(home)).toBe("unknown"); // no folder at all: can't see it
      const dir = path.join(home, "Library/DoNotDisturb/DB");
      fs.mkdirSync(dir, { recursive: true });
      expect(focusState(home)).toBe("off"); // the folder is readable and holds no assertions
      fs.writeFileSync(path.join(dir, "Assertions.json"), "garbage");
      expect(focusState(home)).toBe("unknown");
      fs.writeFileSync(path.join(dir, "Assertions.json"), JSON.stringify({ data: [{ storeAssertionRecords: [{}] }] }));
      expect(focusState(home)).toBe("on");
      if (process.getuid?.() !== 0) {
        // No Full Disk Access looks like this to the app: the file is there but reading it is refused.
        fs.chmodSync(path.join(dir, "Assertions.json"), 0o000);
        expect(focusState(home)).toBe("unknown");
        fs.chmodSync(path.join(dir, "Assertions.json"), 0o600);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
    expect(ringPolicy({ quiet: null, focus: "unknown", now: at(12) })).toEqual({ ring: true, sound: false });
    expect(ringPolicy({ quiet: null, focus: "off", now: at(12) })).toEqual({ ring: true, sound: true });
    expect(ringPolicy({ quiet: null, focus: "on", now: at(12) })).toEqual({ ring: false, why: "Focus is on" });
    expect(ringPolicy({ quiet: DEFAULT_QUIET_HOURS, focus: "unknown", now: at(23) })).toEqual({ ring: false, why: "quiet hours" });
  });
});
