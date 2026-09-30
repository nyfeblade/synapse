import {
  ACP_CONSENT_VERSION, ACP_VENDOR_IDS, ACP_VENDORS, STR_ACP, acpConsentText, isAcpVendorId, type AcpVendorId, type AcpVendorsView,
} from "@synapse/shared";
import type { ProviderConsentStore } from "../../auth/provider-consent";
import { GatewayError } from "../../gateway/errors";
import type { CommandHandlers } from "../../gateway/server";
import type { AcpInstaller } from "./install";
import type { AcpLogins } from "./login";

/**
 * Settings → Account, the coding CLIs (Wave 3): the one-time consent per vendor, "Sign in with <vendor>" for a Bot,
 * and a check of whether that Bot is signed in. Each vendor shows "Included in your <vendor> plan" and Experimental.
 */
export function createAcpCommands(o: { consent: ProviderConsentStore; logins: AcpLogins; hasBot(id: string): boolean; installer?: AcpInstaller }): CommandHandlers {
  const view = (): AcpVendorsView => ({
    vendors: ACP_VENDOR_IDS.map((id) => ({
      id, label: ACP_VENDORS[id].label, status: ACP_VENDORS[id].status, consented: o.consent.consentedAcp(id),
      consentText: acpConsentText(id), consentVersion: ACP_CONSENT_VERSION, planNote: STR_ACP.planNote(id), loginFlow: ACP_VENDORS[id].loginFlow,
      ...(o.installer ? { install: o.installer.view(id) } : {}),
    })),
    ...(o.installer?.accountsNeeded() ? { accountsNeeded: true } : {}),
  });
  // 0.1.6: Install / Remove are the owner's alone (Settings; parity.ts marks them user-only, so no Bot tool reaches them).
  const install = (verb: "install" | "remove") => (a: { vendor?: unknown }): AcpVendorsView => {
    const v = vendor(a.vendor);
    if (!o.installer) throw new GatewayError("UNAVAILABLE", STR_ACP.offBox);
    try { o.installer.start(v, verb); } catch (e) { throw new GatewayError("UNAVAILABLE", e instanceof Error ? e.message : String(e)); }
    return view();
  };
  const vendor = (v: unknown): AcpVendorId => {
    if (!isAcpVendorId(v)) throw new GatewayError("BAD_PROVIDER", "Unknown coding CLI.");
    return v;
  };
  const ready = (a: { id?: unknown; vendor?: unknown }): { id: string; v: AcpVendorId } => {
    const v = vendor(a.vendor);
    const id = String(a.id ?? "");
    if (!o.hasBot(id)) throw new GatewayError("NOT_FOUND", "No such Bot.");
    if (!o.consent.consentedAcp(v)) throw new GatewayError("NO_CONSENT", STR_ACP.noConsent(v));
    return { id, v };
  };
  return {
    getAcpVendors: () => view(),
    consentAcpVendor: ({ vendor: v, textVersion }) => {
      try { o.consent.consentAcp(vendor(v), Number(textVersion)); } catch (e) {
        if (e instanceof GatewayError) throw e;
        throw new GatewayError("BAD_ARGS", "The consent text changed. Read it again.");
      }
      return view();
    },
    startAcpLogin: async (a) => { const { id, v } = ready(a); return o.logins.start(id, v); },
    checkAcpLogin: async (a) => { const { id, v } = ready(a); return o.logins.check(id, v); },
    installAcpVendor: install("install"),
    removeAcpVendor: install("remove"),
  };
}
