import path from "node:path";
import type { App } from "electron";
import { emitNative } from "../native";
import { allowDroppedPath } from "./files";

export function isBotpackPath(p: string): boolean {
  return typeof p === "string" && path.isAbsolute(p) && path.extname(p).toLowerCase() === ".botpack";
}

function take(p: string, ready: () => boolean, queue: string[]): void {
  if (!isBotpackPath(p)) return;
  allowDroppedPath(p);
  if (ready()) emitNative("import-bot-file", { path: p });
  else queue.push(p);
}

/** Double-click / AirDrop a `.botpack` into this Synapse — same preview as File → Import Bot. */
export function registerOpenBotpacks(app: App, ready: () => boolean): void {
  const queue: string[] = [];
  app.on("open-file", (e, p) => { e.preventDefault(); take(p, ready, queue); });
  app.on("second-instance", (_e, argv) => { for (const a of argv) take(a, ready, queue); });
  for (const a of process.argv) take(a, ready, queue);
  const flush = setInterval(() => {
    if (!ready()) return;
    for (const p of queue.splice(0)) emitNative("import-bot-file", { path: p });
    clearInterval(flush);
  }, 250);
}
