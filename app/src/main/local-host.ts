import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_LOGIN_VARS } from "@synapse/shared";

/** stop({ keepData: true }) keeps a disposable store for a restart on the same root (FUZZ reconnect after the host died). */
export interface LocalHost { baseUrl: string; token: string; root: string; stop(o?: { keepData?: boolean }): Promise<void> }

/** FUZZ=1 / SYNAPSE_LOCAL_HOST=1: a host on the Mac with the fake brain and stub reviewer. Never real Claude. */
export async function launchLocalHost(o: {
  bundle: string; dataDir: string; disposable: boolean; nodePath?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number;
  /** Reuse this disposable store (a restart) instead of creating a new one. */
  root?: string;
  /** Never remove `root` on stop (a store the caller owns: SYNAPSE_FUZZ_HOST_ROOT). */
  keepRoot?: boolean;
}): Promise<LocalHost> {
  const root = o.disposable ? (o.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "synapse-fuzz-"))) : o.dataDir;
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...(o.env ?? process.env),
    ELECTRON_RUN_AS_NODE: "1", BRAIN: "fake", REVIEWER: "stub", HOST_PORT: "0", HOST_BIND: "127.0.0.1", BOX_HOME: root,
    DATA_ROOT: path.join(root, "agent-data"), HOST_PRIVATE: path.join(root, ".host"),
    WORKSPACE: path.join(root, "workspace"), CLAUDE_CONFIG_DIR: path.join(root, ".claude"), SYNAPSE_CC_MANAGED: path.join(root, "cc-managed"),
    // A disposable FUZZ/e2e host takes an ephemeral webhook port, so a busy 47801 (another app or worktree) can't kill it.
    ...(o.disposable ? { WEBHOOK_PORT: (o.env ?? process.env).WEBHOOK_PORT ?? "0" } : {}),
  };
  // synapse-public: the local host never inherits a Claude login or a stray API key (login-scrub.ts).
  for (const k of CLAUDE_LOGIN_VARS) delete env[k]; // the shared list (shared/src/claude-env.ts)
  const infoFile = path.join(root, ".host", "gateway.json");
  if (fs.existsSync(infoFile)) fs.rmSync(infoFile);
  const child = spawn(o.nodePath ?? process.execPath, [o.bundle, "serve"], { env, stdio: "ignore" });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const deadline = Date.now() + (o.timeoutMs ?? 15_000);
  while (!fs.existsSync(infoFile)) {
    if (child.exitCode !== null) throw new Error("The local host exited during start-up.");
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error("The local host did not start in time."); }
    await new Promise((r) => setTimeout(r, 50));
  }
  const info = JSON.parse(fs.readFileSync(infoFile, "utf8")) as { port: number; token: string };
  return {
    baseUrl: `http://127.0.0.1:${info.port}`,
    token: info.token,
    root,
    stop: async (so) => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
      if (o.disposable && !so?.keepData && !o.keepRoot) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); // ENOTEMPTY races retry
    },
  };
}
