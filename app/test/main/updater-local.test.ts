import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkDesignatedRequirement, UpdateService } from "../../src/main/native/updater";
import { fakeDitto } from "./updater-helpers";

function folderWith(manifest: Record<string, unknown> | null, zipBytes = Buffer.from("zip-bytes")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-"));
  fs.writeFileSync(path.join(dir, "Synapse-0.3.0-arm64.zip"), zipBytes);
  if (manifest) fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(manifest));
  return dir;
}
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
// Release updates: the local folder's build is Ed25519-signed too (release.mjs), verified against the embedded key.
const keys = crypto.generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const sigFor = (name: string, version: string, digest: string, key = keys.privateKey) => crypto.sign(null, Buffer.from(`${name}|${version}|${digest}`), key).toString("base64");
const good = { name: "Synapse", version: "0.3.0", zip: "Synapse-0.3.0-arm64.zip", sha256: sha(Buffer.from("zip-bytes")), sig: sigFor("Synapse-0.3.0-arm64.zip", "0.3.0", sha(Buffer.from("zip-bytes"))), hostBuild: "0123456789abcdef", createdAt: 1 };

function svc(folder: string, o: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const verifySignature = vi.fn(async () => {});
  const s = new UpdateService({
    current: "0.2.0", feed: () => null, folder: () => folder, packaged: true, appPath: "/Applications/Bots.app",
    stageDir: fs.mkdtempSync(path.join(os.tmpdir(), "upd-")), run: fakeDitto("0.3.0"), emit: () => {}, publicKey: pub, verifySignature, ...o,
  });
  return { s, verifySignature };
}

describe("updates from the local release folder", () => {
  it("offers a newer build with no GitHub feed, and checks its update signature and code signature before it is ready", async () => {
    const { s, verifySignature } = svc(folderWith(good));
    expect((await s.check()).status).toBe("available");
    expect(s.state().latest).toBe("0.3.0");
    expect((await s.download()).status).toBe("ready");
    expect(verifySignature).toHaveBeenCalledWith(expect.stringMatching(/Bots\.app$/));
  });

  it("refuses a build whose signature doesn't match ours", async () => {
    const { s } = svc(folderWith(good), { verifySignature: async () => { throw new Error("not signed by Synapse Local Signing"); } });
    await s.check();
    const st = await s.download();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/Synapse Local Signing/);
    expect(s.swapArgs(1)[2]).toBe("");
  });

  it("refuses a zip that doesn't match the manifest's checksum", async () => {
    const { s } = svc(folderWith(good, Buffer.from("tampered")));
    await s.check();
    expect((await s.download()).error).toMatch(/checksum/);
  });

  it("a tampered zip whose manifest checksum was rewritten to match is refused by the signature, before ditto", async () => {
    const evil = Buffer.from("evil-bytes");
    const run = fakeDitto("0.3.0");
    const { s, verifySignature } = svc(folderWith({ ...good, sha256: sha(evil) }, evil), { run });
    await s.check();
    const st = await s.download();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/signature didn't verify/);
    expect(run).not.toHaveBeenCalled();
    expect(verifySignature).not.toHaveBeenCalled();
  });

  it("a build with no signature is refused, with a clear error", async () => {
    const { sig: _drop, ...unsigned } = good;
    const run = fakeDitto("0.3.0");
    const { s } = svc(folderWith(unsigned), { run });
    await s.check();
    const st = await s.download();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/isn't signed/);
    expect(run).not.toHaveBeenCalled();
  });

  it("a build signed with another key, or for another version, is refused", async () => {
    const other = crypto.generateKeyPairSync("ed25519").privateKey;
    for (const sig of [sigFor(good.zip, "0.3.0", good.sha256, other), sigFor(good.zip, "0.2.9", good.sha256), "AAAA"]) {
      const run = fakeDitto("0.3.0");
      const { s } = svc(folderWith({ ...good, sig }), { run });
      await s.check();
      expect((await s.download()).status).toBe("error");
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("takes the signature from <zip>.sig beside the zip when latest.json has none", async () => {
    const { sig, ...unsigned } = good;
    const dir = folderWith(unsigned);
    fs.writeFileSync(path.join(dir, `${good.zip}.sig`), `${sig}\n`);
    const { s } = svc(dir);
    await s.check();
    expect((await s.download()).status).toBe("ready");
  });

  it("with no update key embedded, a local build is not installed", async () => {
    const run = fakeDitto("0.3.0");
    const { s } = svc(folderWith(good), { publicKey: null, run });
    await s.check();
    const st = await s.download();
    expect(st.status).toBe("not-configured");
    expect(run).not.toHaveBeenCalled();
  });

  it("says up to date for the same version, and rejects a manifest pointing outside the folder", async () => {
    expect((await svc(folderWith({ ...good, version: "0.2.0" })).s.check()).status).toBe("none");
    expect((await svc(folderWith({ ...good, zip: "../evil.zip" })).s.check()).status).toBe("error");
    expect((await svc(folderWith(null)).s.check()).status).toBe("no-feed");
  });
});

describe("designated requirement check", () => {
  const DR = 'designated => identifier "com.nyfeblade.synapse" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"';
  it("verifies the new build against the running app's own requirement", async () => {
    const calls: string[][] = [];
    const codesign = async (args: string[]) => { calls.push(args); return args[0] === "-d" ? { code: 0, stdout: `${DR}\n`, stderr: "Executable=/x" } : { code: 0, stdout: "", stderr: "" }; };
    await checkDesignatedRequirement({ current: "/Applications/Synapse.app", staged: "/tmp/s/Synapse.app", codesign });
    expect(calls[1]).toEqual(["--verify", "--deep", "--strict", `-R=${DR.replace("designated => ", "")}`, "/tmp/s/Synapse.app"]);
  });

  it("refuses when the new build fails it, and when the running app is ad hoc", async () => {
    const fails = async (args: string[]) => (args[0] === "-d" ? { code: 0, stdout: DR, stderr: "" } : { code: 3, stdout: "", stderr: "test-requirement: code failed to satisfy specified code requirement(s)" });
    await expect(checkDesignatedRequirement({ current: "/a", staged: "/b", codesign: fails })).rejects.toThrow(/Synapse Local Signing/);
    const adhoc = async () => ({ code: 0, stdout: 'designated => cdhash H"abcdef"', stderr: "" });
    await expect(checkDesignatedRequirement({ current: "/a", staged: "/b", codesign: adhoc })).rejects.toThrow(/ad hoc/);
  });
});

describe("swap script: atomic swap, health check, rollback", () => {
  function sandbox(healthy: boolean) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "swap-"));
    const bin = path.join(d, "bin");
    fs.mkdirSync(bin);
    const app = path.join(d, "Synapse.app");
    const staged = path.join(d, "staged", "Synapse.app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "v"), "old");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "v"), "new");
    const marker = path.join(d, "healthy-0.3.0");
    const rolled = path.join(d, "rolled-back.json");
    const opened = path.join(d, "opened.log");
    const w = (n: string, body: string) => fs.writeFileSync(path.join(bin, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    w("ditto", 'cp -R "$1" "$2"');
    w("xattr", "exit 0");
    w("pkill", "exit 0");
    w("open", `echo "$(cat "$1/v")" >> "${opened}"; ${healthy ? `[ "$(cat "$1/v")" = new ] && touch "${marker}"` : "true"}`);
    return { d, bin, app, staged, marker, rolled, opened };
  }
  const script = () => new UpdateService({ current: "0.2.0", feed: () => null, packaged: true, appPath: "/x", stageDir: os.tmpdir(), emit: () => {} }).swapScript();

  it("swaps in the new build and keeps it when it reports healthy", () => {
    const b = sandbox(true);
    const f = path.join(b.d, "swap.sh");
    fs.writeFileSync(f, script());
    execFileSync("/bin/sh", [f, "999999", b.app, b.staged, b.marker, b.rolled, "3"], { env: { ...process.env, PATH: `${b.bin}:/usr/bin:/bin` } });
    expect(fs.readFileSync(path.join(b.app, "v"), "utf8")).toBe("new");
    expect(fs.existsSync(`${b.app}.old`)).toBe(false);
    expect(fs.existsSync(b.rolled)).toBe(false);
  });

  it("rolls back to the old build when the new one never reports healthy", () => {
    const b = sandbox(false);
    const f = path.join(b.d, "swap.sh");
    fs.writeFileSync(f, script());
    try { execFileSync("/bin/sh", [f, "999999", b.app, b.staged, b.marker, b.rolled, "2"], { env: { ...process.env, PATH: `${b.bin}:/usr/bin:/bin` } }); } catch { /* exits 3 on rollback */ }
    expect(fs.readFileSync(path.join(b.app, "v"), "utf8")).toBe("old");
    expect(fs.readFileSync(b.opened, "utf8").split("\n").filter(Boolean)).toEqual(["new", "old"]);
    expect(fs.existsSync(b.rolled)).toBe(true);
  });
});
