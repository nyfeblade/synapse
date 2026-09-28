import { describe, expect, it } from "vitest";
import { SdkOneShot } from "../../brain/one-shot";

describe("SdkOneShot (D4: Haiku, no tools)", () => {
  it("runs a tool-less, non-persistent query and returns the result text", async () => {
    let seen: Record<string, unknown> = {};
    const queryFn = ((p: { prompt: string; options: Record<string, unknown> }) => {
      seen = { prompt: p.prompt, ...p.options };
      return (async function* () { yield { type: "result", subtype: "success", result: "profile: Prefers tea" }; })();
    }) as never;
    const m = new SdkOneShot({ env: { HOME: "/home/box" }, cwd: "/workspace", queryFn });
    expect(await m.complete({ system: "SYS", user: "USER", tag: { purpose: "extraction", botId: "b1" } })).toBe("profile: Prefers tea");
    expect(seen).toMatchObject({ prompt: "USER", systemPrompt: "SYS", model: "claude-haiku-4-5-20251001", tools: [], persistSession: false, settingSources: [], maxTurns: 1 });
  });
  it("throws on an error result", async () => {
    const queryFn = (() => (async function* () { yield { type: "result", subtype: "error_during_execution", errors: ["boom"] }; })()) as never;
    await expect(new SdkOneShot({ env: {}, cwd: "/", queryFn }).complete({ system: "s", user: "u", tag: { purpose: "episode", botId: "b1" } })).rejects.toThrow(/boom/);
  });
});
