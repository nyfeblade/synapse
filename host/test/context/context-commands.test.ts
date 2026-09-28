import { describe, expect, it } from "vitest";
import { createContextCommands } from "../../context/context-commands";
import { patchCtx } from "../../context/context-meter";
import { makeRunnerHarness } from "../runner/harness";

describe("context commands (CTX-05)", () => {
  it("reports the meter and schedules compaction and a new session", async () => {
    const h = await makeRunnerHarness({ script: () => [] });
    const calls: string[] = [];
    const cmd = createContextCommands({ bots: h.bots, compactor: { compactNow: (id, r) => (calls.push(`compact:${r}`), true) }, rollover: { rollNow: (id, r) => (calls.push(`roll:${r}`), true) }, sizeOf: () => 42 });
    const id = h.bots.create({ name: "Piper", origin: "user", kickstart: false });
    h.bots.setSessionId(id, "11111111-1111-4111-8111-111111111111");
    patchCtx(h.bots, id, { ctxTokens: 84_000, window: 200_000, ratio: 0.42 });
    expect(await cmd.getAgentContext!({ id })).toMatchObject({ ctxTokens: 84_000, ratio: 0.42, sessionBytes: 42 });
    expect(await cmd.compactAgentNow!({ id })).toEqual({ scheduled: true });
    expect(await cmd.newAgentSession!({ id })).toEqual({ scheduled: true });
    expect(calls).toEqual(["compact:user", "roll:user"]);
  });
});
