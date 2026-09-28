import { describe, expect, it } from "vitest";
import { ScannerRegistry, SecretScanner } from "../../secrets/scanner";
import { withSecrets } from "../../secrets/secret-wiring";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { BrainWiring } from "../../brain/types";

const V = "sk_live_9aZ+/q=Tt7";
const scanner = () => new SecretScanner([{ name: "STRIPE_KEY", value: V }]);

describe("SecretScanner (ORIG-12 §12.4)", () => {
  it.each([
    ["raw", `key=${V}`],
    ["base64", `b64 ${Buffer.from(V).toString("base64")}`],
    ["base64 shifted 1", Buffer.from(`x${V}`).toString("base64")],
    ["base64 shifted 2", Buffer.from(`xy${V}`).toString("base64")],
    ["base64url", Buffer.from(V).toString("base64url")],
    ["hex", Buffer.from(V).toString("hex")],
    ["HEX", Buffer.from(V).toString("hex").toUpperCase()],
    ["url-encoded", encodeURIComponent(V)],
    ["json-escaped", JSON.stringify({ k: `${V}"` })],
  ])("redacts the %s form", (_n, text) => {
    const out = scanner().redact(text);
    expect(out).toContain("[secret:STRIPE_KEY]");
    expect(out).not.toContain(V);
    expect(out).not.toContain(Buffer.from(V).toString("hex"));
  });

  it("leaves unrelated text alone and reports the first match's name", () => {
    expect(scanner().redact("nothing to see")).toBe("nothing to see");
    expect(scanner().firstMatch(`send ${V}`)).toBe("STRIPE_KEY");
    expect(scanner().firstMatch("hello")).toBeNull();
  });

  it("ignores values shorter than 4 characters", () => {
    expect(new SecretScanner([{ name: "PIN", value: "123" }]).redact("123")).toBe("123");
  });
});

describe("withSecrets", () => {
  const base = (): BrainWiring => ({
    preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}),
    stop: async () => ({ block: false }), botTools: () => [], turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
    flags: () => DEFAULT_FLAGS,
  });
  const registry = new ScannerRegistry({ values: () => [{ name: "STRIPE_KEY", value: V }], onChange: () => () => {} });

  it("replaces tool output that contains a value, even when the inner wiring doesn't touch it", async () => {
    const w = withSecrets(base(), { botId: "b", registry });
    expect(await w.postToolUse({ toolName: "Bash", input: { command: "env" }, toolUseId: "1" }, `STRIPE_KEY=${V}\nPATH=/bin`)).toEqual({ replaceOutput: "STRIPE_KEY=[secret:STRIPE_KEY]\nPATH=/bin" });
    expect(await w.postToolUse({ toolName: "Bash", input: {}, toolUseId: "2" }, "clean")).toEqual({});
  });

  it("denies outgoing SendMessage / SendToAgent / update_state text that contains a value", async () => {
    const w = withSecrets(base(), { botId: "b", registry });
    expect(await w.preToolUse({ toolName: "mcp__bot__SendMessage", input: { content: `here: ${V}` }, toolUseId: "3" })).toEqual({ decision: "deny", reason: "That text contains the value of secret STRIPE_KEY. Refer to it as $STRIPE_KEY instead." });
    expect(await w.preToolUse({ toolName: "mcp__bot__update_state", input: { target: "memory", fact: encodeURIComponent(V) }, toolUseId: "4" })).toMatchObject({ decision: "deny" });
    expect(await w.preToolUse({ toolName: "Bash", input: { command: "echo $STRIPE_KEY" }, toolUseId: "5" })).toEqual({ decision: "allow" });
  });

  it("denies CreateAgent / UpdateAgent names and descriptions that carry a value, raw or encoded (security fix I7)", async () => {
    const w = withSecrets(base(), { botId: "b", registry });
    expect(await w.preToolUse({ toolName: "mcp__bot__CreateAgent", input: { name: "Leak", description: `use key ${V}` }, toolUseId: "6" })).toMatchObject({ decision: "deny" });
    expect(await w.preToolUse({ toolName: "mcp__bot__UpdateAgent", input: { agent_id: "x", description: Buffer.from(V).toString("hex") }, toolUseId: "7" })).toMatchObject({ decision: "deny" });
  });
});

describe("I5/I10: webhook keys and connector secrets are in the scanner", () => {
  it("redacts any webhook key (bot_ + 32 base62) even with no vault secrets, and flags it in outgoing text", () => {
    const k = `bot_${"A1b2C3d4".repeat(4)}`;
    const s = new SecretScanner([]);
    expect(s.redact(`POST with ${k} now`)).toBe("POST with [secret:WEBHOOK_KEY] now");
    expect(s.firstMatch(`x ${k}`)).toBe("WEBHOOK_KEY");
  });
  it("the registry adds extra sources (connector secrets) and forgets them on invalidate", () => {
    let extra = [{ name: "SLACK_BOT_TOKEN", value: "xoxb-1234567890-abc" }];
    const r = new ScannerRegistry({ values: () => [], onChange: () => () => {} });
    r.addSource(() => extra);
    expect(r.redact("b1", "tok xoxb-1234567890-abc")).toBe("tok [secret:SLACK_BOT_TOKEN]");
    extra = [{ name: "IMAP_PASSWORD", value: "imap-pass-99887766" }];
    r.invalidate("b1");
    expect(r.redact("b1", "pw imap-pass-99887766")).toBe("pw [secret:IMAP_PASSWORD]");
  });
});
