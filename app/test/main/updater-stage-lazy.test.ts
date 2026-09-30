import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerUpdater, UpdateService, type UpdateState } from "../../src/main/native/updater";
import { fakeDitto } from "./updater-helpers";

// Bug 443: every launch made an empty `synapse-update-*` folder in the temp folder at startup and never removed it.
// The stage folder is now made on the first download, removed after a failed one and on quit, and kept only while
// the swap script is using it.

const keys = crypto.generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const zip = Buffer.from("zip-bytes");
const digest = crypto.createHash("sha256").update(zip).digest("hex");
const release = (bytes = zip) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-lazy-"));
  fs.writeFileSync(path.join(dir, "Synapse-0.3.0-arm64.zip"), bytes);
  const sig = crypto.sign(null, Buffer.from(`Synapse-0.3.0-arm64.zip|0.3.0|${digest}`), keys.privateKey).toString("base64");
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ name: "Synapse", version: "0.3.0", zip: "Synapse-0.3.0-arm64.zip", sha256: digest, sig, hostBuild: "0123456789abcdef", createdAt: 1 }));
  return dir;
};
const made: string[] = [];
const lazy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "upd-lazy-")); made.push(d); return d; };
const svc = (folder: string, o: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) => new UpdateService({
  current: "0.2.0", feed: () => null, folder: () => folder, packaged: true, appPath: "/Applications/Bots.app", markerDir: fs.mkdtempSync(path.join(os.tmpdir(), "upd-mark-")),
  stageDir: lazy, run: fakeDitto("0.3.0"), emit: () => {}, publicKey: pub, verifySignature: async () => {}, ...o,
});
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("the update stage folder (bug 443)", () => {
  it("is not made at launch: registering the updater and checking leaves the temp folder untouched", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upd-launch-"));
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "upd-ud-"));
    const was = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const quit: (() => void)[] = [];
      const emitted: UpdateState[] = [];
      const app = { getVersion: () => "0.2.0", isPackaged: false, getPath: (n: string) => (n === "exe" ? "/Applications/Synapse.app/Contents/MacOS/Synapse" : ud), quit: () => {}, on: (ev: string, fn: () => void) => { if (ev === "will-quit") quit.push(fn); } } as unknown as Electron.App;
      registerUpdater({ app, feed: () => "a/b", auto: () => false, setAuto: () => {} }, () => {}, (_c, p) => emitted.push(p as UpdateState));
      await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(0));
      expect(fs.readdirSync(tmp)).toEqual([]);
      expect(quit).toHaveLength(1);
      quit[0]!();
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(ud, { recursive: true, force: true });
    }
  });

  it("is made on the first download, and removed on quit when the update was never installed", async () => {
    const s = svc(release());
    expect(made).toEqual([]);
    await s.check();
    expect(made).toEqual([]);
    expect((await s.download()).status).toBe("ready");
    expect(made).toHaveLength(1);
    expect(fs.existsSync(made[0]!)).toBe(true);
    s.dispose();
    expect(fs.existsSync(made[0]!)).toBe(false);
  });

  it("is removed after a failed download", async () => {
    const s = svc(release(Buffer.from("tampered")));
    await s.check();
    expect((await s.download()).status).toBe("error");
    expect(made).toHaveLength(1);
    expect(fs.existsSync(made[0]!)).toBe(false);
  });

  it("stays while the swap script is installing from it", async () => {
    const s = svc(release());
    await s.check();
    await s.download();
    const spawn = vi.spyOn(s as unknown as { swapScript(): string }, "swapScript").mockReturnValue("exit 0");
    s.restart(999_999);
    s.dispose();
    expect(fs.existsSync(made[0]!)).toBe(true);
    spawn.mockRestore();
  });

  it("a caller's own folder (a plain path) is never removed", async () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), "upd-own-"));
    const s = svc(release(Buffer.from("tampered")), { stageDir: own });
    await s.check();
    await s.download();
    s.dispose();
    expect(fs.existsSync(own)).toBe(true);
    fs.rmSync(own, { recursive: true, force: true });
  });
});
