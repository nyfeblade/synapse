import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// GC-15: loadOrCreateBoxKeyPair persists the host's X25519 identity (box-keypair.json), whose
// public half the Mac TOFU-pins. A crash/power-loss mid-write must never leave a truncated file
// behind, so the write goes through the repo's writeJsonAtomic (tmp + fsync + rename) — the same
// helper vault.ts already uses for the secrets cache — not a plain fs.writeFileSync.
vi.mock("../../util/atomic-json", () => ({
  writeJsonAtomic: vi.fn(),
  readJson: vi.fn(),
}));

const { writeJsonAtomic } = await import("../../util/atomic-json");
const { loadOrCreateBoxKeyPair } = await import("../../secrets/crypto");

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "crypto-"));

describe("loadOrCreateBoxKeyPair persists via writeJsonAtomic (GC-15)", () => {
  it("calls writeJsonAtomic(file, keyPair, 0o600) instead of writing the file itself", async () => {
    const d = dir();
    const kp = await loadOrCreateBoxKeyPair(d);
    expect(writeJsonAtomic).toHaveBeenCalledTimes(1);
    const [file, value, mode] = vi.mocked(writeJsonAtomic).mock.calls[0]!;
    expect(file).toBe(path.join(d, "box-keypair.json"));
    expect(value).toEqual(kp);
    expect(mode).toBe(0o600);
    // Because writeJsonAtomic is mocked to a no-op, the real file must NOT exist — proving
    // loadOrCreateBoxKeyPair no longer writes it directly with fs.writeFileSync.
    expect(fs.existsSync(path.join(d, "box-keypair.json"))).toBe(false);
  });
});
