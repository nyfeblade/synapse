import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GateClassifier } from "../../b2b/classifier";
import { StubOneShot } from "../../helper-model/one-shot";
import type { RuntimeMetrics } from "../../metrics/runtime-metrics";

const input = { botId: "A", chainId: "c_1", kind: "result" as const, message: "Moved the report.", expects: null, thread_digest: "Thread with Scout (id 7c1e…): open: none." };
const setup = (handler: (i: unknown) => unknown, timeoutMs = 50) => {
  const metrics = { recordB2B: vi.fn() } as unknown as RuntimeMetrics;
  const model = new StubOneShot({ "orig/b2b-gate.md": handler });
  const c = new GateClassifier({ model, cacheFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cls-")), "cache.json"), metrics, timeoutMs });
  return { c, model, metrics };
};

describe("GateClassifier", () => {
  it("calls Haiku with the kind, message, expects and digest, then caches the verdict for 24 h", async () => {
    const { c, model, metrics } = setup(() => ({ verdict: "inbox", kind_suggestion: null, reason: "an FYI" }));
    expect(await c.classify(input)).toEqual({ verdict: "inbox", kind_suggestion: null, reason: "an FYI" });
    expect(model.calls[0]?.input).toEqual({ kind: "result", message: "Moved the report.", expects: null, thread_digest: input.thread_digest });
    expect(await c.classify({ ...input, message: "  moved the REPORT. " })).toMatchObject({ verdict: "inbox" });
    expect(model.calls).toHaveLength(1);
    expect(vi.mocked(metrics.recordB2B).mock.calls.map((x) => x[0].event)).toEqual(["classifier_call", "classifier_cache_hit"]);
  });

  it("falls back to the inbox on timeout, error or a malformed answer, and doesn't cache the fallback", async () => {
    const slow = setup(() => new Promise(() => {}), 20);
    expect(await slow.c.classify(input)).toMatchObject({ verdict: "inbox", kind_suggestion: null });
    const bad = setup(() => ({ verdict: "maybe" }));
    expect(await bad.c.classify(input)).toMatchObject({ verdict: "inbox" });
    expect(await bad.c.classify(input)).toMatchObject({ verdict: "inbox" });
    expect(bad.model.calls).toHaveLength(2);
    const boom = setup(() => { throw new Error("down"); });
    expect(await boom.c.classify(input)).toMatchObject({ verdict: "inbox" });
  });

  it("passes a kind suggestion through", async () => {
    const { c } = setup(() => ({ verdict: "deliver", kind_suggestion: "question", reason: "asks for a decision" }));
    expect(await c.classify({ ...input, kind: "request" })).toEqual({ verdict: "deliver", kind_suggestion: "question", reason: "asks for a decision" });
  });
});
