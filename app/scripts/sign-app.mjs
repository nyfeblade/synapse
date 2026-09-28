// Bug 99: sign the packaged Synapse.app — with the stable local identity when this Mac has one
// (scripts/signing-identity.mjs), ad hoc otherwise (CI, or SYNAPSE_ADHOC_SIGN=1).
//
// Inside-out, one identity, one entitlements file:
//   1. loose Mach-O files under Contents/Resources (the bots-dictation helper), each with its own
//      identifier — codesign --deep only walks nested bundles, never Resources;
//   2. every nested bundle (Electron frameworks, the Synapse Helper apps) via --deep;
//   3. the app itself, last, with its fixed identifier, sealing everything above.
// Hardened runtime is NOT enabled: it is only needed for notarization, and with a team-less
// self-signed certificate library validation would refuse Electron's own frameworks. The
// entitlements still carry com.apple.security.device.audio-input so turning the runtime on later
// cannot silently cost the microphone.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IDENTITY_NAME, findIdentity } from "./signing-identity.mjs";

export const APP_IDENTIFIER = "com.nyfeblade.synapse";

/**
 * Which identity to sign with: the "Synapse Local Signing" identity that already exists on this Mac.
 * Portable install: packaging never creates one (a new certificate is a new code identity — every
 * install would lose its permissions and refuse the update), and it never falls back to ad hoc on its
 * own: a Mac without the identity fails here, loudly. Ad hoc only when asked (CI, SYNAPSE_ADHOC_SIGN=1).
 */
export function chooseSigningIdentity({ env = process.env, find = findIdentity, warn = console.warn } = {}) {
  if (env.CI || env.SYNAPSE_ADHOC_SIGN === "1") {
    warn("package: signing ad hoc, as asked (SYNAPSE_ADHOC_SIGN=1 / CI). macOS permissions will not persist across builds, and an installed Synapse will refuse this build as an update.");
    return { identity: "-", adhoc: true };
  }
  const found = find();
  if (!found) throw new Error(`package: the "${IDENTITY_NAME}" signing identity isn't in this Mac's keychain. Package on the Mac that has it, or set SYNAPSE_ADHOC_SIGN=1 for a throwaway build (it can't update an installed Synapse).`);
  return { identity: found, adhoc: false };
}

const MACHO = new Set(["feedfacf", "cffaedfe", "cafebabe", "bebafeca", "feedface", "cefaedfe"]);
function isMachO(file) {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(4);
    return fs.readSync(fd, b, 0, 4, 0) === 4 && MACHO.has(b.toString("hex"));
  } finally {
    fs.closeSync(fd);
  }
}

function looseMachO(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...looseMachO(p));
    else if (e.isFile() && isMachO(p)) out.push(p);
  }
  return out;
}

/**
 * One small signing call first, with a hard 5 s limit. If the private key's ACL does not yet let
 * codesign in, macOS shows a "codesign wants to access key" dialog for EVERY call — dozens for an
 * Electron app. Failing fast here turns that into one clear instruction instead of a wall of
 * prompts. (The fix, once: answer "Always Allow" on that dialog — see docs/release.md.)
 */
export function preflightSigning(identity, run = (file) => execFileSync("codesign", ["--force", "-s", identity, file], { stdio: "ignore", timeout: 5_000 })) {
  if (identity === "-") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-sign-probe-"));
  const probe = path.join(dir, "probe");
  try {
    fs.copyFileSync("/usr/bin/true", probe);
    run(probe);
  } catch (e) {
    throw new Error(`package: a test signing with "${identity}" did not finish in 5 s — macOS is probably asking to let codesign use the "Synapse Local Signing" key. Answer "Always Allow" once (enter your login password), then package again. Or set SYNAPSE_ADHOC_SIGN=1. (${e instanceof Error ? e.message : String(e)})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Sign `app` (a .app path). Returns the identity used ("-" for ad hoc). */
export function signApp(app, { identity, entitlements, run = (args) => execFileSync("codesign", args, { stdio: "inherit", timeout: 120_000 }) }) {
  preflightSigning(identity);
  const ent = ["--entitlements", entitlements];
  for (const bin of looseMachO(path.join(app, "Contents", "Resources"))) {
    const name = path.basename(bin).replace(/^bots-/, "").replace(/[^A-Za-z0-9.-]/g, "-");
    run(["--force", "-s", identity, "--identifier", `${APP_IDENTIFIER}.${name}`, ...ent, bin]);
  }
  run(["--force", "--deep", "-s", identity, app]);
  run(["--force", "-s", identity, "--identifier", APP_IDENTIFIER, ...ent, app]);
  run(["--verify", "--deep", "--strict", app]);
  return identity;
}
