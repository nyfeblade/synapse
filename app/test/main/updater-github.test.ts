import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UpdateService, releaseZipName } from "../../src/main/native/updater";
import { fakeDitto } from "./updater-helpers";

// Release updates: the GitHub feed. Throwaway Ed25519 keypair; no network.
const keys = crypto.generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const zipBytes = Buffer.from("the real 0.3.0 zip");
const shaOf = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const sign = (name: string, version: string, sha: string) => crypto.sign(null, Buffer.from(`${name}|${version}|${sha}`), keys.privateKey).toString("base64");

type Asset = { name: string; url: string; browser_download_url: string };
type Rel = { tag_name: string; draft?: boolean; prerelease?: boolean; assets: Asset[] };
const asset = (name: string, id: string): Asset => ({ name, url: `https://api.github.com/repos/o/r/releases/assets/${id}`, browser_download_url: `https://github.com/o/r/releases/download/${name}` });

/** A release with the canonical Synapse assets (ids z/h/s = zip, sha256, sig) plus decoys. */
function rel(v: string, o: { draft?: boolean; prerelease?: boolean; sig?: boolean; extra?: Asset[] } = {}): Rel {
  const zip = releaseZipName(v);
  return {
    tag_name: `v${v}`, draft: !!o.draft, prerelease: !!o.prerelease,
    assets: [
      ...(o.extra ?? []),
      asset(zip, `${v}-z`), asset(`${zip}.sha256`, `${v}-h`),
      ...(o.sig === false ? [] : [asset(`${zip}.sig`, `${v}-s`)]),
    ],
  };
}

function feed(releases: Rel[], o: { zip?: Buffer; sha?: string; sig?: string; status?: number; headers?: Record<string, string>; throws?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (o.throws) throw new TypeError("fetch failed");
    const status = url.includes("/releases?") ? (o.status ?? 200) : 200;
    const id = url.split("/").pop()!;
    const v = id.replace(/-[zhs]$/, "");
    const bytes = o.zip ?? zipBytes;
    const sha = o.sha ?? shaOf(bytes);
    return {
      ok: status >= 200 && status < 300, status,
      headers: new Headers(o.headers ?? {}),
      json: async () => releases,
      text: async () => (id.endsWith("-h") ? `${sha}  ${releaseZipName(v)}\n` : id.endsWith("-s") ? (o.sig ?? sign(releaseZipName(v), v, shaOf(zipBytes))) : ""),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function svc(fetchFn: typeof fetch, o: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const run = fakeDitto("0.3.0", "Synapse.app");
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "upd-gh-"));
  const s = new UpdateService({ current: "0.2.0", feed: () => "o/r", packaged: true, appPath: "/Applications/Synapse.app", stageDir, fetchFn, run, emit: () => {}, publicKey: pub, verifySignature: async () => {}, ...o });
  return { s, run, stageDir };
}

describe("GitHub feed: picking the release and its asset", () => {
  it("release artifacts are named Synapse-<version>-arm64", () => {
    expect(releaseZipName("1.2.3")).toBe("Synapse-1.2.3-arm64.zip");
  });

  it("picks the asset by its exact name, never a look-alike", async () => {
    const decoys = [asset("Synapse-0.3.0-arm64.dmg", "d1"), asset("Synapse-0.3.0-x64.zip", "d2"), asset("Bots-0.3.0-arm64.zip", "d3"), asset("Synapse-0.3.0-arm64.zip.zip", "d4"), asset("aaa.zip", "d5")];
    const { fn, calls } = feed([rel("0.3.0", { extra: decoys })]);
    const { s } = svc(fn);
    expect((await s.check()).status).toBe("available");
    expect((await s.download()).status).toBe("ready");
    const fetched = calls.map((c) => c.url.split("/").pop());
    expect(fetched).toEqual(expect.arrayContaining(["0.3.0-z", "0.3.0-h", "0.3.0-s"]));
    for (const d of ["d1", "d2", "d3", "d4", "d5"]) expect(fetched).not.toContain(d);
  });

  it("a release without the exact zip is not offered (no guessing at *.zip)", async () => {
    const r: Rel = { tag_name: "v0.3.0", assets: [asset("Bots-0.3.0-arm64.zip", "x"), asset("Bots-0.3.0-arm64.zip.sha256", "y")] };
    const { fn } = feed([r]);
    const st = await svc(fn).s.check();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/Synapse-0\.3\.0-arm64\.zip/);
  });

  it("skips drafts, tolerates the prerelease flag, and takes the highest version", async () => {
    const { fn } = feed([rel("0.5.0", { draft: true }), rel("0.3.0", { prerelease: true }), rel("0.2.5"), rel("0.10.0-beta.1" as string)]);
    const st = await svc(fn).s.check();
    expect(st).toMatchObject({ status: "available", latest: "0.3.0" });
  });

  it("reads a list of releases, so a release marked prerelease is not invisible like it is to /releases/latest", async () => {
    const { fn, calls } = feed([rel("0.3.0", { prerelease: true })]);
    await svc(fn).s.check();
    expect(calls[0]!.url).toMatch(/^https:\/\/api\.github\.com\/repos\/o\/r\/releases\?per_page=\d+$/);
  });

  it("nothing newer: up to date", async () => {
    const { fn } = feed([rel("0.2.0"), rel("0.1.0")]);
    expect((await svc(fn).s.check()).status).toBe("none");
  });
});

describe("GitHub feed: public and private repos", () => {
  it("a public repo works with no token: no Authorization header anywhere, and it installs", async () => {
    const { fn, calls } = feed([rel("0.3.0")]);
    const { s } = svc(fn, { token: () => null });
    await s.check();
    expect((await s.download()).status).toBe("ready");
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) expect(c.headers.authorization).toBeUndefined();
  });

  it("a private repo sends the token on the list call and on every asset download", async () => {
    const { fn, calls } = feed([rel("0.3.0")]);
    const { s } = svc(fn, { token: () => "ghp_x" });
    await s.check();
    await s.download();
    for (const c of calls) expect(c.headers.authorization).toBe("Bearer ghp_x");
    expect(calls.filter((c) => c.url.includes("/assets/")).every((c) => c.headers.accept === "application/octet-stream")).toBe(true);
  });

  it("a private repo without a token (GitHub says 404) says a token is needed", async () => {
    const { fn } = feed([], { status: 404 });
    const st = await svc(fn, { token: () => null }).s.check();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/token/i);
  });
});

describe("GitHub feed: signatures", () => {
  it("a tampered zip (even with a matching .sha256) is refused before ditto, with a clear error", async () => {
    const tampered = Buffer.from("evil bytes");
    const { fn } = feed([rel("0.3.0")], { zip: tampered, sha: shaOf(tampered) });
    const { s, run, stageDir } = svc(fn);
    await s.check();
    const st = await s.download();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/signature/i);
    expect(run).not.toHaveBeenCalled();
    expect(fs.readdirSync(stageDir)).toEqual([]);
  });

  it("a release with no .sig is refused", async () => {
    const { fn } = feed([rel("0.3.0", { sig: false })]);
    const { s, run } = svc(fn);
    const st = await s.check();
    expect(st.status).toBe("error");
    expect(st.error).toMatch(/isn't signed/);
    expect((await s.download()).status).not.toBe("ready");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("GitHub feed: rate limits and network errors stay quiet", () => {
  const quiet = (st: { status: string; error: string | null }) => {
    expect(st.status).not.toBe("error");
    expect(st.error).toBeNull();
  };

  it("a rate limit (403 with no requests left) is not an error and retries after GitHub's reset", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const { fn } = feed([], { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    const { s } = svc(fn);
    quiet(await s.check());
    const ms = s.retryAfterMs();
    expect(ms).toBeGreaterThan(25 * 60_000);
    expect(ms).toBeLessThan(35 * 60_000);
  });

  it("a 429 or a 5xx is not an error either", async () => {
    for (const status of [429, 500, 502, 503]) {
      const { fn } = feed([], { status, headers: status === 429 ? { "retry-after": "120" } : {} });
      const { s } = svc(fn);
      quiet(await s.check());
      expect(s.retryAfterMs(), String(status)).toBeGreaterThan(0);
    }
  });

  it("no network: not an error, retry later; a success clears the retry", async () => {
    const down = feed([], { throws: true });
    const { s } = svc(down.fn);
    quiet(await s.check());
    expect(s.retryAfterMs()).toBeGreaterThan(0);
    const up = feed([rel("0.3.0")]);
    const again = svc(up.fn);
    expect((await again.s.check()).status).toBe("available");
    expect(again.s.retryAfterMs()).toBeNull();
  });

  it("a network drop mid-download is quiet too, and nothing is staged", async () => {
    const { fn } = feed([rel("0.3.0")]);
    let n = 0;
    const flaky = vi.fn(async (url: string, init?: RequestInit) => { if (url.includes("/assets/") && n++ > 0) throw new TypeError("fetch failed"); return fn(url, init); }) as unknown as typeof fetch;
    const { s, run } = svc(flaky);
    await s.check();
    quiet(await s.download());
    expect(run).not.toHaveBeenCalled();
    expect(s.retryAfterMs()).toBeGreaterThan(0);
  });
});
