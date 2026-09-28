import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateService, compareSemver, newer, parseSemver } from "../../src/main/native/updater";
import { fakeDitto } from "./updater-helpers";

const zip = Buffer.from("fake zip bytes");
const sha = crypto.createHash("sha256").update(zip).digest("hex");
// P5 review I7: every release is signed; tests use a throwaway Ed25519 keypair (the repo ships no real key).
const keys = crypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const sig = crypto.sign(null, Buffer.from(`Synapse-0.3.0-arm64.zip|0.3.0|${sha}`), keys.privateKey).toString("base64");
// GitHub's release-asset API `url` (Accept: application/octet-stream + Authorization) is the only
// path that works unauthenticated-safe on a private repo; `browser_download_url` 404s without a
// browser session. check() must resolve assets from `.url`, not `.browser_download_url`.
const release = {
  tag_name: "v0.3.0", draft: false, prerelease: false,
  assets: [
    { name: "Synapse-0.3.0-arm64.zip", url: "https://api.github.com/repos/alex/bots/releases/assets/111", browser_download_url: "https://dl/zip" },
    { name: "Synapse-0.3.0-arm64.zip.sha256", url: "https://api.github.com/repos/alex/bots/releases/assets/112", browser_download_url: "https://dl/sha" },
    { name: "Synapse-0.3.0-arm64.zip.sig", url: "https://api.github.com/repos/alex/bots/releases/assets/113", browser_download_url: "https://dl/sig" },
  ],
};
const calls: { url: string; init?: { headers?: Record<string, string> } }[] = [];
const fetchFn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
  calls.push({ url, init });
  return {
    ok: true, status: 200,
    json: async () => (url.includes("/releases?") ? [release] : release),
    text: async () => (url.endsWith("/112") ? `${sha}  Synapse-0.3.0-arm64.zip\n` : url.endsWith("/113") ? sig : ""),
    arrayBuffer: async () => (url.endsWith("/111") ? zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) : new ArrayBuffer(0)),
  };
}) as unknown as typeof fetch;

function svc(o: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const states: string[] = [];
  const s = new UpdateService({ current: "0.2.0", feed: () => "alex/bots", packaged: true, appPath: "/Applications/Bots.app", stageDir: fs.mkdtempSync(path.join(os.tmpdir(), "upd-")), fetchFn, run: fakeDitto("0.3.0"), emit: (st) => states.push(st.status), publicKey, verifySignature: async () => {}, ...o });
  return { s, states };
}

describe("updates (SET-12)", () => {
  beforeEach(() => { calls.length = 0; });

  it("compares versions", () => {
    expect(newer("v0.3.0", "0.2.9")).toBe(true);
    expect(newer("0.2.0", "0.2.0")).toBe(false);
    expect(newer("0.10.0", "0.9.9")).toBe(true);
  });

  // Release updates: proper semver, not a naive split on dots.
  it("compares semver properly: numeric parts, pre-releases, build metadata, garbage", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.10.0", "1.9.99")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("0.1.10", "0.1.9")).toBeGreaterThan(0);
    // A pre-release sorts before its release, and pre-release identifiers compare per semver 2.0.0 §11.
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 1; i < order.length; i++) expect(compareSemver(order[i]!, order[i - 1]!), `${order[i]} > ${order[i - 1]}`).toBeGreaterThan(0);
    expect(compareSemver("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareSemver("v1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(newer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(newer("1.0.0-rc.1", "1.0.0")).toBe(false);
    // Garbage is never "newer", in either position.
    for (const bad of ["0.3", "1.2.3.4", "01.2.3", "latest", "", "1.2.x", "v1.2.3; rm -rf ~"]) {
      expect(parseSemver(bad), bad).toBeNull();
      expect(newer(bad, "0.0.1"), bad).toBe(false);
      expect(newer("9.9.9", bad), bad).toBe(false);
    }
  });

  it("no feed or a dev build → Check for Updates only", async () => {
    expect((await svc({ feed: () => null }).s.check()).status).toBe("no-feed");
    expect((await svc({ packaged: false }).s.check()).status).toBe("no-feed");
  });

  it("finds a newer release, downloads, verifies sha256 and becomes ready", async () => {
    const { s, states } = svc();
    expect((await s.check()).status).toBe("available");
    const st = await s.download();
    expect(st).toMatchObject({ status: "ready", latest: "0.3.0" });
    expect(states).toEqual(expect.arrayContaining(["checking", "available", "downloading", "ready"]));
  });

  it("rejects a download whose checksum doesn't match", async () => {
    const bad = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes("/releases?") ? [release] : release), text: async () => "0".repeat(64), arrayBuffer: async () => new ArrayBuffer(3) })) as unknown as typeof fetch;
    const { s } = svc({ fetchFn: bad });
    await s.check();
    expect((await s.download()).status).toBe("error");
  });

  // Fix round 1, finding 1: the update feed is the user's PRIVATE GitHub repo (public is
  // forbidden by the rulings), so an unauthenticated releases/latest call 404s against the real
  // feed. check() must send `Authorization: Bearer <token>` when a token is configured.
  it("sends an Authorization header on the releases/latest check when a token is configured", async () => {
    const { s } = svc({ token: () => "gh-token-abc" });
    await s.check();
    const call = calls.find((c) => c.url.startsWith("https://api.github.com/repos/alex/bots/releases?"));
    expect(call?.init?.headers?.authorization).toBe("Bearer gh-token-abc");
  });

  it("omits the Authorization header when no token is configured", async () => {
    const { s } = svc();
    await s.check();
    const call = calls.find((c) => c.url.startsWith("https://api.github.com/repos/alex/bots/releases?"));
    expect(call?.init?.headers?.authorization).toBeUndefined();
  });

  // A bare `browser_download_url` also 404s unauthenticated on a private repo, so download() must
  // use the asset API `url` (Accept: application/octet-stream) with the same bearer token.
  it("downloads assets from the asset API url with Accept: application/octet-stream and the token", async () => {
    const { s } = svc({ token: () => "gh-token-abc" });
    await s.check();
    await s.download();
    const zipCall = calls.find((c) => c.url === "https://api.github.com/repos/alex/bots/releases/assets/111");
    const shaCall = calls.find((c) => c.url === "https://api.github.com/repos/alex/bots/releases/assets/112");
    expect(zipCall?.init?.headers).toMatchObject({ accept: "application/octet-stream", authorization: "Bearer gh-token-abc" });
    expect(shaCall?.init?.headers).toMatchObject({ accept: "application/octet-stream", authorization: "Bearer gh-token-abc" });
    expect(calls.some((c) => c.url === "https://dl/zip" || c.url === "https://dl/sha")).toBe(false);
  });

  it("the swap script waits for the app to quit, replaces the bundle, clears quarantine and relaunches", async () => {
    const { s } = svc();
    await s.check();
    await s.download();
    // I8: the paths are argv ($1 pid, $2 app, $3 staged), never interpolated into the script.
    const script = s.swapScript();
    expect(script).toContain('while kill -0 "$pid"');
    // Atomic swap: the new bundle is copied beside the old one, then renamed into place.
    expect(script).toContain('ditto "$staged" "$app.new"');
    expect(script).toContain('mv "$app.new" "$app"');
    expect(script).toContain('xattr -dr com.apple.quarantine "$app"');
    expect(script).toContain('open "$app"');
    expect(s.swapArgs(4242).slice(0, 2)).toEqual(["4242", "/Applications/Bots.app"]);
  });
});
