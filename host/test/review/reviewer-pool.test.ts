import { beforeEach, describe, expect, it, vi } from "vitest";

// Each query() stands for one CLI process: record how many messages each is ever handed, and whether it was closed.
interface Proc { id: number; pushed: number; closed: boolean }
const procs: Proc[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const p: Proc = { id: procs.length, pushed: 0, closed: false };
    procs.push(p);
    return {
      close() { p.closed = true; },
      async *[Symbol.asyncIterator]() {
        for await (const _m of prompt) {
          p.pushed++;
          yield { type: "result", structured_output: { verdict: { matched_ask_rule_ids: [], floor_category: null, matched_allow_rule_ids: [], injection_suspected: false, risk_tier: 0, decision: "allow", confidence: 1, reason: "ok", proposed_allow_rule: null } } }; // the wrapped verdict (speed plan #2)
        }
      },
    };
  },
}));

const { SdkModelReviewer } = await import("../../review/model-reviewer");

describe("the reviewer's prewarm pool (TTFT war room review, fix round 1)", () => {
  beforeEach(() => { procs.length = 0; });

  it("never reuses a process: each review gets a fresh one, which is closed after its single answer", async () => {
    const r = new SdkModelReviewer({ env: {}, cwd: "/workspace", prewarm: 1 });
    for (let i = 0; i < 4; i++) await r.review({ i }, new AbortController().signal);
    await new Promise((res) => setTimeout(res, 0));
    const used = procs.filter((p) => p.pushed > 0);
    expect(used).toHaveLength(4);
    for (const p of used) {
      expect(p.pushed).toBe(1);
      expect(p.closed).toBe(true);
    }
    r.dispose();
  });

  it("the pool follows a live target: a call going live empties it, ending the call refills it", () => {
    let target = 1;
    const r = new SdkModelReviewer({ env: {}, cwd: "/workspace", prewarm: () => target });
    expect(r.warmCount()).toBe(1);
    target = 0;
    r.resize();
    expect(r.warmCount()).toBe(0);
    expect(procs[0]!.closed).toBe(true);
    target = 1;
    r.resize();
    expect(r.warmCount()).toBe(1);
    r.dispose();
  });
});
