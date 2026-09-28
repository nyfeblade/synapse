import { describe, expect, it } from "vitest";
import { allowedHosts, checkTailnet, clearCookie, deviceCookie, deviceName, originAllowed, PAIRING, Pairing, parseCookies, throttledLog } from "../../src/main/phone/auth";

// Bug 198: who may reach the phone server. Everything here is what `tailscale serve` hands the server
// on its private Unix socket — the only way in (there is no TCP listener, and no loopback trust).
const OWNER = { login: "me@example.com", hosts: allowedHosts("mac.example-tailnet.ts.net"), viaSocket: true };
const req = (headers: Record<string, string | string[]>) => ({ headers });
const good = { "tailscale-user-login": "me@example.com", host: "mac.example-tailnet.ts.net" };

describe("the tailnet gate", () => {
  it("lets the Mac's own user in, through serve (the private socket + identity header + tailnet host)", () => {
    expect(checkTailnet(req(good), OWNER)).toEqual({ ok: true, login: "me@example.com" });
    // Logins compare without case (Tailscale shows the provider's spelling).
    expect(checkTailnet(req({ ...good, "tailscale-user-login": "Me@Example.com" }), OWNER).ok).toBe(true);
  });

  it("never believes the identity header on anything but the private socket", () => {
    expect(checkTailnet(req(good), { ...OWNER, viaSocket: false })).toEqual({ ok: false, status: 403, why: "not-socket" });
  });

  it("refuses a request without Tailscale's identity (a local process, or serve for a tagged device)", () => {
    expect(checkTailnet(req({ host: "mac.example-tailnet.ts.net" }), OWNER)).toMatchObject({ ok: false, why: "no-tailnet-identity" });
    // Two identity headers is not an identity.
    expect(checkTailnet(req({ ...good, "tailscale-user-login": ["me@example.com", "x@y.z"] }), OWNER)).toMatchObject({ ok: false, why: "no-tailnet-identity" });
  });

  it("refuses another person on the same tailnet", () => {
    expect(checkTailnet(req({ ...good, "tailscale-user-login": "friend@example.com" }), OWNER)).toMatchObject({ ok: false, why: "wrong-user" });
    expect(checkTailnet(req(good), { ...OWNER, login: null })).toMatchObject({ ok: false, why: "owner-unknown" });
  });

  it("refuses any Host but this Mac's tailnet name — the loopback's own included", () => {
    for (const host of ["evil.example", "127.0.0.1:41234", "localhost:41234", "mac.example-tailnet.ts.net:8443"]) {
      expect(checkTailnet(req({ ...good, host }), OWNER)).toMatchObject({ ok: false, why: "wrong-host" });
    }
    expect(checkTailnet(req({ ...good, host: "mac.example-tailnet.ts.net:443" }), OWNER).ok).toBe(true);
  });

  it("only takes a socket or a POST from this server's own https page", () => {
    expect(originAllowed("https://mac.example-tailnet.ts.net", OWNER.hosts)).toBe(true);
    expect(originAllowed("https://evil.example", OWNER.hosts)).toBe(false);
    expect(originAllowed("http://mac.example-tailnet.ts.net", OWNER.hosts)).toBe(false);
    expect(originAllowed("http://127.0.0.1:41234", OWNER.hosts)).toBe(false);
    expect(originAllowed("https://mac.example-tailnet.ts.net:8443", OWNER.hosts)).toBe(false);
    expect(originAllowed(undefined, OWNER.hosts)).toBe(false);
    expect(originAllowed("null", OWNER.hosts)).toBe(false);
  });

  it("refused requests are logged at most once per reason every 10 s", () => {
    const lines: string[] = [];
    let now = 0;
    const refuse = throttledLog((l) => lines.push(l), 10_000, () => now);
    for (let i = 0; i < 50; i++) refuse("wrong-user");
    refuse("wrong-host");
    now = 10_001;
    refuse("wrong-user");
    expect(lines).toEqual(["phone: refused (wrong-user)", "phone: refused (wrong-host)", "phone: refused (wrong-user) (+49 more since)"]);
  });
});

describe("pairing", () => {
  it("a six-digit code pairs once, then is spent", () => {
    const p = new Pairing();
    const { code, expiresAt } = p.start();
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(p.redeem(`${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true);
    expect(p.redeem(code)).toBe(false);
    expect(p.active()).toBe(false);
  });

  it("five wrong tries end the code, so it can't be guessed", () => {
    const p = new Pairing();
    const { code } = p.start();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < PAIRING.maxTries; i++) expect(p.redeem(wrong)).toBe(false);
    expect(p.active()).toBe(false);
    expect(p.redeem(code)).toBe(false);
  });

  it("a code runs out after ten minutes", () => {
    let now = 1_000_000;
    const p = new Pairing(() => now);
    const { code } = p.start();
    now += PAIRING.ttlMs + 1;
    expect(p.redeem(code)).toBe(false);
  });

  it("nothing but digits is a code; no code at all pairs nothing", () => {
    const p = new Pairing();
    expect(p.redeem("123456")).toBe(false);
    p.start();
    expect(p.redeem({ code: 1 })).toBe(false);
    expect(p.redeem("12345a")).toBe(false);
  });
});

describe("the device cookie", () => {
  it("is httpOnly, Secure, SameSite=Strict and scoped to the whole site", () => {
    const c = deviceCookie("tok");
    expect(c).toMatch(/^synapse_phone=tok;/);
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(c).toContain(part);
    expect(clearCookie()).toContain("Max-Age=0");
  });

  it("parses the first value of each cookie", () => {
    expect(parseCookies("a=1; synapse_phone=abc; synapse_phone=evil")).toEqual({ a: "1", synapse_phone: "abc" });
    expect(parseCookies(undefined)).toEqual({});
  });

  it("names a device from its browser", () => {
    expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36")).toBe("Pixel 8");
    expect(deviceName("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36")).toBe("Android phone");
    expect(deviceName(undefined)).toBe("Phone");
  });
});
