import { describe, expect, it } from "vitest";
import { createApiKeySender } from "../../src/main/auth-key";

const KEY = "sk-ant-api03-" + "M".repeat(80) + "9x9x";
const view = { mode: "api-key", apiKey: null, subscriptionConfigured: true, boxPublicKey: "PK" };

function fake(pin: "pinned" | "match" | "mismatch" = "match", o: { hostRefuses?: boolean; macThrows?: boolean } = {}) {
  const sent: [string, unknown][] = [];
  const mac: string[] = [];
  const logs: string[] = [];
  const call = (async (cmd: string, args: unknown) => {
    sent.push([cmd, args]);
    if (cmd === "getAuth") return view;
    if (cmd === "setApiKey") { if (o.hostRefuses) throw new Error("That doesn't look like an Anthropic API key"); return { ...view, apiKey: { masked: "sk-ant-…9x9x", savedAt: 1 } }; }
    if (cmd === "clearApiKey") return view;
    return { ok: false, reached: true, kind: "invalid-key", status: 401, title: "Reached Anthropic ✓ — key rejected", detail: "" };
  }) as never;
  const sender = createApiKeySender({
    call, pin: { check: () => pin }, seal: async (pk, v) => `sealed(${pk}):${v.length}`, log: (s) => logs.push(s),
    mac: {
      save: async (k) => { if (o.macThrows) return { ok: false, error: "This Mac's permission key can't be trusted." }; mac.push(`save:${k}`); return { ok: true }; },
      clear: async () => { mac.push("clear"); }, has: async () => mac.at(-1)?.startsWith("save:") ?? false,
    },
  });
  return { sent, sender, mac, logs };
}

describe("the API key leaves the Mac's main process sealed to the box, never in plaintext", () => {
  it("save: seals to the box public key; only the sealed form goes over the gateway", async () => {
    const { sent, sender } = fake();
    const v = await sender.save(`  ${KEY}\n`);
    expect(v.apiKey?.masked).toBe("sk-ant-…9x9x");
    expect(sent.map((s) => s[0])).toEqual(["getAuth", "setApiKey"]);
    expect(sent[1]![1]).toEqual({ sealed: `sealed(PK):${KEY.length}` }); // trimmed before sealing
    expect(JSON.stringify(sent)).not.toContain(KEY.slice(13, 40));
  });

  it("test: a not-yet-saved key is tested sealed too", async () => {
    const { sent, sender } = fake();
    const r = await sender.test(KEY);
    expect(r.title).toBe("Reached Anthropic ✓ — key rejected");
    expect(sent[1]).toEqual(["testAuthConnection", { sealed: `sealed(PK):${KEY.length}` }]);
  });

  it("a changed box identity stops the key from being sent", async () => {
    const { sent, sender, mac } = fake("mismatch");
    await expect(sender.save(KEY)).rejects.toThrow(/identity changed/);
    expect(sent.map((s) => s[0])).toEqual(["getAuth"]);
    expect(mac).toEqual([]);
  });
});

describe("dual-auth: the same key serves (through the Mac key proxy) the Bots' claude on this Mac", () => {
  it("a key the box accepted is also kept on the Mac (trimmed); Remove clears both", async () => {
    const { sender, mac, sent } = fake();
    expect(await sender.save(`  ${KEY}\n`)).toMatchObject({ macSaved: true });
    expect(mac).toEqual([`save:${KEY}`]);
    expect(await sender.hasMacCopy()).toBe(true);
    const v = await sender.remove();
    expect(v.apiKey).toBeNull();
    expect(sent.at(-1)![0]).toBe("clearApiKey");
    expect(mac.at(-1)).toBe("clear");
  });

  it("a key the box refused is not kept on the Mac", async () => {
    const { sender, mac } = fake("match", { hostRefuses: true });
    await expect(sender.save(KEY)).rejects.toThrow(/API key/);
    expect(mac).toEqual([]);
  });

  it("review fix 4: a Mac copy that can't be written is reported (macSaved false, with why), and the log never holds the key", async () => {
    const { sender, logs } = fake("match", { macThrows: true });
    const v = await sender.save(KEY);
    expect(v.apiKey?.masked).toBe("sk-ant-…9x9x");
    expect(v).toMatchObject({ macSaved: false, macError: "This Mac's permission key can't be trusted." });
    expect(logs.join("\n")).toMatch(/couldn't be saved/);
    expect(logs.join("\n")).not.toContain(KEY.slice(13, 40));
  });
});

// Review of 0c7a33f0: the panel may give up waiting on a slow Save while main's call is still running. A Remove
// pressed then must not be overtaken by that Save landing afterwards and bringing the key back: key operations run
// one at a time, in the order they were asked.
describe("key operations run one at a time", () => {
  it("a Remove asked while a Save is still running waits for it, so the key stays removed", async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const call = (async (cmd: string) => {
      log.push(`${cmd}:start`);
      if (cmd === "setApiKey") await gate;
      log.push(`${cmd}:end`);
      return cmd === "getAuth" ? view : { ...view, apiKey: cmd === "setApiKey" ? { masked: "m", savedAt: 1 } : null };
    }) as never;
    const s = createApiKeySender({ call, pin: { check: () => "match" }, seal: async () => "sealed" });
    const saving = s.save(KEY);
    await new Promise((r) => setTimeout(r, 10));
    const removing = s.remove();
    await new Promise((r) => setTimeout(r, 10));
    expect(log).not.toContain("clearApiKey:start");
    release();
    await Promise.all([saving, removing]);
    expect(log.filter((l) => l !== "getAuth:start" && l !== "getAuth:end")).toEqual(["setApiKey:start", "setApiKey:end", "clearApiKey:start", "clearApiKey:end"]);
  });

  it("a failed operation doesn't block the next one", async () => {
    const call = (async (cmd: string) => { if (cmd === "setApiKey") throw new Error("refused"); return view; }) as never;
    const s = createApiKeySender({ call, pin: { check: () => "match" }, seal: async () => "sealed" });
    await expect(s.save(KEY)).rejects.toThrow("refused");
    await expect(s.remove()).resolves.toBeTruthy();
  });
});


// Final review: a Save whose client-side limit ran out could still land on the box after a Remove queued behind it (the
// limit settled the queue early while the host kept working). The key calls have no client time limit: the queue waits
// for the host's real answer, and the panel shows its slow note meanwhile.
describe("the key sender's gateway calls have no client time limit", () => {
  it("main builds the key sender's call without timeoutMs", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
    const at = src.indexOf("apiKeySender = createApiKeySender(");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("});", at));
    expect(block).not.toMatch(/timeoutMs/);
    expect(src).not.toMatch(/AUTH_CALL_TIMEOUT_MS/);
  });
});
