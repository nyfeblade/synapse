import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadOrCreateBoxKeyPair, sealTo } from "../../secrets/crypto";
import { SecretVault, validateSecretName } from "../../secrets/vault";
import { log } from "../../util/log";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));

describe("validateSecretName (SEC-05, security fix I3)", () => {
  const FORMAT = "Secret names use capital letters, digits and underscores, start with a letter, and are at most 64 characters (like STRIPE_KEY).";
  it.each([
    ["STRIPE_KEY", null], ["A1", null], ["X".repeat(64), null], ["HTTPX_TOKEN", null],
    ["_x1", FORMAT], ["1ABC", FORMAT], ["MY-KEY", FORMAT], ["lower_key", FORMAT], ["https_proxy", FORMAT], ["X".repeat(65), FORMAT],
    ["PATH", "PATH is reserved."], ["DISPLAY", "DISPLAY is reserved."], ["BASH_ENV", "BASH_ENV is reserved."], ["HTTP_PROXY", "HTTP_PROXY is reserved."],
    ["HTTPS_PROXY", "HTTPS_PROXY is reserved."], ["ALL_PROXY", "ALL_PROXY is reserved."], ["NO_PROXY", "NO_PROXY is reserved."], ["ENV", "ENV is reserved."],
    ["PROMPT_COMMAND", "PROMPT_COMMAND is reserved."], ["LESSOPEN", "LESSOPEN is reserved."], ["XAUTHORITY", "XAUTHORITY is reserved."], ["IFS", "IFS is reserved."],
    ["CLAUDE_TOKEN", "Names starting with CLAUDE_ are reserved."], ["BOT_X", "Names starting with BOT_ are reserved."],
    ["GIT_CONFIG_COUNT", "Names starting with GIT_ are reserved."], ["GIT_EXTERNAL_DIFF", "Names starting with GIT_ are reserved."],
    ["NODE_OPTIONS", "Names starting with NODE_ are reserved."], ["LD_PRELOAD", "Names starting with LD_ are reserved."], ["DYLD_INSERT_LIBRARIES", "Names starting with DYLD_ are reserved."],
    ["PYTHONPATH", "Names starting with PYTHON are reserved."], ["PERL5OPT", "Names starting with PERL are reserved."], ["RUBYOPT", "Names starting with RUBY are reserved."],
    ["NPM_CONFIG_PREFIX", "Names starting with NPM_CONFIG_ are reserved."], ["SSL_CERT_FILE", "Names starting with SSL_ are reserved."],
    ["ENABLE_TOOL_SEARCH", "Names starting with ENABLE_ are reserved."], ["MCP_TIMEOUT", "Names starting with MCP_ are reserved."],
  ])("%s → %s", (n, want) => expect(validateSecretName(n)).toBe(want));

  it.each([
    "GCONV_PATH", "OPENSSL_CONF", "JDK_JAVA_OPTIONS", "GLIBC_TUNABLES", "LESSCLOSE", "CDPATH", "BROWSER", "MANPAGER", "SYSTEMD_PAGER",
    "SSH_ASKPASS", "SUDO_ASKPASS", "HOSTALIASES", "LOCPATH", "NLSPATH", "MALLOC_CONF", "RUSTC_WRAPPER", "GOFLAGS", "PS1", "HISTFILE", "WGETRC",
    "YARN_RC_FILENAME", "PIP_INDEX_URL", "GEM_HOME", "CARGO_HOME", "GOPROXY", "GOPATH", "GOROOT", "GOTOOLCHAIN", "GOENV", "CGO_CFLAGS",
    // the suffix rule
    "FOO_PATH", "MY_OPTIONS", "APP_OPTS", "TOOL_CONF", "SOME_CONFIG", "XPAGER", "MYASKPASS", "CC_WRAPPER", "BUILD_FLAGS", "INPUTRC",
  ])("%s is rejected (security re-review item 8)", (n) => expect(validateSecretName(n)).toMatch(/reserved/));

  it.each(["DATABASE_URL", "STRIPE_KEY", "GOOGLE_API_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "SLACK_BOT_TOKEN"])(
    "%s still passes", (n) => expect(validateSecretName(n)).toBeNull());
});

describe("SecretVault (ORIG-12)", () => {
  it("creates the key pair and a 0400 vault key once, and stores only ciphertext", async () => {
    const d = dir();
    const v = await SecretVault.open({ hostPrivate: d, now: () => 42 });
    expect(fs.statSync(path.join(d, "vault.key")).mode & 0o777).toBe(0o400);
    expect((await SecretVault.open({ hostPrivate: d })).publicKey).toBe(v.publicKey);
    const status = await v.apply("bot-a", [{ name: "STRIPE_KEY", description: "Stripe test key", sealed: await sealTo(v.publicKey, "sk_test_abcdef123"), valueHash: "h1" }], []);
    expect(status).toEqual([{ name: "STRIPE_KEY", description: "Stripe test key", updatedAt: 42, valueHash: "h1", needsSync: false }]);
    const raw = fs.readFileSync(path.join(d, "secrets", "bot-a.json"), "utf8");
    expect(raw).not.toContain("sk_test_abcdef123");
    expect(fs.statSync(path.join(d, "secrets", "bot-a.json")).mode & 0o777).toBe(0o600);
    expect(v.env("bot-a")).toEqual({ STRIPE_KEY: "sk_test_abcdef123" });
    expect(v.descriptions("bot-a")).toEqual([{ name: "STRIPE_KEY", description: "Stripe test key" }]);
  });

  it("rejects bad names, short values and limits with the SEC-05 messages", async () => {
    const v = await SecretVault.open({ hostPrivate: dir() });
    const up = async (name: string, value: string) => v.apply("b", [{ name, description: "", sealed: await sealTo(v.publicKey, value), valueHash: "h" }], []);
    await expect(up("PATH", "abcdefgh")).rejects.toThrow("PATH is reserved.");
    await expect(up("OK", "abc")).rejects.toThrow("Secret values must be at least 4 characters.");
    await expect(up("OK", "x".repeat(32_769))).rejects.toThrow("A secret value can be at most 32,768 characters.");
    await up("A1", "x".repeat(32_768));
    await up("A2", "x".repeat(32_768));
    await up("A3", "x".repeat(32_768));
    await expect(up("A4", "x".repeat(10))).rejects.toThrow("A Bot's secrets can total at most 98,304 characters.");
  });

  it("env() drops names stored before the stricter rules (I4) and logs them by name only; values() still has them for redaction", async () => {
    const d = dir();
    const v = await SecretVault.open({ hostPrivate: d });
    const names = ["GIT_CONFIG_COUNT", "GIT_EXTERNAL_DIFF", "BASH_ENV", "NODE_OPTIONS", "https_proxy"];
    // Store valid placeholders, then rename them on disk to simulate entries saved by an older build.
    for (const [i, n] of ["S1", "S2", "S3", "S4", "S5", "KEEP"].entries()) {
      await v.apply("b", [{ name: n, description: "", sealed: await sealTo(v.publicKey, `stale-value-${i}`), valueHash: "h" }], []);
    }
    const f = path.join(d, "secrets", "b.json");
    const cache = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
    names.forEach((n, i) => { cache[n] = cache[`S${i + 1}`]; delete cache[`S${i + 1}`]; });
    fs.writeFileSync(f, JSON.stringify(cache));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const v2 = await SecretVault.open({ hostPrivate: d });
    expect(v2.env("b")).toEqual({ KEEP: "stale-value-5" });
    expect(v2.values("b").map((x) => x.name).sort()).toEqual([...names, "KEEP"].sort());
    const logged = JSON.stringify(warn.mock.calls);
    for (const n of names) expect(logged).toContain(n);
    expect(logged).not.toContain("stale-value");
    warn.mockRestore();
  });

  it("bug 56: a secret stored under older name rules is reported as unusable, with the reason, never as usable", async () => {
    const d = dir();
    const v = await SecretVault.open({ hostPrivate: d, now: () => 7 });
    for (const n of ["S1", "S2", "KEEP"]) await v.apply("b", [{ name: n, description: "d", sealed: await sealTo(v.publicKey, `legacy-value-${n}`), valueHash: "h" }], []);
    const f = path.join(d, "secrets", "b.json");
    const cache = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
    cache.GIT_TOKEN = cache.S1; delete cache.S1;
    cache.stripe_key = cache.S2; delete cache.S2;
    fs.writeFileSync(f, JSON.stringify(cache));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const v2 = await SecretVault.open({ hostPrivate: d });
    const byName = Object.fromEntries((await v2.status("b")).map((s) => [s.name, s]));
    expect(byName.GIT_TOKEN?.unusable).toBe("Names starting with GIT_ are reserved.");
    expect(byName.stripe_key?.unusable).toBe(validateSecretName("stripe_key"));
    expect(byName.KEEP?.unusable).toBeUndefined();
    // every name the status calls usable is exactly what the Bot's env receives
    expect(Object.values(byName).filter((s) => !s.unusable && !s.needsSync).map((s) => s.name)).toEqual(Object.keys(v2.env("b")));
    expect(JSON.stringify(await v2.status("b"))).not.toContain("legacy-value");
    warn.mockRestore();
  });

  it("marks entries 'needs sync' when the vault key was lost (Reset), and leaves them out of the env", async () => {
    const d = dir();
    const v = await SecretVault.open({ hostPrivate: d });
    await v.apply("b", [{ name: "K", description: "", sealed: await sealTo(v.publicKey, "value-1234"), valueHash: "h" }], []);
    fs.chmodSync(path.join(d, "vault.key"), 0o600);
    fs.rmSync(path.join(d, "vault.key"));
    const v2 = await SecretVault.open({ hostPrivate: d });
    expect((await v2.status("b"))[0]).toMatchObject({ name: "K", needsSync: true });
    expect(v2.env("b")).toEqual({});
  });

  it("version() changes on every change and onChange fires (the spawn key cools the warm CLI, §12.3)", async () => {
    const v = await SecretVault.open({ hostPrivate: dir() });
    const seen: string[] = [];
    v.onChange((b) => seen.push(b));
    const v0 = v.version("b");
    await v.apply("b", [{ name: "K", description: "", sealed: await sealTo(v.publicKey, "value-1234"), valueHash: "h" }], []);
    const v1 = v.version("b");
    await v.apply("b", [], ["K"]);
    expect(new Set([v0, v1, v.version("b")]).size).toBe(3);
    expect(seen).toEqual(["b", "b"]);
    expect(v.env("b")).toEqual({});
  });

  it("seals with the pinned public key and opens only with the private key", async () => {
    const kp = await loadOrCreateBoxKeyPair(dir());
    const v = await SecretVault.open({ hostPrivate: dir() });
    await expect(v.open(await sealTo(kp.publicKey, "zzzz"))).rejects.toThrow();
  });
});
