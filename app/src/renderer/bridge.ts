import { GatewayCallError, type CommandName, type GatewayCommands, type GatewayResponse, type SseEvent, type ThemePreference } from "@synapse/shared";
import type { ConnectionState } from "../coordinator/gateway-client";
import { reportFailure } from "./error-channel";

export type { ConnectionState };
export { GatewayCallError };

export interface SynapseBridge {
  call<K extends CommandName>(cmd: K, args: GatewayCommands[K]["args"]): Promise<GatewayResponse<GatewayCommands[K]["result"]>>;
  onEvent(cb: (e: SseEvent) => void): () => void;
  onConnection(cb: (s: ConnectionState) => void): () => void;
  retry(): void;
  appInfo(): Promise<{ userName: string }>;
  vncUrl(botId: string): string | null;
  secrets: {
    /** `unusable`: the reason the Bot can't use this stored name (bug 56); the row offers Rename and Remove. */
    /** `boxOnly` (bug 57): on the box, with no value on this Mac; `kept`: the user chose to leave it there. */
    list(botId: string): Promise<{ name: string; description: string; updatedAt: number; unusable?: string; boxOnly?: true; kept?: true }[]>;
    save(botId: string, name: string, description: string, value: string): Promise<unknown>;
    remove(botId: string, name: string): Promise<unknown>;
    keepOnBox(botId: string, names: string[]): Promise<unknown>;
    rename(botId: string, from: string, to: string): Promise<unknown>;
    submitRequest(botId: string, entryId: string, value: string, meta: { destination: string; field: string | null; label: string }): Promise<string>;
    submitForm(botId: string, entryId: string, answers: Record<string, string>, secrets: Record<string, string>): Promise<string>;
  };
  /** Settings → Account: the key is sealed to the box in the main process; both answer without it. */
  auth: {
    saveKey(value: string): Promise<unknown>;
    testKey(value: string): Promise<unknown>;
    /** Removes the key from the box and this Mac's copy. */
    removeKey(): Promise<unknown>;
    /** This Mac holds its own copy of the key (for the Bots' claude here). */
    hasMacKey(): Promise<boolean>;
    /** New-user walk, finding 2: the Bots' computer's key differs from the one this Mac paired with. */
    pinChanged(): Promise<boolean>;
    /** Pin the Bots' computer's current key ("Trust this computer"). */
    trustComputer(): Promise<{ trusted: boolean }>;
  };
  /** Settings → Account: a model provider's key, sealed to the box in main; neither answer carries it. */
  providers: {
    saveKey(provider: string, value: string): Promise<unknown>;
    testKey(provider: string, value: string): Promise<unknown>;
  };
  box: {
    update(force: boolean): Promise<{ status: "done" | "busy"; busyBotIds?: string[] }>;
    recover(): Promise<void>;
    reset(alsoBots: boolean): Promise<void>;
    info(): Promise<{ bundledImageVersion: string }>;
    onLifecycle(cb: (s: { phase: string; step: string | null; error: string | null }) => void): () => void;
  };
  saveFile(req: { path: string; name: string }): Promise<{ saved: boolean }>;
  onOpenBot(cb: (botId: string) => void): () => void;
  setNativeTheme(pref: ThemePreference): void;
  native: {
    invoke(name: string, args: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }>;
    on(channel: string, cb: (p: unknown) => void): () => void;
  };
}

declare global {
  interface Window {
    synapse: SynapseBridge;
  }
}

async function invoke<K extends CommandName>(cmd: K, args: GatewayCommands[K]["args"]): Promise<GatewayCommands[K]["result"]> {
  const r = await window.synapse.call(cmd, args);
  if (!r.ok) throw new GatewayCallError(r.error.code, r.error.message);
  return r.result;
}

/**
 * A gateway call. A rejection is reported to the user by DEFAULT (error-channel.ts → the sidebar's
 * role="alert" banner) and the promise still rejects, so callers that await inside a try/catch and
 * present the failure themselves behave exactly as before.
 *
 * WHY THE DEFAULT LIVES HERE AND NOT AT THE CALL SITES: nothing about `void call(...)` looked
 * wrong, and TypeScript was perfectly happy with it, so 19 writes across the renderer produced a
 * click that did nothing and said nothing. Making the safe behaviour the one you get by FORGETTING
 * is the only version of this fix that cannot rot — a write added tomorrow is covered without its
 * author knowing this file exists.
 *
 * The internal `.catch` also marks the returned promise as observed, so a fire-and-forget write no
 * longer escapes as an unhandled rejection. It does not consume the rejection: `p` still rejects.
 *
 * Deliberate silence is `callQuiet` — one word, at the call site, where a reader can see it.
 */
export function call<K extends CommandName>(cmd: K, args: GatewayCommands[K]["args"]): Promise<GatewayCommands[K]["result"]> {
  const p = invoke(cmd, args);
  p.catch(reportFailure);
  return p;
}

/**
 * A gateway call whose failure is NOT the user's business — either because the caller presents it
 * itself in place, or because the call is a background probe whose failure has no consequence the
 * user could act on (App.tsx's boot probes: a host killed mid-connect is asked again on the next
 * connect). Every use owes a comment saying which of the two it is.
 */
export function callQuiet<K extends CommandName>(cmd: K, args: GatewayCommands[K]["args"]): Promise<GatewayCommands[K]["result"]> {
  return invoke(cmd, args);
}
