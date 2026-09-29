import { STR, type AuthTestResult, type AuthView } from "@synapse/shared";
import type { BoxPin } from "./box-pin";
import type { Call } from "./gateway-call";

const PIN_MISMATCH = "The computer's identity changed. Confirm it in Settings → Updates before sending secrets.";

/**
 * The Mac's own copy of the key, for the Bots' claude on this Mac. Review fix 4: it is kept by the coordinator
 * (coordinator/local-exec/wiring.ts macKey), which owns the permission key file and creates it on demand; main asks it
 * over the parent port.
 */
export interface MacKeyCopy { save(key: string): Promise<{ ok: boolean; error?: string }>; clear(): Promise<void>; has(): Promise<boolean> }

/** What a save answers: the host's view, and whether this Mac kept its copy (and why not). */
export type SavedKeyView = AuthView & { macSaved: boolean; macError?: string };

/**
 * Settings → Account and the setup screen: the Anthropic API key typed in the renderer comes here over IPC and leaves
 * only sealed to the box's public key (crypto_box_seal, like every Bot secret). A saved key is also kept on this Mac
 * (encrypted with the profile's local-policy.key, never the keychain) for a Bot's wrapped `claude` here, and removed
 * with it. Nothing here logs it, and the renderer gets back the host's view, which carries the masked key only.
 */
export function createApiKeySender(o: { call: Call; pin: Pick<BoxPin, "check">; seal(publicKey: string, value: string): Promise<string>; mac?: MacKeyCopy; log?(s: string): void }) {
  const sealed = async (value: string): Promise<string> => {
    const { boxPublicKey } = await o.call("getAuth", {});
    if (o.pin.check(boxPublicKey) === "mismatch") throw new Error(PIN_MISMATCH);
    return o.seal(boxPublicKey, String(value ?? "").trim());
  };
  const fail = (what: string, e: unknown): string => {
    const why = e instanceof Error ? e.message : String(e);
    o.log?.(`api key: the Mac copy couldn't be ${what} (${why})`);
    return why;
  };
  // One key operation at a time, in the order asked: the panel may stop waiting on a slow Save, and a Remove pressed
  // then must not be overtaken by that Save landing afterwards (the key would come back). A failure doesn't block the next.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  return {
    save: (value: string): Promise<SavedKeyView> => inTurn(async () => {
      const v = await o.call("setApiKey", { sealed: await sealed(value) });
      if (!o.mac) return { ...v, macSaved: false };
      // Only a key the box accepted. Review fix 4: a failed Mac copy is reported to the renderer, not only logged.
      try {
        const r = await o.mac.save(String(value ?? "").trim());
        if (r.ok) return { ...v, macSaved: true };
        return { ...v, macSaved: false, macError: fail("saved", r.error ?? "unknown") };
      } catch (e) {
        return { ...v, macSaved: false, macError: fail("saved", e) };
      }
    }),
    test: (value: string): Promise<AuthTestResult> => inTurn(async () => o.call("testAuthConnection", { sealed: await sealed(value) })),
    /** Security review (minor 5): whether this Mac has its copy (the box never sends the key back, so it's asked for once). */
    hasMacCopy: async (): Promise<boolean> => { try { return (await o.mac?.has()) ?? false; } catch { return false; } },
    remove: (): Promise<AuthView> => inTurn(async () => {
      const v = await o.call("clearApiKey", {});
      try { await o.mac?.clear(); } catch (e) { fail("removed", e); }
      return v;
    }),
  };
}

export type ApiKeySender = ReturnType<typeof createApiKeySender>;
interface IpcLike { removeHandler(channel: string): void; handle(channel: string, fn: (e: unknown, ...a: unknown[]) => unknown): void }

/**
 * The Account panel's IPC, registered once at start-up. Before the app has connected (or when the connection failed)
 * a Save / Test / Remove answers with why, the connection's own failure first (another account's host), instead of
 * Electron's "No handler registered" or nothing at all.
 */
export function registerAuthIpc(ipc: IpcLike, sender: () => ApiKeySender | null, connectError: () => string | null): void {
  const need = (): ApiKeySender => {
    const s = sender();
    if (!s) throw new Error(connectError() ?? STR.hostNotConnected);
    return s;
  };
  const routes: Array<[string, (...a: never[]) => Promise<unknown>]> = [
    ["auth:save-key", async (value: string) => need().save(value)],
    ["auth:test-key", async (value: string) => need().test(value)],
    ["auth:remove-key", async () => need().remove()],
    ["auth:has-mac-key", async () => (sender() ? sender()!.hasMacCopy() : false)],
  ];
  for (const [ch, fn] of routes) {
    ipc.removeHandler(ch);
    ipc.handle(ch, (_e, ...a) => (fn as (...x: unknown[]) => Promise<unknown>)(...a));
  }
}
