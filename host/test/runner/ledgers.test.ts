import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AckLedger } from "../../runner/ack-ledger";
import { SendAcceptanceLedger } from "../../runner/send-acceptance";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "led-"));

describe("AckLedger (OUT-08)", () => {
  it("coalesces, clears only with the live token, counts redrives and persists", () => {
    const file = path.join(dir(), "ack-obligations.json");
    let t = 100;
    const l = new AckLedger(file, () => t);
    l.record("b");
    t = 200;
    l.record("b");
    expect(l.get("b")).toMatchObject({ createdAtMs: 100, coalescedCount: 1, redriveAttempts: 0 });
    expect(l.clear("b", "999")).toBe(false);
    expect(l.noteRedrive("b")).toBe(1);
    expect(new AckLedger(file).get("b")?.redriveAttempts).toBe(1);
    expect(l.clear("b", l.token("b")!)).toBe(true);
    expect(l.get("b")).toBeNull();
  });
});

describe("SendAcceptanceLedger (EVT-11)", () => {
  it("makes retries idempotent and rejects a nonce reused with other text", () => {
    const l = new SendAcceptanceLedger(path.join(dir(), "send-acceptance.json"));
    expect(l.check("b", "n1", "hi")).toEqual({ kind: "new" });
    l.record("b", "n1", "hi", "t1u");
    expect(l.check("b", "n1", "hi")).toEqual({ kind: "duplicate", entryId: "t1u" });
    expect(() => l.check("b", "n1", "other")).toThrow("This message was already sent. Start a new message instead.");
    for (let i = 0; i < 300; i++) l.record("b", `x${i}`, "t", `t${i}u`);
    expect(l.check("b", "n1", "hi")).toEqual({ kind: "new" });
  });
});
