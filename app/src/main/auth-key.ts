import { createHash } from "node:crypto";
import { STR, STR_AUTH, type AuthTestResult, type AuthView, type KeyedProvider, type KeysView, type ProviderTestResult, type ProvidersView } from "@synapse/shared";
import type { BoxPin } from "./box-pin";
import type { Call } from "./gateway-call";

const PIN_MISMATCH = STR_AUTH.pinMismatch;

/**
 * The Mac's own copy of the key, for the Bots' claude on this Mac. Review fix 4: it is kept by the coordinator
 * (coordinator/local-exec/wiring.ts macKey), which owns the permission key file and creates it on demand; main asks it
 * over the parent port.
 */
export interface MacKeyCopy { save(key: string): Promise<{ ok: boolean; error?: string }>; clear(): Promise<void>; has(): Promise<boolean> }
/**
 * 0.1.7, several Anthropic keys: the Mac's copy follows the box's DEFAULT key. Keys added from this Mac that aren't the
 * default wait beside it as spares (kept by the coordinator, sealed like the copy); Make default promotes one.
 */
export interface MacSpareKeys {
  saveSpare(keyId: string, key: string): Promise<void>;
  dropSpare(keyId: string): Promise<void>;
  /** `keyId` is the default now; the copy it replaces is kept as `oldId`'s spare (null: it was removed). */
  promote(keyId: string, oldId: string | null): Promise<boolean>;
}

/** What a save answers: the host's view, and whether this Mac kept its copy (and why not). */
export type SavedKeyView = AuthView & { macSaved: boolean; macError?: string };

/**
 * Settings → Account and the setup screen: the Anthropic API key typed in the renderer comes here over IPC and leaves
 * only sealed to the box's public key (crypto_box_seal, like every Bot secret). A saved key is also kept on this Mac
 * (encrypted with the profile's local-policy.key, never the keychain) for a Bot's wrapped `claude` here, and removed
 * with it. Nothing here logs it, and the renderer gets back the host's view, which carries the masked key only.
 */
export function createApiKeySender(o: { call: Call; pin: Pick<BoxPin, "check" | "pinned" | "repin">;
  /**
   * Review of new-user walk finding 2: "Trust this computer" is confirmed HERE, in the main process (a native dialog
   * with both keys' fingerprints, Cancel the default). Nothing the renderer sends can stand in for it. Absent: refused.
   */
  confirmTrust?(oldFingerprint: string, newFingerprint: string): Promise<boolean>; seal(publicKey: string, value: string): Promise<string>; mac?: MacKeyCopy; log?(s: string): void }) {
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
    /** New-user walk, finding 2: the box's key no longer matches the one this Mac pinned. */
    pinChanged: async (): Promise<boolean> => o.pin.check((await o.call("getAuth", {})).boxPublicKey) === "mismatch",
    /**
     * "Trust this computer": fetch the box's key first (a failure leaves the old pin), ask the user in main, and only on
     * their yes replace the pin in one write. It never sends the API key: the user presses Save again afterwards.
     */
    trust: (): Promise<{ trusted: boolean }> => inTurn(async () => {
      const { boxPublicKey } = await o.call("getAuth", {});
      const old = o.pin.pinned();
      if (old === boxPublicKey) return { trusted: true };
      const yes = o.confirmTrust ? await o.confirmTrust(old ? boxKeyFingerprint(old) : "—", boxKeyFingerprint(boxPublicKey)) : false;
      if (!yes) return { trusted: false };
      o.pin.repin(boxPublicKey);
      return { trusted: true };
    }),
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

/** A box key, short enough to compare by eye: SHA-256 of the key, first 16 bytes, hex in groups of four. */
export function boxKeyFingerprint(publicKeyB64: string): string {
  const hex = createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 32);
  return hex.match(/.{4}/g)!.join(" ");
}

/**
 * The main-process confirmation for "Trust this computer". Cancel is the default (Return) and the
 * cancel (Escape) button. The buttons are listed action-first because macOS lays an alert's buttons
 * out right to left: this puts Cancel on the left and Trust on the right, the same order as every
 * in-app dialog and the app's other native alert (Replace / Cancel), with the risky act never the default.
 */
export async function confirmTrustDialog(show: (o: { type: "warning"; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }) => Promise<{ response: number }>, oldFp: string, newFp: string): Promise<boolean> {
  const r = await show({ type: "warning", message: STR_AUTH.trustConfirmTitle, detail: STR_AUTH.trustConfirmDetail(oldFp, newFp), buttons: [STR_AUTH.trustComputer, STR_AUTH.trustConfirmCancel], defaultId: 1, cancelId: 1 });
  return r.response === 0;
}
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
    ["auth:pin-changed", async () => (sender() ? sender()!.pinChanged().catch(() => false) : false)],
    // Takes no arguments on purpose: whatever the renderer passes, the confirmation happens in main.
    ["auth:trust-computer", async () => need().trust()],
  ];
  for (const [ch, fn] of routes) {
    ipc.removeHandler(ch);
    ipc.handle(ch, (_e, ...a) => (fn as (...x: unknown[]) => Promise<unknown>)(...a));
  }
}

/**
 * Settings → Account: a model provider's key typed in the renderer comes here over IPC and leaves only sealed to the
 * box's public key (the same pin check as the Anthropic key). The Mac keeps no copy (spec §4); the host answers with
 * the masked key at most.
 */
export function createProviderKeySender(o: { call: Call; pin: Pick<BoxPin, "check">; seal(publicKey: string, value: string): Promise<string>; mac?: Pick<MacKeyCopy, "save" | "clear"> & MacSpareKeys; log?(s: string): void }) {
  const anthropic = (v: KeysView) => v.rings.find((r) => r.provider === "anthropic")?.keys ?? [];
  const defaultOf = (v: KeysView) => anthropic(v).find((k) => k.isDefault)?.id ?? null;
  // The Mac copy is a convenience for the Bots' claude on this Mac: a failure to follow is logged, never fails the change.
  const onMac = async (what: string, fn: (m: NonNullable<typeof o.mac>) => Promise<unknown>) => {
    if (!o.mac) return;
    try { await fn(o.mac); } catch (e) { o.log?.(`api key: the Mac copy couldn't be ${what} (${e instanceof Error ? e.message : String(e)})`); }
  };
  const sealed = async (value: string): Promise<string> => {
    const { boxPublicKey } = await o.call("getProviders", {});
    if (o.pin.check(boxPublicKey) === "mismatch") throw new Error(PIN_MISMATCH);
    return o.seal(boxPublicKey, String(value ?? "").trim());
  };
  type P = ProvidersView["providers"][number]["id"];
  return {
    save: async (provider: P, value: string): Promise<ProvidersView> => o.call("setProviderKey", { provider, sealed: await sealed(value) }),
    test: async (provider: P, value: string): Promise<ProviderTestResult> => o.call("testProviderKey", value ? { provider, sealed: await sealed(value) } : { provider }),
    /** 0.1.7: another named key for a provider (Anthropic too), sealed to the box like every key. */
    addKey: async (provider: KeyedProvider, value: string, label: string): Promise<KeysView> => {
      const { boxPublicKey } = await o.call("getKeys", {});
      if (o.pin.check(boxPublicKey) === "mismatch") throw new Error(PIN_MISMATCH);
      const before = await o.call("getKeys", {});
      const key = String(value ?? "").trim();
      const v = await o.call("addKey", { provider, sealed: await o.seal(boxPublicKey, key), label: String(label ?? "") });
      if (provider === "anthropic") {
        const added = anthropic(v).find((k) => !anthropic(before).some((b) => b.id === k.id));
        // The first key is the default: it becomes the Mac's copy. Another waits as a spare for Make default.
        if (added) await onMac("saved", (m) => (added.isDefault ? m.save(key) : m.saveSpare(added.id, key)));
      }
      return v;
    },
    /** 0.1.7: Make default; for Anthropic the Mac's copy follows the new default. */
    makeDefault: async (provider: KeyedProvider, keyId: string): Promise<KeysView> => {
      const old = provider === "anthropic" ? defaultOf(await o.call("getKeys", {})) : null;
      const v = await o.call("setDefaultKey", { provider, keyId });
      if (provider === "anthropic" && old !== keyId) await onMac("moved", (m) => m.promote(keyId, old));
      return v;
    },
    /** 0.1.7: Remove; for Anthropic the Mac's copy goes with the default and follows the next one, or a spare goes. */
    removeKey: async (provider: KeyedProvider, keyId: string): Promise<KeysView> => {
      const wasDefault = provider === "anthropic" && defaultOf(await o.call("getKeys", {})) === keyId;
      const v = await o.call("removeKey", { provider, keyId });
      if (provider === "anthropic") {
        const next = defaultOf(v);
        await onMac("removed", (m) => (!wasDefault ? m.dropSpare(keyId) : next ? m.promote(next, null) : m.clear()));
      }
      return v;
    },
  };
}
export type ProviderKeySender = ReturnType<typeof createProviderKeySender>;

export function registerProviderIpc(ipc: IpcLike, sender: () => ProviderKeySender | null, connectError: () => string | null): void {
  const need = (): ProviderKeySender => {
    const s = sender();
    if (!s) throw new Error(connectError() ?? STR.hostNotConnected);
    return s;
  };
  const routes: Array<[string, (...a: never[]) => Promise<unknown>]> = [
    ["providers:save-key", async (p: string, value: string) => need().save(p as never, value)],
    ["providers:test-key", async (p: string, value: string) => need().test(p as never, value)],
    ["keys:add", async (p: string, value: string, label: string) => need().addKey(p as never, value, label)],
    ["keys:make-default", async (p: string, keyId: string) => need().makeDefault(p as never, String(keyId))],
    ["keys:remove", async (p: string, keyId: string) => need().removeKey(p as never, String(keyId))],
  ];
  for (const [ch, fn] of routes) {
    ipc.removeHandler(ch);
    ipc.handle(ch, (_e, ...a) => (fn as (...x: unknown[]) => Promise<unknown>)(...a));
  }
}
