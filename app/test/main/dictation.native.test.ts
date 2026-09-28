import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bin = path.resolve(__dirname, "../../dist/native/bots-dictation");
describe.skipIf(process.env.RUN_NATIVE !== "1" || process.platform !== "darwin")("native dictation helper", () => {
  it("transcribes a spoken file", () => {
    const aiff = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dict-")), "hello.aiff");
    execFileSync("say", ["-o", aiff, "hello world"]);
    const out = execFileSync(bin, ["--file", aiff, "--locale", "en-US"], { timeout: 60_000 }).toString();
    const final = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "final");
    expect(final.text.toLowerCase()).toContain("hello");
  }, 90_000);
});
