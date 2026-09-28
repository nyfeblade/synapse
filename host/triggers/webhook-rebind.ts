import { STR } from "@synapse/shared";

/**
 * Bug 52: a failed LAN re-bind used to leave webhookLan = true while the listener was still on
 * 127.0.0.1. The switch then lied. Revert the setting to the last address that actually bound.
 */
export async function applyWebhookLanRebind(p: {
  previousLan: boolean;
  rebind(): Promise<void>;
  revert(lan: boolean): void;
  notify?(err: unknown): void;
}): Promise<boolean> {
  try {
    await p.rebind();
    return true;
  } catch (err) {
    p.revert(p.previousLan);
    p.notify?.(err);
    return false;
  }
}

export interface WebhookLanDeps {
  /** What the setting says now. */
  lan(): boolean;
  /** Binds the webhook listener to the address the setting names. */
  listen(): Promise<unknown>;
  close(): Promise<void>;
  /** Puts the setting back (a published settings change). */
  revert(lan: boolean): void;
  /** What the "Reachable on your local network" row says about the last change; null = nothing wrong. */
  setError(message: string | null): void;
  notify?(err: unknown): void;
}

/**
 * The `host-settings` reaction phase4 installs: when `webhookLan` changes, move the listener.
 * Changes are applied one at a time, in order.
 */
export function webhookLanWatcher(d: WebhookLanDeps): { changed(): Promise<void> } {
  let bound = d.lan();
  let chain: Promise<void> = Promise.resolve();
  return {
    changed: () => (chain = chain.then(async () => {
      const next = d.lan();
      if (next === bound) return;
      let failure: unknown = null;
      const ok = await applyWebhookLanRebind({
        previousLan: bound,
        rebind: () => d.close().then(() => d.listen()).then(() => undefined),
        revert: d.revert,
        notify: (err) => { failure = err; d.notify?.(err); },
      });
      if (ok) { bound = next; d.setError(null); return; }
      // The old listener was closed before the new bind was tried, so reverting the setting alone
      // would leave the switch saying "this computer only" while nothing listens at all.
      let restored = true;
      try { await d.listen(); } catch (err) { restored = false; d.notify?.(err); }
      const reason = (failure as NodeJS.ErrnoException | null)?.code ?? String(failure);
      d.setError(STR.webhookLanFailed(reason, restored));
    })),
  };
}
