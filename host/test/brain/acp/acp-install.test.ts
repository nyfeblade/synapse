import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACP_INSTALL_PINS, ACP_VENDOR_IDS, ACP_VENDORS, STR_ACP, type AcpVendorId } from "@synapse/shared";
import { ProviderConsentStore } from "../../../auth/provider-consent";
import { AcpInstaller, helperReason, simulatedAcpInstall, type AcpInstallRunner } from "../../../brain/acp/install";
import { AcpLogins } from "../../../brain/acp/login";
import { createAcpCommands } from "../../../brain/acp/module";
import { SPEC_GATEWAY_COMMANDS, PARITY } from "../../../tools/parity";

const REPO = path.resolve(__dirname, "../../../..");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "acp-install-")); dirs.push(d); return d; };
const helper = () => fs.readFileSync(path.join(REPO, "box/files/bot-acp-install"), "utf8");

describe("the pins: the shared table, the root helper's table and the lockfiles agree", () => {
  it("each pinned vendor's package and version are the same in all three, and the launcher is bot-acp-as-box's bin", () => {
    const h = helper();
    const table = h.slice(h.indexOf("# INSTALL-TABLE-BEGIN"), h.indexOf("# INSTALL-TABLE-END"));
    const rows = Object.fromEntries([...table.matchAll(/^\s+([a-z]+)\) pkg=([^;]+); ver=([^;]+); bin=([^;]+);/gm)].map((m) => [m[1], { package: m[2], version: m[3], bin: m[4] }]));
    for (const id of ACP_VENDOR_IDS) {
      const pin = ACP_INSTALL_PINS[id];
      if (!pin) { expect(rows[id], id).toBeUndefined(); continue; }
      expect(rows[id], id).toEqual({ ...pin, bin: ACP_VENDORS[id].bin });
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "box/files/acp-pins", id, "package.json"), "utf8"));
      expect(pkg.dependencies).toEqual({ [pin.package]: pin.version });
      const lock = JSON.parse(fs.readFileSync(path.join(REPO, "box/files/acp-pins", id, "package-lock.json"), "utf8"));
      expect(lock.packages[""].dependencies).toEqual({ [pin.package]: pin.version });
      expect(lock.packages[`node_modules/${pin.package}`].version).toBe(pin.version);
    }
    // Only the vendors with an npm package that publishes dist.integrity have a pin (Cursor and Vibe don't).
    expect(ACP_VENDOR_IDS.filter((v) => ACP_INSTALL_PINS[v])).toEqual(["copilot", "kimi"]);
    expect(fs.readdirSync(path.join(REPO, "box/files/acp-pins")).sort()).toEqual(["copilot", "kimi"]);
  });

  it("every package in every lockfile is pinned by sha512 and comes from the npm registry", () => {
    for (const v of ["copilot", "kimi"]) {
      const lock = JSON.parse(fs.readFileSync(path.join(REPO, "box/files/acp-pins", v, "package-lock.json"), "utf8"));
      const entries = Object.entries(lock.packages as Record<string, { integrity?: string; resolved?: string }>).filter(([k]) => k);
      expect(entries.length, v).toBeGreaterThan(1);
      for (const [k, p] of entries) {
        expect(p.integrity, `${v} ${k}`).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
        expect(p.resolved, `${v} ${k}`).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      }
    }
  });
});

describe("the root helper bot-acp-install (static; the throwaway-machine proof is box/acp-install-sim.sh)", () => {
  it("takes only a vendor and a verb from bothost via sudo, and installs with npm ci from the registry, no scripts, no user config", () => {
    const h = helper();
    expect(h).toContain('[ "${SUDO_USER:-}" = "bothost" ]');
    expect(h).toContain('case "$verb" in install|remove) ;;');
    expect(h).toContain("npm ci --ignore-scripts");
    expect(h).toContain("--registry=https://registry.npmjs.org/");
    expect(h).toContain('npm_config_userconfig="$stage/.npmrc-user" npm_config_globalconfig="$stage/.npmrc-global"');
    expect(h).toContain("env -i HOME=");
    expect(h).toContain('chown -R root:root "$stage"');
    // The version npm installed is checked against the pin, and the launcher's target can't leave the install.
    expect(h).toContain('[ "$got" = "$ver" ]');
    expect(h).toContain('readlink -f -- "$stage/$entry"');
    expect(h).not.toMatch(/npm (install|i) /);
    expect(h).not.toMatch(/curl|wget/);
  });

  it("is installed root-owned by provision with its pins, and bothost alone may sudo it, with a fresh environment", () => {
    const prov = fs.readFileSync(path.join(REPO, "box/provision.sh"), "utf8");
    expect(prov).toContain('install -m 0755 -o root -g root "$HERE/files/bot-acp-install" /usr/local/libexec/bot-acp-install');
    expect(prov).toContain('install -m 0644 -o root -g root "$pins/package.json" "$pins/package-lock.json" "/usr/local/lib/synapse-acp-pins/$v/"');
    const sudoers = fs.readFileSync(path.join(REPO, "box/files/sudoers-bothost"), "utf8");
    expect(sudoers).toMatch(/Defaults!\/usr\/local\/libexec\/bot-acp-install env_reset, !use_pty, secure_path=/);
    const grants = sudoers.split("\n").filter((l) => l.includes("bot-acp-install") && l.includes("NOPASSWD"));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/^bothost ALL=\(root\) NOPASSWD: /);
  });
});

describe("the installer (host)", () => {
  const fakeRun = (root: string, fail?: string) => {
    const calls: [AcpVendorId, string][] = [];
    const sim = simulatedAcpInstall(root, 5);
    const run: AcpInstallRunner = async (v, verb) => { calls.push([v, verb]); if (fail) throw new Error(fail); await sim(v, verb); };
    return { run, calls };
  };

  it("Not installed → Installing… → Installed with its version → Remove → Not installed", async () => {
    const root = tmp();
    const f = fakeRun(root);
    const i = new AcpInstaller({ root, run: f.run, accountsReady: () => true });
    expect(i.view("copilot")).toMatchObject({ state: "not-installed", pinned: "1.0.89", package: "@github/copilot", version: null });
    i.start("copilot", "install");
    expect(i.view("copilot").state).toBe("installing");
    i.start("copilot", "install"); // a second click while it runs starts nothing new
    await i.settled("copilot");
    expect(i.view("copilot")).toMatchObject({ state: "installed", version: "1.0.89", error: null });
    i.start("copilot", "remove");
    expect(i.view("copilot").state).toBe("removing");
    await i.settled("copilot");
    expect(i.view("copilot").state).toBe("not-installed");
    expect(f.calls).toEqual([["copilot", "install"], ["copilot", "remove"]]);
  });

  it("refuses without per-Bot accounts, and says how; no verified package for Cursor or Vibe; nothing off the box", () => {
    const root = tmp();
    const f = fakeRun(root);
    const noAccounts = new AcpInstaller({ root, run: f.run, accountsReady: () => false });
    expect(noAccounts.accountsNeeded()).toBe(true);
    expect(() => noAccounts.start("copilot", "install")).toThrow(STR_ACP.accounts);
    expect(STR_ACP.accounts).toContain("box/migrate-per-bot-uid.sh --apply");
    const ready = new AcpInstaller({ root, run: f.run, accountsReady: () => true });
    expect(ready.view("cursor")).toMatchObject({ state: "unavailable", pinned: null });
    expect(() => ready.start("cursor", "install")).toThrow(STR_ACP.noVerifiedPackage);
    expect(() => ready.start("vibe", "install")).toThrow(STR_ACP.noVerifiedPackage);
    const offBox = new AcpInstaller({ root, run: null, accountsReady: () => false });
    expect(offBox.accountsNeeded()).toBe(false);
    expect(offBox.view("copilot").state).toBe("unavailable");
    expect(() => offBox.start("copilot", "install")).toThrow(STR_ACP.offBox);
    expect(f.calls).toEqual([]);
  });

  it("a failed install says why in the helper's own words, never npm's output", async () => {
    const root = tmp();
    const stderr = "npm error code EINTEGRITY\nnpm error sha512-AAAA integrity checksum failed\nbot-acp-install: couldn't download and verify @github/copilot@1.0.89 (no network, or a file didn't match its published checksum)\n";
    const reason = helperReason(stderr, "copilot");
    expect(reason).toBe("GitHub Copilot couldn't be installed. Couldn't download and verify @github/copilot@1.0.89 (no network, or a file didn't match its published checksum).");
    expect(helperReason("sudo: a password is required\n", "copilot")).toBe("GitHub Copilot couldn't be installed.");
    const f = fakeRun(root, reason);
    const i = new AcpInstaller({ root, run: f.run, accountsReady: () => true });
    i.start("copilot", "install");
    await i.settled("copilot");
    expect(i.view("copilot")).toMatchObject({ state: "not-installed", error: reason });
  });

  it("a launcher that is a link doesn't count as installed; a hand install without a record shows no version", () => {
    const root = tmp();
    const i = new AcpInstaller({ root, run: null, accountsReady: () => true });
    fs.mkdirSync(path.join(root, "kimi"));
    fs.symlinkSync("/bin/sh", path.join(root, "kimi", "kimi"));
    expect(i.view("kimi").state).toBe("unavailable");
    fs.mkdirSync(path.join(root, "copilot"));
    fs.writeFileSync(path.join(root, "copilot", "copilot"), "#!/bin/sh\n");
    expect(i.view("copilot")).toMatchObject({ state: "installed", version: null });
    fs.writeFileSync(path.join(root, "copilot", ".installed.json"), JSON.stringify({ version: "<b>1</b>" }));
    expect(i.view("copilot").version).toBeNull();
  });
});

describe("the gateway commands", () => {
  it("installAcpVendor / removeAcpVendor are the owner's alone (no Bot tool), validate the vendor, and return the view", async () => {
    expect(SPEC_GATEWAY_COMMANDS).toEqual(expect.arrayContaining(["installAcpVendor", "removeAcpVendor"]));
    expect(PARITY.installAcpVendor).toEqual({ userOnly: expect.stringContaining("root") });
    expect(PARITY.removeAcpVendor).toEqual({ userOnly: expect.stringContaining("root") });
    const root = tmp();
    const consent = new ProviderConsentStore({ dir: tmp() });
    const logins = new AcpLogins({ spawn: () => { throw new Error("no"); }, cwd: () => "/" });
    const installer = new AcpInstaller({ root, run: simulatedAcpInstall(root, 5), accountsReady: () => true });
    const c = createAcpCommands({ consent, logins, hasBot: () => true, installer });
    const v0 = (await c.getAcpVendors!({} as never)) as { vendors: { id: string; install: { state: string } }[]; accountsNeeded?: boolean };
    expect(v0.accountsNeeded).toBeUndefined();
    expect(v0.vendors.map((v) => [v.id, v.install.state])).toEqual([["copilot", "not-installed"], ["cursor", "unavailable"], ["kimi", "not-installed"], ["vibe", "unavailable"]]);
    await expect(Promise.resolve().then(() => c.installAcpVendor!({ vendor: "gemini" } as never))).rejects.toMatchObject({ code: "BAD_PROVIDER" });
    await expect(Promise.resolve().then(() => c.installAcpVendor!({ vendor: "cursor" } as never))).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const v1 = (await c.installAcpVendor!({ vendor: "kimi" } as never)) as typeof v0;
    expect(v1.vendors.find((v) => v.id === "kimi")!.install.state).toBe("installing");
    await installer.settled("kimi");
    expect(((await c.getAcpVendors!({} as never)) as typeof v0).vendors.find((v) => v.id === "kimi")!.install).toMatchObject({ state: "installed", version: "2.1.1" });
    await c.removeAcpVendor!({ vendor: "kimi" } as never);
    await installer.settled("kimi");
    expect(fs.existsSync(path.join(root, "kimi"))).toBe(false);
    // Without per-Bot accounts the view says so, and Install refuses.
    const c2 = createAcpCommands({ consent, logins, hasBot: () => true, installer: new AcpInstaller({ root, run: simulatedAcpInstall(root, 5), accountsReady: () => false }) });
    expect(((await c2.getAcpVendors!({} as never)) as typeof v0).accountsNeeded).toBe(true);
    await expect(Promise.resolve().then(() => c2.installAcpVendor!({ vendor: "copilot" } as never))).rejects.toMatchObject({ code: "UNAVAILABLE", message: STR_ACP.accounts });
  });
});
