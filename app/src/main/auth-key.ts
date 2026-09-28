import type { AuthTestResult, AuthView } from "@synapse/shared";
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
  return {
    save: async (value: string): Promise<SavedKeyView> => {
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
    },
    test: async (value: string): Promise<AuthTestResult> => o.call("testAuthConnection", { sealed: await sealed(value) }),
    /** Security review (minor 5): whether this Mac has its copy (the box never sends the key back, so it's asked for once). */
    hasMacCopy: async (): Promise<boolean> => { try { return (await o.mac?.has()) ?? false; } catch { return false; } },
    remove: async (): Promise<AuthView> => {
      const v = await o.call("clearApiKey", {});
      try { await o.mac?.clear(); } catch (e) { fail("removed", e); }
      return v;
    },
  };
}
