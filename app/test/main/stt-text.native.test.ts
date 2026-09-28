import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bug 162: dictation misheard names and details. The helper now biases the recognizer towards the
 * session's own names (measured: word error rate 16.8% to 6.9%, name accuracy 25/54 to 48/54 on a
 * fixed set of spoken samples), acts on spoken commands in code instead of sending them to the
 * model, and runs a cheap fixer over the final transcript.
 *
 * RUN_NATIVE=1 opts in (macOS + the built helper, app/native/dictation/build.sh).
 */
const bin = process.env.DICTATION_BIN ?? path.resolve(__dirname, "../../dist/native/bots-dictation");
const run = (args: string[]) => spawnSync(bin, args, { timeout: 30_000, encoding: "utf8" });
const events = (out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("dictation text rules (bug 162)", () => {
  it("the spoken-command, post-correction and contextual-string rules pass their own self-test", () => {
    const r = run(["--self-test-text"]);
    const ev = events(r.stdout).find((e) => e.type === "self-test");
    expect(ev, r.stderr).toMatchObject({ ok: true, failures: [] });
    expect(ev!.cases as number).toBeGreaterThanOrEqual(40);
    expect(r.status).toBe(0);
  });

  it("reads a context file and says how many names it will listen for", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-ctx-native-"));
    try {
      const file = path.join(dir, "c.json");
      // "nova" repeats "Nova" in another case and "x" is too short: 2 of the 4 survive.
      fs.writeFileSync(file, JSON.stringify({ strings: ["Nova", "nova", "x", "Disk Saver"] }));
      const r = run(["--self-test-text", "--context-file", file]);
      expect(r.stderr).toMatch(/context: 2 strings from 4/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing context file is not fatal — the session just runs unbiased", () => {
    const r = run(["--self-test-text", "--context-file", "/nonexistent/nope.json"]);
    expect(r.stderr).toMatch(/context file unreadable/);
    expect(r.status).toBe(0);
  });

  it("a bare JSON array works as well as {strings:[…]}", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-ctx-native-"));
    try {
      const file = path.join(dir, "c.json");
      fs.writeFileSync(file, JSON.stringify(["Nova", "Atlas"]));
      const r = run(["--self-test-text", "--context-file", file]);
      expect(r.stderr).toMatch(/context: 2 strings from 2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
