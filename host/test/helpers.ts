import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HostConfig } from "../config";

/**
 * A HostConfig rooted in a fresh temp dir, fake brain, stub reviewer, random port — and a healthy
 * fake disk.
 *
 * That last one is load-bearing. DiskGuard.poll() runs from Phase 3's boot() against the real
 * filesystem, and an episode calls DiskSaver.ensure(), which CREATES a Bot. So every host-app test
 * quietly grew an extra "Disk Saver" whenever the machine running the suite sat under
 * LIMITSC.diskSoftPct (15% free) — which is why app-journey's "nothing is listed after I delete the
 * Bot I made" passed and failed on the same commit as the developer's disk filled up. Pass
 * DISK_FREE_PCT in `extra` to drive disk pressure deliberately.
 */
export function tmpConfig(extra: Record<string, string> = {}): HostConfig {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bots-app-"));
  fs.mkdirSync(path.join(d, "workspace"), { recursive: true });
  return loadConfig({
    DATA_ROOT: path.join(d, "agent-data"), HOST_PRIVATE: path.join(d, ".host"), WORKSPACE: path.join(d, "workspace"),
    CLAUDE_CONFIG_DIR: path.join(d, ".claude"), SYNAPSE_CC_MANAGED: path.join(d, "cc-managed"), HOST_PORT: "0", WEBHOOK_PORT: "0", WEBHOOK_BIND: "127.0.0.1", BRAIN: "fake", REVIEWER: "stub", DISK_FREE_PCT: "50", ...extra,
  });
}
