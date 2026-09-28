import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoxPin } from "../../src/main/box-pin";

// ORIG-12 §12.2 trust on first use; portable install blocker (c): a box the app itself recreated has a new
// key, and without a way to re-pin, secret sync failed with PIN_MISMATCH forever after.
describe("the box key pin", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const pin = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "pin-")); dirs.push(d); return new BoxPin(path.join(d, "box-pin.json")); };

  it("pins the first key it sees, then refuses another", () => {
    const p = pin();
    expect(p.check("k1")).toBe("pinned");
    expect(p.check("k1")).toBe("match");
    expect(p.check("k2")).toBe("mismatch");
  });

  it("after the app recreates the box, forget() lets the new key pin once", () => {
    const p = pin();
    p.check("old");
    p.forget();
    expect(p.check("new")).toBe("pinned");
    expect(p.check("old")).toBe("mismatch");
    p.forget();
    p.forget(); // already forgotten: no throw
  });
});
