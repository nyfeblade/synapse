import { describe, expect, it } from "vitest";
import { STR_AUTH } from "@synapse/shared";
import { confirmTrustDialog } from "../../src/main/auth-key";

// UI-controls pass (2026-09-29): the app's native alerts follow one rule. macOS lays an NSAlert's
// buttons out right to left, so an alert lists its act FIRST (rightmost) and Cancel LAST (leftmost);
// a risky act is never the default, so Return and Escape both land on Cancel. The message is a short
// title; the reason and the evidence go in the detail.
describe("the Trust-this-computer alert", () => {
  const ask = async (response: number) => {
    type Opts = Parameters<Parameters<typeof confirmTrustDialog>[0]>[0];
    const box: { seen?: Opts } = {};
    const ok = await confirmTrustDialog(async (o) => { box.seen = o; return { response }; }, "aa:bb", "cc:dd");
    return { ok, o: box.seen! };
  };

  it("lists Trust then Cancel (Cancel on the left), with Cancel the default and the cancel", async () => {
    const { o } = await ask(1);
    expect(o.buttons).toEqual([STR_AUTH.trustComputer, STR_AUTH.trustConfirmCancel]);
    expect(o.defaultId).toBe(1);
    expect(o.cancelId).toBe(1);
  });

  it("only the Trust button trusts", async () => {
    expect((await ask(0)).ok).toBe(true);
    expect((await ask(1)).ok).toBe(false);
  });

  it("the message is a short title; the reason and both fingerprints are in the detail", async () => {
    const { o } = await ask(1);
    expect(o.message).not.toMatch(/\.\s/);
    expect(o.detail).toMatch(/reinstalled/);
    expect(o.detail).toContain("aa:bb");
    expect(o.detail).toContain("cc:dd");
  });
});
