import fs from "node:fs";
import path from "node:path";
import { ACP_CONSENT_VERSION, PROVIDER_CONSENT_VERSION, type AcpVendorId, type ProviderId } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import { PROVIDER_AUTH_DIR } from "./provider-keys";

/**
 * ProviderConsentStore (spec §4, owner answer 4): a one-time data-sharing consent per provider, recorded with the
 * version of the text the user agreed to. Nothing is sent to a provider without it: the gateway refuses to make it any
 * Bot's model, and providerFetch refuses the call (defense in depth).
 *
 * Kept in hostPrivate/provider-auth/consent.json (0600, bothost), not in the host settings, so no settings import or
 * sync can write a consent the user never gave. Anthropic counts as consented: there are no earlier installs to ask,
 * and a Claude key is only ever saved through the setup step that already names what goes to Anthropic.
 */
/** Wave 3: a vendor coding CLI's consent is kept here too, under "acp:<vendor>" (the same one-time rule). */
type ConsentKey = ProviderId | `acp:${AcpVendorId}`;
interface OnDisk { consents: Partial<Record<ConsentKey, { at: number; textVersion: number }>> }

export class ProviderConsentStore {
  private state: OnDisk;
  constructor(private o: { dir: string; now?: () => number; onChange?: (p: ProviderId) => void }) {
    const raw = readJson<Partial<OnDisk>>(this.file, {});
    this.state = { consents: raw.consents && typeof raw.consents === "object" ? raw.consents : {} };
  }
  private get file(): string { return path.join(this.o.dir, "consent.json"); }

  consented(p: ProviderId): boolean {
    if (p === "anthropic") return true;
    const c = this.state.consents[p];
    return !!c && c.textVersion >= PROVIDER_CONSENT_VERSION;
  }

  /** The user agreed to `textVersion` of the consent text. An older version than the current one is refused. */
  consent(p: ProviderId, textVersion: number): void {
    if (textVersion !== PROVIDER_CONSENT_VERSION) throw new Error("out-of-date consent text");
    this.state.consents[p] = { at: (this.o.now ?? Date.now)(), textVersion };
    this.save(p);
  }

  /** A vendor coding CLI (Wave 3): the same one-time consent, with its own text version. */
  consentedAcp(v: AcpVendorId): boolean {
    const c = this.state.consents[`acp:${v}`];
    return !!c && c.textVersion >= ACP_CONSENT_VERSION;
  }
  consentAcp(v: AcpVendorId, textVersion: number): void {
    if (textVersion !== ACP_CONSENT_VERSION) throw new Error("out-of-date consent text");
    this.state.consents[`acp:${v}`] = { at: (this.o.now ?? Date.now)(), textVersion };
    this.save(null);
  }

  withdraw(p: ProviderId): void {
    delete this.state.consents[p];
    this.save(p);
  }

  private save(p: ProviderId | null): void {
    fs.mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.file, this.state, 0o600);
    if (p) this.o.onChange?.(p);
  }
}

export function providerConsentStoreFor(cfg: { hostPrivate: string }, o: { now?: () => number; onChange?: (p: ProviderId) => void } = {}): ProviderConsentStore {
  return new ProviderConsentStore({ dir: path.join(cfg.hostPrivate, PROVIDER_AUTH_DIR), ...o });
}
