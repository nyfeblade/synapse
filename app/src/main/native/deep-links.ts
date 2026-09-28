import type { App } from "electron";
import { APP_SCHEMES } from "@synapse/shared";
import { emitNative } from "../native";

export { APP_SCHEMES };

/** Bug 286: synapse://, and bots:// (the old name) as an alias for one release. */
export function registerDeepLinks(app: App, ready: () => boolean): void {
  for (const scheme of APP_SCHEMES) app.setAsDefaultProtocolClient(scheme);
  const queue: string[] = [];
  const deliver = (url: string) => (ready() ? emitNative("deep-link", { url }) : queue.push(url));
  app.on("open-url", (e, url) => { e.preventDefault(); if (APP_SCHEMES.some((s) => url.startsWith(`${s}://`))) deliver(url); });
  const flush = setInterval(() => { if (ready()) { for (const u of queue.splice(0)) emitNative("deep-link", { url: u }); clearInterval(flush); } }, 250);
}
