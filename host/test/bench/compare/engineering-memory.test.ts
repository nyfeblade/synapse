import { describe, expect, it } from "vitest";
import { synapseShipped } from "../../../bench/compare/params";
import { simulate } from "../../../bench/compare/simulate";
import { buildConversation, PROFILES } from "../../../bench/compare/workload";

/**
 * S1 memory gap closed: an engineering-mode Bot's helper-model (Haiku) cost per 100 turns, on the simulator's
 * tool-heavy (coding) workload. Engineering mode = the lean prefix's memory: batched extraction (memBatch 3)
 * and the episode at compaction; compared with the everyday Bot (batched extraction, an episode every 6 turns).
 */
function per100(p: ReturnType<typeof synapseShipped>) {
  const r = simulate(buildConversation(PROFILES.toolHeavy, "small"), p);
  const n = r.messages.length;
  const h = r.messages.reduce((a, m) => ({ calls: a.calls + m.helper.calls, input: a.input + m.helper.input, output: a.output + m.helper.output }), { calls: 0, input: 0, output: 0 });
  const k = 100 / n;
  return { turns: n, calls: +(h.calls * k).toFixed(1), input: Math.round(h.input * k), output: Math.round(h.output * k), compactions: r.compactions };
}

describe("engineering-mode memory: helper tokens per 100 turns (simulator)", () => {
  it("batched extraction + episode at compaction costs less than the everyday cadence, and more than zero", () => {
    const engineering = per100(synapseShipped({ memBatch: 3, episodesAtCompaction: true }));
    const everyday = per100(synapseShipped({ memBatch: 3 }));
    const perTurn = per100(synapseShipped({}));
    console.log(JSON.stringify({ engineering, everyday, perTurnUnbatched: perTurn }));
    expect(engineering.calls).toBeGreaterThan(0);
    expect(engineering.input + engineering.output).toBeLessThanOrEqual(everyday.input + everyday.output);
    expect(engineering.input + engineering.output).toBeLessThan(perTurn.input + perTurn.output);
  });
});
