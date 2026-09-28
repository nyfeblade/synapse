import { describe, expect, it } from "vitest";
import { assertSafeArgs, enableLink, findTailscale, isOurTarget, makeTailscale, MIN_TAILSCALE_VERSION, parseServeStatus, parseStatus, phoneUrl, SERVE_HELP_ARGS, SERVE_STATUS_ARGS, serveOffArgs, serveOnArgs, versionAtLeast, type RunResult } from "../../src/main/phone/tailscale";

describe("security review fixes (tailscale side)", () => {
  const DNS = "mac.example-tailnet.ts.net";
  it("serve can point at a Unix socket (no port to take over), with the same guard", () => {
    expect(serveOnArgs({ socket: "/Users/me/Library/Application Support/Synapse/phone/phone.sock" })).toEqual(["serve", "--bg", "--https=443", "unix:/Users/me/Library/Application Support/Synapse/phone/phone.sock"]);
    expect(() => assertSafeArgs(serveOnArgs({ socket: "/a/b/phone.sock" }))).not.toThrow();
    for (const bad of ["relative.sock", "/a/b/not-a-socket", "/a/\nb.sock", `/${"x".repeat(120)}.sock`]) expect(() => serveOnArgs({ socket: bad })).toThrow();
    expect(() => assertSafeArgs(["serve", "--bg", "--https=443", "unix:/tmp/x"])).toThrow();
    for (const ok of [SERVE_STATUS_ARGS, SERVE_HELP_ARGS]) expect(() => assertSafeArgs(ok)).not.toThrow();
    expect(() => assertSafeArgs(["serve", "reset"])).toThrow();
  });

  it("refuses a Tailscale older than the one that strips client-sent Tailscale-User-* headers", () => {
    expect(MIN_TAILSCALE_VERSION).toBe("1.56.0");
    expect(versionAtLeast("1.102.3", MIN_TAILSCALE_VERSION)).toBe(true);
    expect(versionAtLeast("1.56.0", MIN_TAILSCALE_VERSION)).toBe(true);
    expect(versionAtLeast("1.54.9", MIN_TAILSCALE_VERSION)).toBe(false);
    expect(versionAtLeast(null, MIN_TAILSCALE_VERSION)).toBe(false);
  });

  it("reads serve status: our root, the user's own config on :443, Funnel", () => {
    expect(parseServeStatus("{}", DNS)).toEqual({ root: null, foreign: false, funnel: false });
    const ours = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:41234" } } } } });
    expect(parseServeStatus(ours, DNS)).toEqual({ root: "http://127.0.0.1:41234", foreign: false, funnel: false });
    const user = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/grafana": { Proxy: "http://127.0.0.1:3000" } } } } });
    expect(parseServeStatus(user, DNS).foreign).toBe(true);
    const fwd = JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } });
    expect(parseServeStatus(fwd, DNS).foreign).toBe(true);
    const funnel = JSON.stringify({ AllowFunnel: { [`${DNS}:443`]: true } });
    expect(parseServeStatus(funnel, DNS).funnel).toBe(true);
  });

  it("knows its own target in serve's spellings", () => {
    expect(isOurTarget("unix:/a/phone.sock", { socket: "/a/phone.sock" })).toBe(true);
    expect(isOurTarget("unix:/a/phone.sock/", "unix:/a/phone.sock")).toBe(true);
    // Exact only: a path that merely ENDS with ours is somebody else's.
    expect(isOurTarget("unix:/evil/a/phone.sock", { socket: "/a/phone.sock" })).toBe(false);
    expect(isOurTarget("unix://a/phone.sock", { socket: "/a/phone.sock" })).toBe(false);
    expect(isOurTarget("unix:/b/phone.sock", { socket: "/a/phone.sock" })).toBe(false);
    expect(isOurTarget("http://127.0.0.1:41234", "unix:/a/phone.sock")).toBe(false);
    expect(isOurTarget(null, { socket: "/a/phone.sock" })).toBe(false);
    expect(isOurTarget("unix:/a/phone.sock", null)).toBe(false);
  });

  it("detects Unix-socket support from `serve --help`, and at quit turns off only if :443 is still exactly ours", async () => {
    const help = "On Unix-like systems, you can also specify a Unix domain socket (e.g., unix:/tmp/myservice.sock).";
    const seen: string[][] = [];
    let root = "unix:/a/phone.sock";
    const status = () => JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: root } } } } });
    const ts = makeTailscale({ find: () => "/ts", run: async (_c, a) => { seen.push(a); return { code: 0, stdout: help, stderr: "", timedOut: false }; }, runSync: (_c, a) => { seen.push(a); return { code: 0, stdout: a[1] === "status" ? status() : "" }; } });
    expect(await ts.supportsUnix()).toBe(true);
    expect(ts.serveOffSyncIfOurs(DNS, "unix:/a/phone.sock")).toBe("removed");
    expect(seen).toEqual([SERVE_HELP_ARGS, SERVE_STATUS_ARGS, serveOffArgs()]);
    root = "http://127.0.0.1:3000";
    seen.length = 0;
    expect(ts.serveOffSyncIfOurs(DNS, "unix:/a/phone.sock")).toBe("not-ours");
    expect(seen).toEqual([SERVE_STATUS_ARGS]);
    const old = makeTailscale({ find: () => "/ts", run: async () => ({ code: 0, stdout: "USAGE tailscale serve <port>", stderr: "", timedOut: false }) });
    expect(await old.supportsUnix()).toBe(false);
  });

  it("at quit, never turns :443 off when the user's own handlers share it with ours (it would wipe theirs)", () => {
    const seen: string[][] = [];
    const status = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "unix:/a/phone.sock" }, "/grafana": { Proxy: "http://127.0.0.1:3000" } } } } });
    const ts = makeTailscale({ find: () => "/ts", runSync: (_c, a) => { seen.push(a); return { code: 0, stdout: a[1] === "status" ? status : "" }; } });
    expect(ts.serveOffSyncIfOurs(DNS, "unix:/a/phone.sock")).toBe("shared");
    expect(seen).toEqual([SERVE_STATUS_ARGS]);
  });
});

// Bug 198: the Tailscale CLI is MOCKED in every test here — nothing runs the real one.

/** The shape `tailscale status --json` prints (1.102), trimmed to what Phone access reads. */
const STATUS = JSON.stringify({
  Version: "1.102.3-t0000000000", BackendState: "Running", MagicDNSSuffix: "example-tailnet.ts.net",
  Self: { ID: "n1", HostName: "Example-Mac", DNSName: "Example-Mac.example-tailnet.ts.net.", UserID: 1, TailscaleIPs: ["100.64.0.1"] },
  User: { "1": { ID: 1, LoginName: "me@example.com", DisplayName: "Me" } },
  Peer: {},
});

function fakeRunner(answers: Partial<Record<string, RunResult>> = {}) {
  const calls: { cli: string; args: string[] }[] = [];
  const run = async (cli: string, args: string[]) => {
    calls.push({ cli, args });
    return answers[args.join(" ")] ?? answers[args[0]!] ?? { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { calls, run };
}

describe("tailscale status", () => {
  it("reads this Mac's tailnet name (no trailing dot, lower case) and its signed-in login", () => {
    expect(parseStatus(STATUS)).toEqual({ running: true, dnsName: "example-mac.example-tailnet.ts.net", login: "me@example.com", state: "Running", version: "1.102.3" });
  });

  it("copes with a stopped or odd Tailscale", () => {
    expect(parseStatus(JSON.stringify({ BackendState: "Stopped", Self: {} }))).toEqual({ running: false, dnsName: null, login: null, state: "Stopped", version: null });
    expect(parseStatus("not json")).toMatchObject({ running: false, dnsName: null });
  });

  it("makes the phone's URL from the tailnet name", () => {
    expect(phoneUrl("mac.example-tailnet.ts.net")).toBe("https://mac.example-tailnet.ts.net/");
    expect(phoneUrl(null)).toBeNull();
  });
});

describe("the serve commands", () => {
  it("on: serve --bg --https=443 to the private socket only — there is no port form at all", () => {
    expect(serveOnArgs({ socket: "/a/b/phone.sock" })).toEqual(["serve", "--bg", "--https=443", "unix:/a/b/phone.sock"]);
    expect(() => assertSafeArgs(["serve", "--bg", "--https=443", "http://127.0.0.1:41234"])).toThrow();
  });

  it("off: serve --https=443 off", () => {
    expect(serveOffArgs()).toEqual(["serve", "--https=443", "off"]);
  });

  it("refuses to run anything else — never funnel, up, set or login", () => {
    for (const bad of [["funnel", "443", "on"], ["serve", "--bg", "--https=443", "http://0.0.0.0:41234"], ["up"], ["set", "--shields-up"], ["login"],
      ["serve", "--bg", "--https=443", "unix:/a/b/phone.sock", "--funnel"], ["serve", "--bg", "--https=8443", "unix:/a/b/phone.sock"], ["status"]]) {
      expect(() => assertSafeArgs(bad)).toThrow();
    }
    for (const ok of [["status", "--json"], ["version"], serveOnArgs({ socket: "/a/b/phone.sock" }), serveOffArgs()]) expect(() => assertSafeArgs(ok)).not.toThrow();
  });

  it("finds the CLI in the Mac app first, then Homebrew", () => {
    expect(findTailscale((p) => p.startsWith("/Applications"), {})).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    expect(findTailscale((p) => p === "/opt/homebrew/bin/tailscale", {})).toBe("/opt/homebrew/bin/tailscale");
    expect(findTailscale(() => false, {})).toBeNull();
    // The stand-in CLI is only honoured in tests and FUZZ runs, never in the shipped app.
    expect(findTailscale((p) => p === "/x/ts", { SYNAPSE_TAILSCALE_CLI: "/x/ts", FUZZ: "1" })).toBe("/x/ts");
    expect(findTailscale((p) => p === "/x/ts", { SYNAPSE_TAILSCALE_CLI: "/x/ts", VITEST: "true" })).toBe("/x/ts");
    expect(findTailscale((p) => p === "/x/ts" || p.startsWith("/Applications"), { SYNAPSE_TAILSCALE_CLI: "/x/ts" })).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  });

  it("runs exactly those commands through the CLI (mocked)", async () => {
    const f = fakeRunner({ status: { code: 0, stdout: STATUS, stderr: "", timedOut: false } });
    const ts = makeTailscale({ run: f.run, find: () => "/Applications/Tailscale.app/Contents/MacOS/Tailscale" });
    expect(await ts.status()).toMatchObject({ installed: true, running: true, dnsName: "example-mac.example-tailnet.ts.net" });
    expect(await ts.serveOn({ socket: "/a/b/phone.sock" })).toEqual({ ok: true });
    expect(await ts.serveOff()).toEqual({ ok: true });
    expect(f.calls.map((c) => c.args.join(" "))).toEqual(["status --json", "serve --bg --https=443 unix:/a/b/phone.sock", "serve --https=443 off"]);
    expect(new Set(f.calls.map((c) => c.cli))).toEqual(new Set(["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]));
  });

  it("serve not enabled on the tailnet yet: the admin link comes back, not a hang", async () => {
    const out = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nABC123\n";
    const f = fakeRunner({ serve: { code: null, stdout: out, stderr: "", timedOut: true } });
    const ts = makeTailscale({ run: f.run, find: () => "/ts" });
    expect(await ts.serveOn({ socket: "/a/b/phone.sock" })).toEqual({ ok: false, needsEnable: "https://login.tailscale.com/f/serve?node=nABC123" });
    expect(enableLink("nothing here")).toBeNull();
  });

  it("says what went wrong, and that there's no Tailscale at all", async () => {
    const f = fakeRunner({ serve: { code: 1, stdout: "", stderr: "error: something broke\n", timedOut: false } });
    expect(await makeTailscale({ run: f.run, find: () => "/ts" }).serveOn({ socket: "/a/b/phone.sock" })).toEqual({ ok: false, message: "error: something broke" });
    const none = makeTailscale({ run: f.run, find: () => null });
    expect(await none.status()).toMatchObject({ installed: false, running: false });
    expect((await none.serveOn({ socket: "/a/b/phone.sock" })).ok).toBe(false);
  });

  it("turning off what is already off counts as off", async () => {
    const f = fakeRunner({ serve: { code: 1, stdout: "", stderr: "error: handler does not exist\n", timedOut: false } });
    expect(await makeTailscale({ run: f.run, find: () => "/ts" }).serveOff()).toEqual({ ok: true });
  });
});
