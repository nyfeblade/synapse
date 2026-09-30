import fs from "node:fs";
import path from "node:path";
import { hostOutDir } from "../util/host-out";
import { removeHostOwnedPath, writeHostOwnedFile } from "../util/host-owned-file";
import type { DisplayManager } from "./displays";

export interface CaptureResult { webp: Buffer; path: string | null; dataUrl: string; display: string }
const KEEP = 200;

/**
 * Controller ruling: must never write a screenshot through a Bot-controlled symlink as bothost. Final secfix round 3
 * (ruling 4): screenshots live in /workspace/.host-out/screens/<bot> (bothost-owned 2750 all the way down, box reads
 * via the bots group) and are written through writeHostOwnedFile (every component host-owned, O_EXCL|O_NOFOLLOW, the
 * created file verified before a byte is written). Mode 0640 so the Bot can read its own screenshots back, matching
 * the tool text that tells it the save path. `path` is null when the write is refused (a swapped directory, or a
 * same-millisecond name collision) — the webp/dataUrl are still returned.
 */
export async function captureScreen(o: { displays: DisplayManager; botId: string; workspace: string; now(): number; size?: { w: number; h: number } }): Promise<CaptureResult> {
  const info = await o.displays.ensure(o.botId);
  const webp = await o.displays.x(o.botId).screenshotWebp(o.size);
  const dir = path.join(hostOutDir(o.workspace, "screens"), o.botId);
  const file = writeHostOwnedFile(o.workspace, dir, `${o.now()}.webp`, webp, 0o640);
  if (file) {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".webp")).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) removeHostOwnedPath(o.workspace, path.join(dir, old));
  }
  return { webp, path: file, dataUrl: `data:image/webp;base64,${webp.toString("base64")}`, display: info.display };
}
