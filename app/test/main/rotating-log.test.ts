import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRotatingLog } from "../../src/main/rotating-log";

// Bug 105: `dictation[...]` lines only went to the console, so a field failure couldn't be read back.
describe("rotating log file", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "rlog-"));

  it("appends timestamped lines, creating the folder", () => {
    const d = path.join(dir(), "logs");
    const log = createRotatingLog({ dir: d, name: "voice.log", maxBytes: 10_000, keep: 2, now: () => new Date("2026-09-21T10:00:00Z") });
    log("dictation[abcd] start");
    log("dictation[abcd] end");
    expect(fs.readFileSync(path.join(d, "voice.log"), "utf8")).toBe("2026-09-21T10:00:00.000Z dictation[abcd] start\n2026-09-21T10:00:00.000Z dictation[abcd] end\n");
  });

  it("rotates at the size cap and keeps only `keep` old files", () => {
    const d = dir();
    const log = createRotatingLog({ dir: d, name: "voice.log", maxBytes: 100, keep: 2, now: () => new Date(0) });
    for (let i = 0; i < 20; i++) log(`line ${i} ${"x".repeat(20)}`);
    const files = fs.readdirSync(d).sort();
    expect(files).toEqual(["voice.log", "voice.log.1", "voice.log.2"]);
    for (const f of files) expect(fs.statSync(path.join(d, f)).size).toBeLessThanOrEqual(100);
    expect(fs.readFileSync(path.join(d, "voice.log"), "utf8")).toContain("line 19");
  });

  it("one line never carries a newline (a helper can't forge log lines) and a write failure never throws", () => {
    const d = dir();
    const log = createRotatingLog({ dir: d, name: "voice.log", maxBytes: 10_000, keep: 1, now: () => new Date(0) });
    log("a\nb\rc");
    expect(fs.readFileSync(path.join(d, "voice.log"), "utf8")).toBe("1970-01-01T00:00:00.000Z a b c\n");
    const bad = createRotatingLog({ dir: path.join(d, "voice.log", "nope"), name: "x.log", maxBytes: 100, keep: 1 });
    expect(() => bad("hello")).not.toThrow();
  });
});
