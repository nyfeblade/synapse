import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BROWSER_PROFILE_NAME, STRB } from "@synapse/shared";
import { ChromeDriver, chromeArgs } from "../../src/main/browser/cdp";
import { BrowserController, type BrowserDriver } from "../../src/main/browser/controller";
import { BrowserSignin, chromeSigninArgs, nameProfile, profileLock } from "../../src/main/browser/signin";

/**
 * Bug-log 150: the user tried to sign in to Google in the Bot's Chrome window and Google answered "Couldn't sign you
 * in" (accounts.google.com/v3/signin/rejected): that window runs with remote debugging, which Google treats as an
 * automated browser. "Sign in to sites" opens the SAME dedicated profile as plain Chrome (no debugging flags), the user
 * signs in once, and later Bot sessions reuse the saved cookies. The profile is named so it never reads as a guest.
 * Chrome here is a fake binary (fake-chrome.mjs) that keeps Chrome's one-process-per-profile lock and its cookie jar.
 */
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-chrome.mjs");
const spawnFn = ((_cmd: string, args: readonly string[], o: object) => spawn(process.execPath, [FAKE, ...args], o)) as unknown as typeof spawn;

let tmp: string;
let profileDir: string;
const launches = () => fs.readFileSync(path.join(profileDir, "launches.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; pid?: number; cookies?: string[]; handedOff?: boolean });
const launchChrome = () => ChromeDriver.launch({ chrome: "/fake/Google Chrome", profileDir, downloads: path.join(tmp, "dl"), spawnFn, timeoutMs: 10_000 });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-signin-"));
  profileDir = path.join(tmp, "browser-profile");
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe("the dedicated profile", () => {
  it("persists across relaunch: the second automated launch finds the first one's cookies", async () => {
    const a = await launchChrome();
    await a.close();
    expect(profileLock(profileDir)).toBeNull(); // a clean quit, not a kill mid-shutdown
    const b = await launchChrome();
    await b.close();
    const [l1, l2] = launches();
    expect(l1!.args).toContain(`--user-data-dir=${profileDir}`);
    expect(l2!.args).toContain(`--user-data-dir=${profileDir}`);
    expect(l2!.cookies).toEqual([`sid=${l1!.pid}`]);
    for (const l of [l1!, l2!]) expect(l.args.join(" ")).not.toMatch(/--incognito|--guest|--bwsi|--headless/);
  });

  it("is named Synapse (never the default 'Your Chrome' / guest look), keeping every other setting", () => {
    fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Your Chrome", is_using_default_name: true, avatar_icon: "x" } } }, keep: 1 }));
    fs.writeFileSync(path.join(profileDir, "Default", "Preferences"), JSON.stringify({ profile: { exit_type: "Crashed", avatar_index: 26 }, other: true }));
    nameProfile(profileDir);
    const ls = JSON.parse(fs.readFileSync(path.join(profileDir, "Local State"), "utf8"));
    const pr = JSON.parse(fs.readFileSync(path.join(profileDir, "Default", "Preferences"), "utf8"));
    expect(ls.profile.info_cache.Default).toMatchObject({ name: BROWSER_PROFILE_NAME, is_using_default_name: false, avatar_icon: "x" });
    expect(ls.keep).toBe(1);
    expect(pr.profile).toMatchObject({ name: BROWSER_PROFILE_NAME, using_default_name: false, exit_type: "Normal", avatar_index: 26 });
    expect(pr.other).toBe(true);
    expect(BROWSER_PROFILE_NAME).toBe("Synapse");
  });

  it("names a brand-new profile before Chrome's first run", async () => {
    const d = await launchChrome();
    await d.close();
    const pr = JSON.parse(fs.readFileSync(path.join(profileDir, "Default", "Preferences"), "utf8"));
    expect(pr.profile.name).toBe("Synapse");
  });
});

describe("Sign in to sites", () => {
  it("is a plain Chrome launch on the same profile: no remote debugging or automation flags", () => {
    const a = chromeSigninArgs(profileDir);
    expect(a).toContain(`--user-data-dir=${profileDir}`);
    expect(a.find((x) => x.startsWith("--user-data-dir"))).toBe(chromeArgs(profileDir).find((x) => x.startsWith("--user-data-dir")));
    expect(a.join(" ")).not.toMatch(/remote-debugging|enable-automation|no-startup-window|headless|remote-allow-origins/);
    expect(a.at(-1)).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  function setup(o: { lockTimeoutMs?: number } = {}) {
    let n = 0;
    const drivers: ChromeDriver[] = [];
    const c = new BrowserController({ launch: async () => { n += 1; const d = await launchChrome(); drivers.push(d); return d as BrowserDriver; }, now: Date.now, log: () => {} });
    const changes: boolean[] = [];
    const s = new BrowserSignin({ controller: c, chrome: "/fake/Google Chrome", profileDir, spawnFn, log: () => {}, onChange: (v) => changes.push(v), lockTimeoutMs: o.lockTimeoutMs ?? 5_000 });
    return { c, s, changes, launches: () => n, drivers };
  }

  it("closes the automated Chrome first (one process per profile), opens plain Chrome, and the Bot's next action relaunches with the saved sign-in", async () => {
    const { c, s, changes, launches: n } = setup();
    // the Bot's automated Chrome is running and holds the profile lock
    // (the fake speaks too little CDP to open a window; the launch and its lock are what count here)
    await c.handle({ botId: "b1", botName: "Ava", args: { action: "tabs", value: "list" }, approved: false, origins: [], explicit: false });
    expect(n()).toBe(1);
    const automated = launches()[0]!;
    expect(profileLock(profileDir)?.pid).toBe(automated.pid);

    await s.start();
    expect(s.active()).toBe(true);
    const all = launches();
    const plain = all[all.length - 1]!;
    expect(plain.handedOff).toBeUndefined(); // it really opened (the automated one had quit), not a hand-off to it
    expect(plain.args.join(" ")).not.toMatch(/remote-debugging/);
    expect(profileLock(profileDir)?.pid).toBe(plain.pid);

    // while the user signs in, the Bot is told to wait (and never relaunches the automated Chrome onto the profile)
    expect(await c.handle({ botId: "b1", botName: "Ava", args: { action: "snapshot" }, approved: false, origins: [], explicit: false })).toEqual({ ok: false, error: STRB.signingIn });
    expect(n()).toBe(1);

    await s.done();
    expect(s.active()).toBe(false);
    expect(profileLock(profileDir)).toBeNull();
    expect(changes).toEqual([true, false]);

    // the next Bot action relaunches automated Chrome, and it finds the cookies the plain window saved
    await c.handle({ botId: "b1", botName: "Ava", args: { action: "tabs", value: "list" }, approved: false, origins: [], explicit: false }).catch(() => null);
    expect(n()).toBe(2);
    const last = launches().at(-1)!;
    expect(last.args).toContain("--remote-debugging-port=0");
    expect(last.cookies).toContain(`sid=${plain.pid}`);
    await c.close();
  }, 20_000);

  it("ends by itself when the user quits that Chrome", async () => {
    const { s, changes } = setup();
    await s.start();
    process.kill(profileLock(profileDir)!.pid, "SIGTERM");
    await expect.poll(() => s.active(), { timeout: 5_000 }).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("refuses, clearly, when another live process holds the profile, and ignores a stale lock", async () => {
    fs.mkdirSync(profileDir, { recursive: true });
    const lock = path.join(profileDir, "SingletonLock");
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, lock); // live: this test process
    const { s } = setup({ lockTimeoutMs: 300 });
    await expect(s.start()).rejects.toThrow(STRB.signinLocked);
    expect(s.active()).toBe(false);
    fs.rmSync(lock);
    fs.symlinkSync(`${os.hostname()}-999999`, lock); // stale: no such process
    await s.start();
    expect(s.active()).toBe(true);
    await s.done();
  });

  it("without Google Chrome it says so", async () => {
    const c = new BrowserController({ launch: async () => { throw new Error("x"); }, now: Date.now, log: () => {} });
    const s = new BrowserSignin({ controller: c, chrome: null, profileDir, spawnFn, log: () => {} });
    await expect(s.start()).rejects.toThrow(STRB.signinNeedsChrome);
  });
});
