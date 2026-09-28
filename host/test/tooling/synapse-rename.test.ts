import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME, COMPUTER_NAME, computerTitle } from "@synapse/shared";

/**
 * Bug 284: the app was called Bots and is Synapse. "Bot" and "Bots" still name the app's assistants (the characters);
 * only the APP's old name goes. This guard fails if the old app name comes back where it was renamed, and lists every
 * place it is still allowed, each with its reason.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const json = (f: string) => JSON.parse(read(f)) as Record<string, unknown>;

/** Scanned: every source, script, config and current doc. */
const SCAN = ["package.json", "package-lock.json", "README.md", "SECURITY.md", "vitest.config.ts", "host", "app", "shared", "box", "scripts", "docs"];
/** Not scanned, each with its reason. */
const NOT_SCANNED: Record<string, string> = {
  "node_modules": "third-party code",
  "dist": "build output of the scanned sources",
  "dist-release": "build output",
  "out": "build output",
  ".build": "Swift build output of app/native",
  ".vite": "vite cache",
  ".vite-temp": "vite cache",
  "test-results": "playwright output",
  "docs/bug-log.md": "a dated record: each row says what was true when it was written (the new rows say what changed)",
  "docs/decisions.md": "a dated record, like the bug log",
  "docs/superpowers": "dated plans, kept as written",
  "docs/spec": "dated specs and spike findings, kept as written",
  "docs/lab": "dated experiments, kept as written",
  "docs/private": "dated private notes, kept as written",
  "docs/backlog.md": "dated backlog items, kept as written",
  "host/test/tooling/synapse-rename.test.ts": "this guard names what it looks for",
};
const TEXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|html|json|md|swift|py|service|nft|env|plist|txt)$|^[^.]+$/;

function files(): string[] {
  const out: string[] = [];
  const skipped = (p: string) => Object.keys(NOT_SCANNED).some((k) => (k.includes("/") ? rel(p) === k : path.basename(p) === k));
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skipped(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && TEXT.test(e.name) && fs.statSync(p).size < 4_000_000) out.push(p);
    }
  };
  for (const s of SCAN) {
    const p = path.join(ROOT, s);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p); else out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

/** Every line matching `re`, as "file:line: text", outside the files allowed to keep it. */
function hits(re: RegExp, allowed: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const f of files()) {
    if (rel(f) in allowed) continue;
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => { if (re.test(l)) out.push(`${rel(f)}:${i + 1}: ${l.trim().slice(0, 160)}`); });
  }
  return out;
}

describe("the app is Synapse, not Bots", () => {
  it("the workspace packages are synapse and @synapse/*", () => {
    expect(json("package.json").name).toBe("synapse");
    expect(json("shared/package.json").name).toBe("@synapse/shared");
    expect(json("host/package.json").name).toBe("@synapse/host");
    expect(json("app/package.json").name).toBe("@synapse/app");
  });

  it("the product is Synapse: the app name, productName, the window title, the coordinator's process name", () => {
    expect(APP_NAME).toBe("Synapse");
    expect(json("app/package.json").productName).toBe("Synapse");
    expect(read("app/src/renderer/index.html")).toMatch(/<title>Synapse<\/title>/);
    expect(read("app/src/main/index.ts")).toContain('serviceName: "Synapse Coordinator"');
  });

  it("the renderer's bridge to the app is window.synapse", () => {
    expect(read("app/src/preload/index.ts")).toContain('contextBridge.exposeInMainWorld("synapse", {');
    expect(hits(/(?:\b|\\b)window\\?\.bots\b|exposeInMainWorld\("bots"|\{ bots: [^}]*\}\)\.bots\b|BotsBridge/)).toEqual([]);
  });

  it("the Bots' computer is still the Bots' (the assistants'), not the app's", () => {
    expect(COMPUTER_NAME).toBe("Bots' computer");
    expect(computerTitle()).toBe("Bots' Computer");
  });

  it("the box keeps its names (bothost and the bots-* units and paths), whole: never half-renamed", () => {
    // Why kept (docs/decisions.md, 2026-09-26): bothost is a Linux account that owns the host's files, is named in
    // sudoers, nftables, the procview group, systemd units and drop-ins, /opt/bothost and /etc/bothost.env, and the
    // app's restart / journal / build-id calls. Deploy and provision re-run in place on an existing box and have no
    // step that migrates an account, its files and its rules; a partial rename would stop the host on that box.
    expect(read("box/files/bothost.service")).toMatch(/^User=bothost$/m);
    expect(read("box/provision.sh")).toContain("bothost");
    expect(read("app/src/main/backup/wire.ts")).toContain('"systemctl", "restart", "bothost"');
    expect(read("app/src/main/setup/orb.ts")).toContain("/opt/bothost/app/build-id.txt");
    expect(hits(/synapsehost|synapse-host\.service|\/opt\/synapse|\/etc\/synapse\.env/i)).toEqual([]);
  });

  it("no @bots/* package name is left anywhere", () => {
    expect(hits(/@bots\//)).toEqual([]);
  });

  it("env settings are SYNAPSE_*: a BOTS_* name is left only where the old name must still work", () => {
    const allowed: Record<string, string> = {
      "shared/src/env-names.ts": "envSetting reads the old BOTS_ name after the new one, for one release",
      "host/test/util/env-rename.test.ts": "proves the old name is still read",
      "host/test/auth/no-subscription-guard.test.ts": "the guard still refuses the removed BOTS_AUTH_PROXY_OAUTH under its old name",
      "host/test/auth/api-key-only.test.ts": "proves the removed BOTS_AUTH_PROXY_OAUTH has no effect",
      "host/test/auth/proxy-config.test.ts": "proves the removed BOTS_AUTH_PROXY_OAUTH has no effect",
      "box/provision.sh": "the per-Bot accounts drop-in also sets BOTS_PER_BOT_UID, so a host an app downgrade redeploys stays walled",
      "box/files/per-bot-uid-migrate": "the same drop-in, written by the migration",
      "host/test/box/per-bot-uid-migrate.test.ts": "checks that drop-in",
      "host/test/box/per-bot-uid-dropin-names.test.ts": "checks provision brings an old-name drop-in up to both names",
      "docs/api-key-auth.md": "names the removed BOTS_AUTH_PROXY_OAUTH",
      "docs/HANDOFF.md": "says the old names are still read",
    };
    // UNSAFE_BOTS_INDEX (a lint about the `bots` array) is not an env setting.
    expect(hits(/(?<![A-Z_])BOTS_(?!INDEX\b)[A-Z]/, allowed)).toEqual([]);
  });

  it("the data and log folders are …/Synapse: the other build's …/Bots is named only to leave it alone and by the walls around it", () => {
    const allowed: Record<string, string> = {
      "app/src/main/data-rename.ts": "never moves or reads …/Bots, another build's data (bug 289)",
      "app/test/main/data-rename.test.ts": "tests that …/Bots is left alone",
      "app/test/coordinator/data-root-sandbox.test.ts": "proves the sandbox walls the whole data root under both names (bug 288)",
      "shared/src/app-data.ts": "appDataDirs: every wall around the app's data covers the folder under both names",
      "app/test/coordinator/data-rename-walls.test.ts": "proves the sandbox and the static walls still cover a …/Bots left behind",
      "docs/portable-install.md": "says a …/Bots folder is another build's and is left alone",
      "app/test/main/qwen-sidecar.test.ts": "looks for an installed Python under the old name too, so a Mac not yet migrated still runs the test",
    };
    expect(hits(/(Application\\*\s?Support|Logs)(\/|"\s*,\s*")Bots\b/, allowed)).toEqual([]);
  });
});
