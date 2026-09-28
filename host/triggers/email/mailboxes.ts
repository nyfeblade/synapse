import fs from "node:fs";
import path from "node:path";
import { isSafeFolderId, type MailboxInfo } from "@synapse/shared";
import type { HostConfig } from "../../config";
import { GatewayError } from "../../gateway/errors";
import type { CommandHandlers } from "../../gateway/server";
import { readJson, writeJsonAtomic } from "../../util/atomic-json";

export interface MailboxSecret { label: string; host: string; port: number; user: string; appPassword: string }
const LABEL = /^[A-Za-z0-9_-]{1,40}$/;

/** IMAP credentials as connector secrets (ORIG-04 §04.5; never visible to the Bot). */
export class MailboxStore {
  constructor(private cfg: HostConfig) {}

  /** Same validation as store/layout.ts's botDir(): reject before joining, not after. */
  private dir(botId: string): string {
    if (!isSafeFolderId(botId)) throw new GatewayError("INVALID_BOT_ID", `Invalid Bot id: ${JSON.stringify(botId)}`, 400);
    return path.join(this.cfg.hostPrivate, "connector-secrets", botId);
  }

  add(botId: string, a: MailboxSecret): MailboxInfo[] {
    if (!LABEL.test(a.label)) throw new GatewayError("BAD_MAILBOX", "Mailbox label: use letters, digits, - and _ only.");
    if (!a.host.trim() || !a.user.trim() || !a.appPassword || !(a.port > 0 && a.port < 65536)) throw new GatewayError("BAD_MAILBOX", "Enter the IMAP host, port, user and app password.");
    fs.mkdirSync(this.dir(botId), { recursive: true, mode: 0o700 });
    writeJsonAtomic(path.join(this.dir(botId), `imap-${a.label}.json`), { label: a.label, host: a.host.trim(), port: a.port, user: a.user.trim(), appPassword: a.appPassword } satisfies MailboxSecret, 0o600);
    return this.list(botId);
  }

  list(botId: string): MailboxInfo[] {
    if (!fs.existsSync(this.dir(botId))) return [];
    return fs.readdirSync(this.dir(botId)).filter((f) => /^imap-.+\.json$/.test(f)).sort().map((f) => {
      const s = readJson<MailboxSecret>(path.join(this.dir(botId), f), { label: "", host: "", port: 0, user: "", appPassword: "" });
      return { label: s.label, host: s.host, user: s.user };
    });
  }

  secret(botId: string, label: string): MailboxSecret | null {
    if (!LABEL.test(label)) return null;
    return readJson<MailboxSecret | null>(path.join(this.dir(botId), `imap-${label}.json`), null);
  }
}

export function emailHandlers(m: MailboxStore, onChange: (botId: string) => void): Pick<CommandHandlers, "addMailbox"> {
  return {
    addMailbox: (a) => {
      const mailboxes = m.add(a.id, { label: a.label, host: a.host, port: Number(a.port), user: a.user, appPassword: a.appPassword });
      onChange(a.id);
      return { mailboxes };
    },
  };
}
