import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { KeysView, KeyView } from "@synapse/shared";
import { createProviderKeySender } from "../../src/main/auth-key";
import { loadMacApiKey, MAC_API_KEY_FILE, promoteMacSpareKey, saveMacApiKey, saveMacSpareKey } from "../../src/coordinator/local-exec/mac-api-key";

/** 0.1.7: the Mac's copy of the Anthropic key follows the box's DEFAULT key across Add key, Make default and Remove. */
const A = ["sk", "ant", "api03", "A".repeat(28)].join("-");
const B = ["sk", "ant", "api03", "B".repeat(28)].join("-");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A box with Anthropic keys, answering the key commands; and the Mac's copy plus spares, as the coordinator keeps them. */
function world() {
  let keys: KeyView[] = [];
  let n = 0;
  const view = (): KeysView => ({ boxPublicKey: "PK", rings: [{ provider: "anthropic", label: "Anthropic", keys }] });
  const k = (id: string, label: string, isDefault: boolean): KeyView => ({ id, label, masked: "sk-…", savedAt: 1, isDefault, health: null, monthUsd: 0, monthRuns: 0, capUsd: null });
  const call = (async (cmd: string, a: { keyId?: string; label?: string }) => {
    if (cmd === "addKey") { const id = `k${++n}`; keys = [...keys, k(id, a.label ?? "", !keys.length)]; }
    if (cmd === "setDefaultKey") keys = keys.map((x) => ({ ...x, isDefault: x.id === a.keyId }));
    if (cmd === "removeKey") { const wasDefault = keys.find((x) => x.id === a.keyId)?.isDefault; keys = keys.filter((x) => x.id !== a.keyId); if (wasDefault && keys[0]) keys[0] = { ...keys[0], isDefault: true }; }
    return view();
  }) as never;
  const copy: { main: string | null; spares: Map<string, string> } = { main: null, spares: new Map() };
  const mac = {
    save: async (key: string) => { copy.main = key; return { ok: true }; },
    clear: async () => { copy.main = null; },
    saveSpare: async (id: string, key: string) => { copy.spares.set(id, key); },
    dropSpare: async (id: string) => { copy.spares.delete(id); },
    promote: async (id: string, oldId: string | null) => {
      const next = copy.spares.get(id) ?? null;
      if (copy.main && oldId) copy.spares.set(oldId, copy.main);
      copy.main = next; copy.spares.delete(id);
      return !!next;
    },
  };
  const sender = createProviderKeySender({ call, pin: { check: () => "match" }, seal: async (_pk, v) => `sealed:${v.length}`, mac });
  return { sender, copy, keys: () => keys };
}

describe("the Mac's copy follows the default Anthropic key", () => {
  it("the first key becomes the copy, a second waits as a spare; Make default moves the copy; Remove follows the next default", async () => {
    const w = world();
    await w.sender.addKey("anthropic", A, "Personal");
    await w.sender.addKey("anthropic", B, "Work");
    expect(w.copy.main).toBe(A);
    expect([...w.copy.spares]).toEqual([["k2", B]]);
    await w.sender.makeDefault("anthropic", "k2");
    expect(w.copy.main).toBe(B);
    expect([...w.copy.spares]).toEqual([["k1", A]]); // the old default is still the owner's key: kept to move back to
    await w.sender.removeKey("anthropic", "k2"); // the default goes: the copy follows the next default
    expect(w.copy.main).toBe(A);
    expect(w.copy.spares.size).toBe(0);
    await w.sender.removeKey("anthropic", "k1"); // none left: no copy
    expect(w.copy.main).toBeNull();
  });

  it("removing a key that isn't the default drops only its spare; other providers never touch the copy", async () => {
    const w = world();
    await w.sender.addKey("anthropic", A, "Personal");
    await w.sender.addKey("anthropic", B, "Work");
    await w.sender.removeKey("anthropic", "k2");
    expect(w.copy.main).toBe(A);
    expect(w.copy.spares.size).toBe(0);
  });
});

describe("the coordinator's spares on disk", () => {
  it("promote seals the spare in as the copy (0600) and keeps the old copy as a spare; with no spare the copy is cleared", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-spare-"));
    dirs.push(dir);
    const pk = randomBytes(32);
    saveMacApiKey(dir, pk, A);
    saveMacSpareKey(dir, pk, "k2", B);
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toContain("BBBBBBBB");
    expect(promoteMacSpareKey(dir, pk, "k2", "k1")).toBe(true);
    expect(loadMacApiKey(dir, pk)).toBe(B);
    expect(fs.statSync(path.join(dir, MAC_API_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(promoteMacSpareKey(dir, pk, "k1", null)).toBe(true); // back to A; B (removed) isn't kept
    expect(loadMacApiKey(dir, pk)).toBe(A);
    expect(fs.readdirSync(dir).sort()).toEqual([MAC_API_KEY_FILE]);
    expect(promoteMacSpareKey(dir, pk, "k9", null)).toBe(false); // added on another Mac: no copy rather than a wrong one
    expect(loadMacApiKey(dir, pk)).toBeNull();
    expect(() => saveMacSpareKey(dir, pk, "../x", A)).toThrow();
  });
});
