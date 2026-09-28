import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "@synapse/shared";
import { writeTextAtomic } from "../util/atomic-text";

export interface RawField { role: string; name: string; inputType: string; autocomplete: string; label: string; value: string }

/** Shared with host/teach/cdp.ts (snapshot redaction) so the two never drift apart. */
export const SECRET_NAME = /pass|pin|cvv|cvc|ssn|otp|code|secret|token/i;
const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-.*)$/i;

/** I8: URL parameter names that carry credentials (broader than field names: keys, signatures, sessions). */
export const SECRET_PARAM = /pass|pin|cvv|cvc|ssn|otp|code|secret|token|key|sig|auth|session|credential|jwt|nonce|saml/i;

/** I8: a value that looks like a credential: already redacted, or a long mixed-case/digit token. */
export function looksSecret(v: string): boolean {
  if (v === "[redacted]" || v.includes("[secret:")) return true;
  return v.length >= 20 && /^[A-Za-z0-9_\-+/=.~]+$/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v);
}

/** I8: nav/target URLs are stored without fragments or credentials, secret-named params masked, the rest through the scanner. */
export function redactUrl(raw: string, scan: (text: string) => string = (t) => t): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return scan(raw);
  }
  u.hash = "";
  u.username = "";
  u.password = "";
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) params.append(k, SECRET_PARAM.test(k) ? "[redacted]" : scan(v));
  u.search = params.toString();
  return scan(u.toString());
}

/** ORIG-08 §08.1: store a field value only when nothing about the input suggests a secret, and it is short. */
export function redactField(f: RawField): string {
  const auto = f.autocomplete.trim().split(/\s+/);
  if (f.inputType.toLowerCase() === "password") return "[redacted]";
  if (auto.some((a) => SECRET_AUTOCOMPLETE.test(a))) return "[redacted]";
  if (SECRET_NAME.test(f.name) || SECRET_NAME.test(f.label)) return "[redacted]";
  if (f.value.length > LIMITS.teachFieldValueMax) return "[redacted]";
  return f.value;
}

/** Before analysis, every secret value the Bot holds (ORIG-12) is removed from the sidecar files. Values under 4 chars are skipped (ORIG-12 minimum). */
export function scrubSecrets(sessionDir: string, secrets: string[]): number {
  const values = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  if (!values.length) return 0;
  const files = [path.join(sessionDir, "events.jsonl")];
  const snaps = path.join(sessionDir, "snapshots");
  if (fs.existsSync(snaps)) for (const f of fs.readdirSync(snaps)) files.push(path.join(snaps, f));
  let n = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, "utf8");
    for (const v of values) {
      for (const needle of [v, JSON.stringify(v).slice(1, -1)]) {
        const parts = text.split(needle);
        if (parts.length > 1) {
          n += parts.length - 1;
          text = parts.join("[redacted]");
        }
      }
    }
    writeTextAtomic(file, text);
  }
  return n;
}
