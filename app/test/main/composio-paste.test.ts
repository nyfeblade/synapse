import { describe, expect, it, vi } from "vitest";
import { pasteComposioKey, registerComposioPaste } from "../../src/main/native/composio-paste";

describe("Composio Paste key (main process)", () => {
  it("reads the clipboard only on the click, sends it straight to the host and returns no key", async () => {
    const readClipboard = vi.fn(() => "ak_test_example_key_123");
    const sent: unknown[] = [];
    const call = vi.fn(async (cmd: string, args: unknown) => { sent.push([cmd, args]); return { keySet: true, disclosureAccepted: false, apps: [] }; });
    const handlers = new Map<string, (a: unknown) => unknown>();
    registerComposioPaste({ reg: (n, fn) => handlers.set(n, fn), readClipboard, call: () => call as never });
    expect(readClipboard).not.toHaveBeenCalled();
    const r = await handlers.get("composio.pasteKey")!({});
    expect(readClipboard).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([["setComposioKey", { key: "ak_test_example_key_123" }]]);
    expect(JSON.stringify(r)).not.toContain("ak_test_example_key_123");
  });

  it("says so when the host isn't connected, without reading the clipboard", async () => {
    const readClipboard = vi.fn(() => "x");
    await expect(pasteComposioKey({ readClipboard, call: () => null })).rejects.toThrow("isn't connected");
    expect(readClipboard).not.toHaveBeenCalled();
  });
});
