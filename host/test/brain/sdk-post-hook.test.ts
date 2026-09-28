import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { toSdkHooks } from "../../brain/sdk-wiring";
import type { BrainWiring } from "../../brain/types";

/**
 * T29 box finding (ORIG-12 §12.4): built-in Bash/Read results reached the model unredacted. The hook stringified the
 * tool_response object and handed a JSON *string* back as updatedToolOutput, which the CLI ignores for built-ins
 * (their result is an object). A redacted result now keeps the tool_response's own shape.
 */
describe("PostToolUse output replacement keeps the tool_response shape", () => {
  const w = {
    preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), stop: async () => ({ block: false }),
    postToolUse: async (_c: unknown, out: string) => ({ replaceOutput: out.split("sk_live_123").join("[secret:STRIPE_KEY]") }),
    botTools: () => [], turnCounters: () => ({}), flags: () => DEFAULT_FLAGS,
  } as unknown as BrainWiring;
  const post = toSdkHooks(w).PostToolUse![0]!.hooks[0]!;
  const run = (tool_response: unknown) => post({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "t", tool_response } as never, "t", { signal: new AbortController().signal });

  it("an object result (Bash, Read) comes back as the same object with redacted strings", async () => {
    const r = (await run({ stdout: "key sk_live_123\n", stderr: "", interrupted: false })) as { hookSpecificOutput: { updatedToolOutput: unknown } };
    expect(r.hookSpecificOutput.updatedToolOutput).toEqual({ stdout: "key [secret:STRIPE_KEY]\n", stderr: "", interrupted: false });
    const read = (await run({ type: "text", file: { filePath: "/w/a", content: "x sk_live_123" } })) as { hookSpecificOutput: { updatedToolOutput: unknown } };
    expect(read.hookSpecificOutput.updatedToolOutput).toEqual({ type: "text", file: { filePath: "/w/a", content: "x [secret:STRIPE_KEY]" } });
  });

  it("a string result stays a string", async () => {
    const r = (await run("key sk_live_123")) as { hookSpecificOutput: { updatedToolOutput: unknown } };
    expect(r.hookSpecificOutput.updatedToolOutput).toBe("key [secret:STRIPE_KEY]");
  });
});
