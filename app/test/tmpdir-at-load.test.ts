import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// bug-log 128: a helper that makes a temp dir while the file is being collected (a describe body,
// module scope) must land in the per-file root too, or it is left in the system temp dir.
const atLoad = os.tmpdir();

it("the per-file temp root is in place before the file is collected", () => {
  expect(path.basename(atLoad)).toMatch(/^vt-/);
});
