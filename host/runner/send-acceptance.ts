import { createHash } from "node:crypto";
import { LIMITS } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

interface Rec { botId: string; nonce: string; digest: string; entryId: string }

/** EVT-11: clientNonce ledger (256 records) makes sendPrompt retries idempotent. */
export class SendAcceptanceLedger {
  private recs: Rec[];

  constructor(private file: string) {
    this.recs = readJson<Rec[]>(file, []);
  }

  private digest(botId: string, text: string): string {
    return createHash("sha256").update(`${botId}\n${text}`).digest("hex");
  }

  check(botId: string, nonce: string, text: string): { kind: "new" } | { kind: "duplicate"; entryId: string } {
    const r = this.recs.find((x) => x.botId === botId && x.nonce === nonce);
    if (!r) return { kind: "new" };
    if (r.digest !== this.digest(botId, text)) throw new GatewayError("NONCE_DIGEST_MISMATCH", "This message was already sent. Start a new message instead.", 409);
    return { kind: "duplicate", entryId: r.entryId };
  }

  record(botId: string, nonce: string, text: string, entryId: string): void {
    this.recs = [...this.recs, { botId, nonce, digest: this.digest(botId, text), entryId }].slice(-LIMITS.sendAcceptanceMax);
    writeJsonAtomic(this.file, this.recs, 0o600);
  }
}
