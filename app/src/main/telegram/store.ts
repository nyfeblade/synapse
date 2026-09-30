import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file";

/** The app's sealer (the profile's key file, sealing.ts), as the app's other secrets use it. */
export interface Sealer { encrypt(s: string): Buffer; decrypt(b: Buffer): string }

/** The one Telegram user whose private chat with the bot is accepted. */
export interface TelegramOwner { userId: number; chatId: number; name: string; pairedAt: number }

export interface TelegramState {
  /** The switch (off by default). */
  enabled: boolean;
  /** The bot token, only ever SEALED (base64). */
  sealedToken: string | null;
  botUsername: string | null;
  owner: TelegramOwner | null;
  /** The Bot the Telegram chat talks to. */
  activeBotId: string | null;
  /** The next getUpdates offset: an update is never handled twice across restarts. */
  offset: number;
  /** Card messages whose buttons may still show: a restart takes the buttons away (their nonces died with the run). */
  cardMessages: number[];
}

const EMPTY: TelegramState = { enabled: false, sealedToken: null, botUsername: null, owner: null, activeBotId: null, offset: 0, cardMessages: [] };

const isOwner = (o: unknown): o is TelegramOwner => {
  const x = o as TelegramOwner | null;
  return !!x && Number.isSafeInteger(x.userId) && Number.isSafeInteger(x.chatId) && typeof x.name === "string";
};

/**
 * Wave 4.1: Settings → System → Telegram's own file in the app's data folder (0600). Tiny, written rarely. The token
 * is sealed with the app's key file and is decrypted only in this process, only to talk to Telegram.
 */
export class TelegramStore {
  constructor(private file: string, private seal: Sealer | null) {}

  static in(userData: string, seal: Sealer | null): TelegramStore { return new TelegramStore(path.join(userData, "telegram.json"), seal); }

  read(): TelegramState {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<TelegramState>;
      return {
        enabled: d.enabled === true,
        sealedToken: typeof d.sealedToken === "string" ? d.sealedToken : null,
        botUsername: typeof d.botUsername === "string" ? d.botUsername : null,
        owner: isOwner(d.owner) ? { userId: d.owner.userId, chatId: d.owner.chatId, name: d.owner.name.slice(0, 64), pairedAt: Number(d.owner.pairedAt) || 0 } : null,
        activeBotId: typeof d.activeBotId === "string" ? d.activeBotId : null,
        offset: Number.isSafeInteger(d.offset) && (d.offset as number) >= 0 ? (d.offset as number) : 0,
        cardMessages: Array.isArray(d.cardMessages) ? d.cardMessages.filter((x) => Number.isSafeInteger(x)).slice(-200) : [],
      };
    } catch {
      return { ...EMPTY };
    }
  }

  write(patch: Partial<TelegramState>): TelegramState {
    const next = { ...this.read(), ...patch };
    writeFileAtomic(this.file, JSON.stringify(next, null, 2), 0o600);
    return next;
  }

  /** A new token is a new bot: its owner, chat and offset start over. Throws when the app's secrets aren't open. */
  setToken(token: string, botUsername: string): TelegramState {
    if (!this.seal) throw new Error("no-secrets");
    const sealedToken = this.seal.encrypt(token).toString("base64");
    return this.write({ sealedToken, botUsername, owner: null, activeBotId: null, offset: 0, cardMessages: [] });
  }

  /** The plaintext token, or null (none saved, or the secrets aren't open). */
  token(): string | null {
    const s = this.read().sealedToken;
    if (!s || !this.seal) return null;
    try { return this.seal.decrypt(Buffer.from(s, "base64")); } catch { return null; }
  }

  forgetToken(): TelegramState {
    return this.write({ enabled: false, sealedToken: null, botUsername: null, owner: null, activeBotId: null, offset: 0, cardMessages: [] });
  }
}
