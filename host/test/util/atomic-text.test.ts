import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeTextAtomic } from "../../util/atomic-text";

describe("writeTextAtomic", () => {
  it("writes via a temp file and applies the mode", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "at-")), "a", "b.md");
    writeTextAtomic(f, "# hi\n", 0o664);
    expect(fs.readFileSync(f, "utf8")).toBe("# hi\n");
    expect(fs.statSync(f).mode & 0o777).toBe(0o664);
    expect(fs.readdirSync(path.dirname(f))).toEqual(["b.md"]);
  });
});
