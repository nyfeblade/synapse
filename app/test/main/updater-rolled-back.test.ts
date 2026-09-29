import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UpdateService, markHealthy, skippedVersion, updateMarkerDir } from "../../src/main/native/updater";
import { fakeDitto } from "./updater-helpers";

/**
 * Pre-release review: a version the swap script rolled back must not be offered (or downloaded) again at once, and
 * the rollback message must stay on screen, until a newer version is out.
 */
const keys = crypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const zip = Buffer.from("zip");
const sha = crypto.createHash("sha256").update(zip).digest("hex");
function feedWith(versions: string[]) {
  return vi.fn(async (url: string) => {
    const v = /assets\/(\d+\.\d+\.\d+)\//.exec(url)?.[1];
    return {
      ok: true, status: 200,
      json: async () => versions.map((x) => ({ tag_name: `v${x}`, draft: false, assets: ["", ".sha256", ".sig"].map((s) => ({ name: `Synapse-${x}-arm64.zip${s}`, url: `https://api.github.com/assets/${x}/${s || "zip"}` })) })),
      text: async () => (url.endsWith(".sha256") ? sha : url.endsWith(".sig") ? crypto.sign(null, Buffer.from(`Synapse-${v}-arm64.zip|${v}|${sha}`), keys.privateKey).toString("base64") : ""),
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length),
    };
  }) as unknown as typeof fetch;
}
function svc(versions: string[], skipped: string | null) {
  const fetchFn = feedWith(versions);
  const s = new UpdateService({ current: "0.2.0", feed: () => "alex/bots", packaged: true, appPath: "/Applications/Bots.app", stageDir: fs.mkdtempSync(path.join(os.tmpdir(), "upd-")),
    fetchFn, run: fakeDitto(versions[0]!), emit: () => {}, publicKey, verifySignature: async () => {}, skipped: () => skipped });
  return { s, fetchFn };
}

describe("a rolled-back version", () => {
  it("isn't offered again, and the rollback message stays", async () => {
    const { s, fetchFn } = svc(["0.3.0"], "0.3.0");
    s.noteRolledBack("0.3.0");
    const st = await s.check();
    expect(st.status).not.toBe("available");
    expect(st.error).toMatch(/0\.3\.0 didn't start correctly/);
    const after = await s.download();
    expect(after.status).not.toBe("ready");
    expect((fetchFn as unknown as { mock: { calls: [string][] } }).mock.calls.some(([u]) => u.includes("/zip"))).toBe(false);
  });

  it("a newer version is offered as usual", async () => {
    const { s } = svc(["0.3.1", "0.3.0"], "0.3.0");
    expect((await s.check()).status).toBe("available");
    expect((await s.download()).status).toBe("ready");
  });
});

describe("the swap script and markHealthy carry the failed version", () => {
  it("the swap script writes the version it rolled back; markHealthy returns it and remembers it", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "swap-"));
    const bin = path.join(d, "bin"); fs.mkdirSync(bin);
    const app = path.join(d, "Synapse.app"); fs.mkdirSync(app); fs.writeFileSync(path.join(app, "v"), "old");
    const staged = path.join(d, "staged", "Synapse.app"); fs.mkdirSync(staged, { recursive: true }); fs.writeFileSync(path.join(staged, "v"), "new");
    for (const n of ["xattr", "pkill", "open"]) fs.writeFileSync(path.join(bin, n), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "ditto"), '#!/bin/sh\ncp -R "$1" "$2"\n', { mode: 0o755 });
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "ud-"));
    const dir = updateMarkerDir(ud); fs.mkdirSync(dir, { recursive: true });
    const rolled = path.join(dir, "rolled-back.json");
    const f = path.join(d, "swap.sh");
    fs.writeFileSync(f, new UpdateService({ current: "0.2.0", feed: () => null, packaged: true, appPath: "/x", stageDir: d, emit: () => {} }).swapScript());
    try { execFileSync("/bin/sh", [f, "999999", app, staged, path.join(dir, "healthy-0.3.0"), rolled, "1", "0.3.0"], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } }); } catch { /* exits 3 */ }
    expect(JSON.parse(fs.readFileSync(rolled, "utf8")).version).toBe("0.3.0");
    // Known before the window is even up: the launch check must already skip it.
    expect(skippedVersion(ud)).toBe("0.3.0");
    expect(markHealthy(ud, "0.2.0")).toEqual({ rolledBack: true, version: "0.3.0" });
    expect(skippedVersion(ud)).toBe("0.3.0");
    expect(markHealthy(ud, "0.2.0")).toEqual({ rolledBack: false, version: null });
  });

  it("swapArgs passes the version being installed", async () => {
    const { s } = svc(["0.3.0"], null);
    await s.check(); await s.download();
    expect(s.swapArgs(1)[6]).toBe("0.3.0");
  });
});
