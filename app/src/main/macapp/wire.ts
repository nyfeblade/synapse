/**
 * mac-apps, main-process wiring: the controller the coordinator's local-exec daemon calls (over the parent port)
 * once this Mac's own gate passed, plus the Settings → Computer → Apps panel's three native calls.
 *
 * The helper is WARMED shortly after launch, so the first "text Sam" of the day doesn't pay a process start.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { registerNative } from "../native";
import { MacAppController, type MacAppCall } from "./controller";
import { MacHelper } from "./helper";
import { OsascriptRunner, WarmFirstRunner } from "./osa";
import { MACAPP_APPS, paneUrl, readPermissions, requestPermission } from "./perms";

export interface MacAppsWiring {
  onMessage(m: { type: string; id?: number; req?: unknown }): boolean;
  close(): void;
}

export function registerMacApps(o: {
  /** dist/native/bots-mac, resolved through resolveUnpacked by the caller. */
  binary: string;
  userData: string;
  log(line: string): void;
  post(m: unknown): void;
  home?: string;
  /** FUZZ and e2e runs never touch a real app or a real permission. */
  fuzz?: boolean;
  openExternal?(url: string): Promise<unknown>;
}): MacAppsWiring {
  const helper = new MacHelper({ binary: o.binary, log: o.log });
  const osa = new WarmFirstRunner({ helper, fallback: new OsascriptRunner({}), log: o.log });
  const controller = new MacAppController({ helper, osa, home: o.home ?? os.homedir(), userData: path.join(o.userData, "macapp"), appData: o.userData, log: o.log });

  // SPEED: warm the helper once the app has settled, so the first action is the fast one too.
  const warm = setTimeout(() => void controller.warm().then((up) => o.log(`macapp: helper ${up ? "warm" : "unavailable"}`)), 8_000);
  warm.unref?.();

  registerNative("macapp.permissions", async () => ({ apps: [...MACAPP_APPS], permissions: o.fuzz ? [] : await readPermissions(helper) }));
  /** One short-lived run of the helper: it prompts, prints, and exits. Never the warm one, which must stay quiet. */
  const promptAccessibility = () => new Promise<boolean>((resolve) => {
    execFile(o.binary, ["--prompt-accessibility"], { timeout: 60_000 }, (_e, stdout) => {
      try { resolve((JSON.parse(String(stdout).trim().split("\n").pop() ?? "{}") as { accessibility?: boolean }).accessibility === true); }
      catch { resolve(false); }
    });
  });

  registerNative("macapp.request", async (a: { id?: unknown }) => {
    if (o.fuzz || typeof a?.id !== "string") return { state: "unknown" as const };
    return requestPermission({ helper, osa, promptAccessibility }, a.id);
  });
  registerNative("macapp.openSettings", async (a: { pane?: unknown }) => {
    const url = paneUrl(a?.pane);
    if (!url) return { opened: false };
    if (o.fuzz) return { opened: false };
    await o.openExternal?.(url);
    return { opened: true };
  });

  return {
    onMessage(m) {
      if (m.type !== "macapp" || typeof m.id !== "number") return false;
      const id = m.id;
      void controller.handle(m.req as MacAppCall)
        .catch((e: unknown) => ({ ok: false as const, error: `The app action failed: ${(e as Error).message}` }))
        .then((result) => o.post({ type: "macapp-result", id, result }));
      return true;
    },
    close() {
      clearTimeout(warm);
      controller.close();
    },
  };
}
