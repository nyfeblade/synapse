import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UpdateService, validFeed } from "../../src/main/native/updater";
import { UPDATE_PUBLIC_KEY } from "../../src/main/native/update-public-key";
import { fakeDitto } from "./updater-helpers";

// P5 review I7/I8: a pinned Ed25519 public key; a detached signature over the zip is verified before ditto/swap;
// the tag must be a plain version; the swap script takes its paths as argv. Tests use a throwaway keypair.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
const zip = Buffer.from("fake zip bytes");
const sha = crypto.createHash("sha256").update(zip).digest("hex");
// Final secfix item 11: the signature covers "name|version|sha256", not the raw zip.
const signed = (name: string, version: string, digest = sha, key = privateKey) => crypto.sign(null, Buffer.from(`${name}|${version}|${digest}`), key).toString("base64");
const goodSig = signed("Synapse-0.3.0-arm64.zip", "0.3.0");

function feedWith(o: { tag?: string; sig?: string | null } = {}) {
  const assets = [
    { name: "Synapse-0.3.0-arm64.zip", url: "https://api/a/1", browser_download_url: "x" },
    { name: "Synapse-0.3.0-arm64.zip.sha256", url: "https://api/a/2", browser_download_url: "x" },
    ...(o.sig === null ? [] : [{ name: "Synapse-0.3.0-arm64.zip.sig", url: "https://api/a/3", browser_download_url: "x" }]),
  ];
  return vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => [{ tag_name: o.tag ?? "v0.3.0", draft: false, prerelease: false, assets }],
    text: async () => (url.endsWith("/2") ? `${sha}  Synapse-0.3.0-arm64.zip\n` : url.endsWith("/3") ? (o.sig ?? goodSig) : ""),
    arrayBuffer: async () => (url.endsWith("/1") ? zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) : new ArrayBuffer(0)),
  })) as unknown as typeof fetch;
}
function svc(o: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const run = fakeDitto("0.3.0");
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-sig-"));
  const s = new UpdateService({ current: "0.2.0", feed: () => "alex/bots", packaged: true, appPath: "/Applications/Bots.app", stageDir, fetchFn: feedWith(), run, emit: () => {}, publicKey: pub, verifySignature: async () => {}, ...o });
  return { s, run, stageDir };
}

describe("signed updates (I7)", () => {
  it("the app build embeds a real Ed25519 public key (and never a private one)", () => {
    expect(UPDATE_PUBLIC_KEY).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/);
    expect(crypto.createPublicKey(UPDATE_PUBLIC_KEY!).asymmetricKeyType).toBe("ed25519");
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/main/native/update-public-key.ts"), "utf8");
    expect(src).not.toMatch(/PRIVATE KEY/);
  });

  it("with no key configured (publicKey: null), auto-update refuses and says so", async () => {
    const { s, run } = svc({ publicKey: null });
    const st = await s.check();
    expect(st).toMatchObject({ status: "not-configured", error: "Updates not configured" });
    expect((await s.download()).status).not.toBe("ready");
    expect(run).not.toHaveBeenCalled();
  });

  it("a release signed by the pinned key installs", async () => {
    const { s, run } = svc();
    expect((await s.check()).status).toBe("available");
    expect((await s.download()).status).toBe("ready");
    expect(run).toHaveBeenCalledWith("ditto", expect.arrayContaining(["-x", "-k"]));
  });

  it("a bad or missing signature never reaches ditto", async () => {
    const other = crypto.generateKeyPairSync("ed25519").privateKey;
    for (const sig of [signed("Synapse-0.3.0-arm64.zip", "0.3.0", sha, other), "AAAA", null]) {
      const { s, run, stageDir } = svc({ fetchFn: feedWith({ sig }) });
      await s.check();
      const st = await s.download();
      expect(st.status).toBe("error");
      expect(run).not.toHaveBeenCalled();
      expect(fs.readdirSync(stageDir)).toEqual([]);
    }
  });
});

describe("final secfix 11: signed name|version|sha256, bundle version check, no downgrades", () => {
  it("a signature over the raw zip (the old scheme) no longer installs", async () => {
    const { s, run } = svc({ fetchFn: feedWith({ sig: crypto.sign(null, zip, privateKey).toString("base64") }) });
    await s.check();
    expect((await s.download()).status).toBe("error");
    expect(run).not.toHaveBeenCalled();
  });

  it("a validly signed older release can't be replayed under a newer tag", async () => {
    for (const sig of [signed("Synapse-0.2.5-arm64.zip", "0.2.5"), signed("Synapse-0.3.0-arm64.zip", "0.2.5"), signed("Synapse-0.3.0-x64.zip", "0.3.0")]) {
      const { s, run } = svc({ fetchFn: feedWith({ sig }) });
      await s.check();
      expect((await s.download()).status).toBe("error");
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("after ditto, CFBundleShortVersionString must match the tag; otherwise nothing is staged", async () => {
    for (const v of ["0.2.9", "0.1.0", "0.3.1", ""]) {
      const run = fakeDitto(v);
      const { s } = svc({ run });
      await s.check();
      const st = await s.download();
      expect(st.status, v).toBe("error");
      expect(run).toHaveBeenCalled();
      expect(() => s.restart(1)).not.toThrow();
      expect(s.swapArgs(1)[2]).toBe("");
    }
  });

  it("refuses downgrades and same-version reinstalls", async () => {
    for (const current of ["0.3.0", "0.5.0"]) {
      const { s, run } = svc({ current });
      expect((await s.check()).status).toBe("none");
      expect((await s.download()).status).not.toBe("ready");
      expect(run).not.toHaveBeenCalled();
    }
  });
});

describe("tags, feed and the swap script (I7, I8)", () => {
  it("a release whose tag isn't a plain version is never offered", async () => {
    for (const tag of ["v0.3.0; rm -rf ~", "0.3", "v0.3.0-beta", "../../0.3.0"]) {
      const { s } = svc({ fetchFn: feedWith({ tag }) });
      const st = await s.check();
      expect(st.status, tag).not.toBe("available");
      expect(st.latest, tag).toBeNull();
    }
  });

  it("the update feed must be owner/repo", () => {
    expect(validFeed("alex/bots")).toBe(true);
    expect(validFeed("alex/bots/../../x")).toBe(false);
    expect(validFeed("https://evil/x")).toBe(false);
    expect(validFeed("a b/c")).toBe(false);
  });

  it("the swap script takes pid and paths as argv, never interpolated", async () => {
    const appPath = "/Applications/Bots$(touch /tmp/pwned).app";
    const { s } = svc({ appPath });
    await s.check();
    await s.download();
    const script = s.swapScript();
    expect(script).not.toContain("Applications");
    expect(script).not.toContain("pwned");
    expect(script).toContain('"$2"');
    const args = s.swapArgs(4242);
    expect(args[0]).toBe("4242");
    expect(args[1]).toBe(appPath);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "swap-")), "swap.sh");
    fs.writeFileSync(f, script);
    execFileSync("sh", ["-n", f]);
  });
});
