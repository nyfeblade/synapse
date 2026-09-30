import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledPackages, renderPackageList } from "../../scripts/third-party.mjs";

/**
 * Bug 283: app/build/THIRD-PARTY-NOTICES.txt ships inside Synapse.app and must name every component the
 * app bundles: the JavaScript packages in app.asar and in the host bundle (computed here from the same
 * dependency lists the build uses), the packages npm installs into the box, every Python package of the
 * bundled voice (the pinned lock), and the GPL-3.0 espeak-ng and phonemizer with where their source is.
 */
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(appDir, "..");
const notices = fs.readFileSync(path.join(appDir, "build", "THIRD-PARTY-NOTICES.txt"), "utf8");
const named = (name: string) => new RegExp(`(^|[\\s(])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s,)]|$)`, "im").test(notices);
const norm = (s: string) => s.toLowerCase().replace(/[_.]/g, "-");

describe("third-party notices (bug 283)", () => {
  const pkgs = bundledPackages(repoRoot);

  it("the closure reaches the transitive packages, not just the direct ones", () => {
    expect(pkgs.app.size).toBeGreaterThan(50);
    expect(pkgs.app.has("micromark")).toBe(true);   // react-markdown's parser
    expect(pkgs.host.has("imapflow")).toBe(true);    // inlined into host.mjs
    expect(pkgs.host.has("libmime")).toBe(true);     // imapflow's own dependency
    expect(pkgs.box.has("playwright-core")).toBe(true);
    expect(pkgs.mcp.has("@modelcontextprotocol/sdk")).toBe(true); // 0.1.4: inlined into the MCP helper
    expect(pkgs.mcp.has("zod")).toBe(true);
    expect(pkgs.app.has("@synapse/shared")).toBe(false); // ours
  });

  it("names every JavaScript package the app, the host bundle and the box ship", () => {
    const missing = [...pkgs.app.keys(), ...pkgs.mcp.keys(), ...pkgs.host.keys(), ...pkgs.box.keys()].filter((n) => !named(n));
    expect(missing).toEqual([]);
  });

  it("the generated package list in the file is the current one", () => {
    const m = /# BEGIN GENERATED PACKAGE LIST[^\n]*\n([\s\S]*?)# END GENERATED PACKAGE LIST/.exec(notices);
    expect(m, "the notices carry a generated package list").not.toBeNull();
    expect(m![1]).toBe(renderPackageList(pkgs));
  });

  it("bug 297: the Agent SDK, which is not open source, is listed with its real terms", () => {
    expect(notices).toMatch(/@anthropic-ai\/claude-agent-sdk — © Anthropic PBC; use is subject to Anthropic's Commercial Terms of Service/);
    expect(notices).not.toMatch(/claude-agent-sdk — see the package/);
  });

  it("names every Python package of the bundled voice", () => {
    const lock = fs.readFileSync(path.join(appDir, "native", "kokoro", "requirements.lock"), "utf8");
    const pins = [...lock.matchAll(/^([A-Za-z0-9_.-]+)==/gm)].map((m) => m[1]!);
    expect(pins.length).toBeGreaterThan(50);
    const listed = new Set([...notices.matchAll(/^ {2}([A-Za-z0-9_.-]+) \.\./gm)].map((m) => norm(m[1]!)));
    expect(pins.filter((p) => !listed.has(norm(p)))).toEqual([]);
    expect(listed.has("en-core-web-sm")).toBe(true);
  });

  it("says espeak-ng and phonemizer are GPL-3.0 and where their source code is", () => {
    expect(notices).toMatch(/espeak-ng[^\n]*GPL-3\.0-or-later/);
    expect(notices).toMatch(/phonemizer-fork[^\n]*GPL-3\.0/);
    expect(notices).toContain("https://github.com/espeak-ng/espeak-ng");
    expect(notices).toContain("https://www.gnu.org/licenses/gpl-3.0.txt");
    expect(notices).toMatch(/phonemizer-fork[^\n]*source/);
  });

  it("owner decision 2026-09-26: the GPL sources are attached to every release, not promised on request", () => {
    expect(notices).not.toMatch(/maintainers will provide/i);
    expect(notices).not.toMatch(/ask in the Synapse repository/i);
    expect(notices).toMatch(/attached to every Synapse release/);
    const pinned = JSON.parse(fs.readFileSync(path.join(appDir, "native", "kokoro", "gpl-sources.json"), "utf8")).sources as { name: string; version: string; asset: string }[];
    expect(pinned.map((s) => s.name).sort()).toEqual(["espeak-ng", "phonemizer-fork"]);
    for (const s of pinned) {
      expect(notices, s.asset).toContain(s.asset);
      expect(notices).toMatch(new RegExp(`${s.name.replace(/-/g, "\\-")}[^\n]*${s.version.replace(/\./g, "\\.")}`));
    }
  });

  it("is copied into every package the build makes", () => {
    const pkg = fs.readFileSync(path.join(appDir, "scripts", "package.mjs"), "utf8");
    expect(pkg).toContain('path.join(here, "build", "THIRD-PARTY-NOTICES.txt")');
  });

  it("Synapse's own LICENSE and NOTICE (Apache-2.0) are copied into the bundle and checked there", async () => {
    const pkg = fs.readFileSync(path.join(appDir, "scripts", "package.mjs"), "utf8");
    expect(pkg).toContain('path.join(repoRoot, "LICENSE")');
    expect(pkg).toContain('path.join(repoRoot, "NOTICE")');
    expect(pkg).toMatch(/extraResource: \[[^\]]*stagedLicence[^\]]*stagedNotice\b/);
    const { RUNTIME_PATHS } = await import("../../scripts/verify-bundle.mjs");
    expect(RUNTIME_PATHS).toEqual(expect.arrayContaining(["Contents/Resources/LICENSE", "Contents/Resources/NOTICE"]));
    expect(fs.readFileSync(path.join(repoRoot, "LICENSE"), "utf8")).toMatch(/Apache License\s+Version 2\.0/);
    expect(fs.readFileSync(path.join(repoRoot, "NOTICE"), "utf8")).toMatch(/Synapse/);
  });
});
