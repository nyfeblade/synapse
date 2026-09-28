import { create } from "zustand";
import type { TranscriptEntry, UserAttachmentEntry, UserMessageEntry } from "@synapse/shared";

/**
 * OPTIMISTIC SENDS (decisions.md, "send bloop"). The composer puts a sent message here the moment
 * Enter is pressed, before `sendPrompt` answers, so its bubble appears (and bloops) at once in its
 * final place instead of after a round trip. Transcript renders each one as a synthetic user entry
 * until the host's real entry carrying the same `clientNonce` lands, and keys the row by that nonce,
 * so the real entry REPLACES the optimistic one on the same DOM node: no remount, no second
 * entrance, no frame with both or neither. A failed send is dropped (the composer takes its text
 * back), so nothing is left behind.
 */
export interface PendingSend {
  nonce: string;
  botId: string;
  text: string;
  attachments: { attachmentId: string; name: string; size: number; mime: string }[];
  replyToId?: string;
  skillIds?: string[];
  createdAt: number;
}

interface PendingStore {
  byBot: Record<string, PendingSend[]>;
  add(p: PendingSend): void;
  drop(botId: string, nonces: string[]): void;
}

export const usePendingSends = create<PendingStore>((set) => ({
  byBot: {},
  add: (p) => set((s) => ({ byBot: { ...s.byBot, [p.botId]: [...(s.byBot[p.botId] ?? []), p] } })),
  drop: (botId, nonces) => set((s) => {
    const left = (s.byBot[botId] ?? []).filter((p) => !nonces.includes(p.nonce));
    return { byBot: { ...s.byBot, [botId]: left } };
  }),
}));

export const PENDING_PREFIX = "pending-";
export const isPendingId = (id: string): boolean => id.startsWith(PENDING_PREFIX);

/** The optimistic sends whose real entry has not landed yet (matched by clientNonce). */
export function unreconciled(pending: readonly PendingSend[], entries: readonly TranscriptEntry[]): PendingSend[] {
  if (!pending.length) return [];
  const landed = new Set<string>();
  for (const e of entries) { const n = e.kind === "message" && "clientNonce" in e ? e.clientNonce : undefined; if (n) landed.add(n); }
  return pending.filter((p) => !landed.has(p.nonce));
}

/** One optimistic send as the entries the host will write for it: the message, then its attachments. */
export function pendingEntries(p: PendingSend): TranscriptEntry[] {
  const id = `${PENDING_PREFIX}${p.nonce}`;
  const msg: UserMessageEntry = {
    kind: "message", id, role: "user", content: p.text, clientNonce: p.nonce, createdAt: p.createdAt,
    ...(p.replyToId ? { replyToId: p.replyToId } : {}),
    ...(p.skillIds?.length ? { skillIds: p.skillIds } : {}),
    ...(p.attachments.length ? { attachmentEntryIds: p.attachments.map((_, k) => `${id}a${k + 1}`) } : {}),
  };
  const files: UserAttachmentEntry[] = p.attachments.map((a, k) => ({
    kind: "user-attachment", id: `${id}a${k + 1}`, batchId: id, attachmentId: a.attachmentId, name: a.name, size: a.size, mime: a.mime,
    storePath: "", boxPath: null, createdAt: p.createdAt,
  }));
  return [msg as TranscriptEntry, ...(files as TranscriptEntry[])];
}
