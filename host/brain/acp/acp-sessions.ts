import path from "node:path";
import { isAcpVendorId, type AcpVendorId } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../../util/atomic-json";

/**
 * Which vendor session belongs to a Bot's conversation (hostPrivate/acp-sessions.json, 0600). The Bot's own session id
 * is a provider-style `prov-acp-…` id whose file mirrors the conversation's text for search and handoffs; the vendor
 * keeps the real session in the Bot's home, and this map lets a restarted CLI load it again when the vendor supports it.
 */
export const ACP_SESSION_PREFIX = "prov-acp-";
export function isAcpSessionId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.startsWith(ACP_SESSION_PREFIX);
}

interface Entry { sid: string; vendor: AcpVendorId; vendorSid: string }

export class AcpSessionMap {
  private state: Record<string, Entry>;
  private file: string;
  constructor(hostPrivate: string) {
    this.file = path.join(hostPrivate, "acp-sessions.json");
    const raw = readJson<Record<string, Entry>>(this.file, {});
    this.state = {};
    for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
      if (v && typeof v.sid === "string" && typeof v.vendorSid === "string" && isAcpVendorId(v.vendor)) this.state[k] = v;
    }
  }
  get(botId: string, sid: string, vendor: AcpVendorId): string | null {
    const e = this.state[botId];
    return e && e.sid === sid && e.vendor === vendor ? e.vendorSid : null;
  }
  set(botId: string, e: Entry): void {
    this.state[botId] = e;
    writeJsonAtomic(this.file, this.state, 0o600);
  }
  forget(botId: string): void {
    if (!(botId in this.state)) return;
    delete this.state[botId];
    writeJsonAtomic(this.file, this.state, 0o600);
  }
}
