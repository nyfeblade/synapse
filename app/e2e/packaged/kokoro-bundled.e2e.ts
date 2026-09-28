import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { bundleRoot, findPackagedApp } from "./artifact";
import { test } from "../page-errors";

/**
 * Portable install: the SHIPPED app speaks with the Kokoro voice it bundles, on a clean profile, with a HOME
 * that has no voice setup outside Synapse's own data, no Hugging Face cache and no Python of the user's — nothing but the bundle. It runs
 * the app's own self-test mode (SYNAPSE_KOKORO_SELFTEST: the real detection path, the real sidecar, one line
 * rendered to a WAV — no audio device), checks the take is not silent, and checks the bundle's seal still
 * verifies afterwards (not one .pyc was written into it).
 */
const exe = findPackagedApp();
const bundle = bundleRoot(exe);

test("the packaged app speaks with its bundled Kokoro, on a clean profile and an empty HOME", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-clean-home-"));
  const profile = `kokoro${process.pid}${Date.now().toString(36)}`;
  const wav = path.join(home, "kokoro.wav");
  try {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: os.tmpdir(), APP_PROFILE: profile, SYNAPSE_KOKORO_SELFTEST: wav };
    const r = spawnSync(exe, [], { env, encoding: "utf8", timeout: 180_000 });
    const result = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as { ok?: boolean; source?: string; python?: string; seconds?: number; rms?: number; reason?: string };
    expect(result, r.stderr.slice(-2000)).toMatchObject({ ok: true, source: "bundled" });
    expect(result.python).toBe(path.join(bundle, "Contents", "Resources", "kokoro", "python", "bin", "python3.12"));
    expect(result.seconds!).toBeGreaterThan(1);
    expect(result.rms!).toBeGreaterThan(0.005);
    expect(fs.statSync(wav).size).toBeGreaterThan(44 + 24_000);
    expect(r.stderr).not.toMatch(/huggingface|hf-cache/i);
    const seal = spawnSync("codesign", ["--verify", "--deep", "--strict", bundle], { encoding: "utf8", timeout: 120_000 });
    expect(seal.status, seal.stderr).toBe(0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    // Electron keeps its profile under the real Application Support (NSSearchPath ignores HOME).
    fs.rmSync(path.join(os.homedir(), "Library", "Application Support", "Synapse", "profiles", profile), { recursive: true, force: true });
  }
});
