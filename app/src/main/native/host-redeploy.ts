import fs from "node:fs";
import path from "node:path";

/**
 * Updates: the app ships its host (Contents/Resources/box/host-dist.tgz, streamed by deploy.sh, and
 * host/dist/build-id.txt beside the local copy). When the box runs a different host build, this
 * redeploys it — but only once no Bot is mid-turn. It asks the host's own "can we restart?" check
 * (prepareBoxRestart, force: false) and waits between tries; it never forces, so a working Bot is
 * never killed. A host too old to report its build is treated as different.
 */
export async function redeployHostIfChanged(o: {
  bundledBuild(): string | null;
  health(): Promise<{ hostBuild?: string | null } | null>;
  prepare(): Promise<{ ok: boolean; busyBotIds: string[] }>;
  deploy(): Promise<void>;
  waitHealthy(): Promise<void>;
  sleep?(ms: number): Promise<void>;
  log(line: string): void;
  retryMs?: number;
}): Promise<"current" | "skipped" | "deployed"> {
  const want = o.bundledBuild();
  if (!want) return "skipped";
  const h = await o.health();
  if (h?.hostBuild === want) return "current";
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  o.log(`host redeploy: box runs ${h?.hostBuild ?? "an older host"}, this app ships ${want}`);
  for (;;) {
    const p = await o.prepare();
    if (p.ok) break;
    o.log(`host redeploy: waiting for ${p.busyBotIds.length} working Bot(s)`);
    await sleep(o.retryMs ?? 20_000);
  }
  await o.deploy();
  await o.waitHealthy();
  o.log("host redeploy: done");
  return "deployed";
}

/** The build id of the host this packaged app ships (package.mjs copies host/dist into Resources/host). */
export function bundledHostBuild(resourcesPath: string): string | null {
  try {
    const id = fs.readFileSync(path.join(resourcesPath, "host", "dist", "build-id.txt"), "utf8").trim();
    return /^[0-9a-f]{16}$/.test(id) ? id : null;
  } catch { return null; }
}
