import { create } from "zustand";
import type { AttachmentRef } from "@synapse/shared";

export interface PendingAttachment { uploadId: string; name: string; size: number; mime: string; progress: number; ref: AttachmentRef | null; error: string | null }
interface BotComposer { attachments: PendingAttachment[]; replyToId: string | null; skillIds: string[]; skillNames: Record<string, string> }
const EMPTY: BotComposer = { attachments: [], replyToId: null, skillIds: [], skillNames: {} };

// A chunked upload keeps running after the chip that owns it is gone, so it has to be told it was
// cancelled: otherwise its next chunk re-inserts the row (upsert inserts when the id is missing)
// and the file the user removed is uploaded and sent anyway. `inFlight` keeps the cancelled set
// bounded to uploads that are really running — uploadFiles registers and retires every id it starts.
const inFlight = new Set<string>();
const cancelled = new Set<string>();
export const beginUpload = (uploadId: string): void => { inFlight.add(uploadId); cancelled.delete(uploadId); };
export const endUpload = (uploadId: string): void => { inFlight.delete(uploadId); cancelled.delete(uploadId); };
export const isUploadCancelled = (uploadId: string): boolean => cancelled.has(uploadId);
const cancelUploads = (ids: string[]): void => { for (const id of ids) if (inFlight.has(id)) cancelled.add(id); };

interface ComposerStore {
  byBot: Record<string, BotComposer>;
  setReplyTo(botId: string, id: string | null): void;
  addSkill(botId: string, id: string, name?: string): void;
  removeSkill(botId: string, id: string): void;
  upsertAttachment(botId: string, a: PendingAttachment): void;
  removeAttachment(botId: string, uploadId: string): void;
  /** Resets the composer after a send; `keepErrored` leaves failed attachment chips on screen. */
  clear(botId: string, keepErrored?: boolean): void;
  /** Puts a failed send's files, reply and skills back, ahead of anything added since (Composer send()). */
  restore(botId: string, sent: BotComposer): void;
}

export const useComposer = create<ComposerStore>((set, get) => {
  const patch = (botId: string, f: (c: BotComposer) => BotComposer) => set((s) => ({ byBot: { ...s.byBot, [botId]: f(s.byBot[botId] ?? EMPTY) } }));
  return {
    byBot: {},
    setReplyTo: (botId, id) => patch(botId, (c) => ({ ...c, replyToId: id })),
    addSkill: (botId, id, name) => patch(botId, (c) => ({
      ...c,
      skillIds: c.skillIds.includes(id) ? c.skillIds : [...c.skillIds, id],
      skillNames: name ? { ...c.skillNames, [id]: name } : c.skillNames,
    })),
    removeSkill: (botId, id) => patch(botId, (c) => ({ ...c, skillIds: c.skillIds.filter((x) => x !== id) })),
    upsertAttachment: (botId, a) => {
      if (cancelled.has(a.uploadId)) return; // its chip was removed (or the composer cleared) mid-upload
      patch(botId, (c) => ({ ...c, attachments: c.attachments.some((x) => x.uploadId === a.uploadId) ? c.attachments.map((x) => (x.uploadId === a.uploadId ? a : x)) : [...c.attachments, a] }));
    },
    removeAttachment: (botId, uploadId) => {
      cancelUploads([uploadId]);
      patch(botId, (c) => ({ ...c, attachments: c.attachments.filter((x) => x.uploadId !== uploadId) }));
    },
    clear: (botId, keepErrored = false) => {
      const current = get().byBot[botId] ?? EMPTY;
      cancelUploads(current.attachments.map((a) => a.uploadId));
      const kept = keepErrored ? current.attachments.filter((a) => a.error) : [];
      patch(botId, () => (kept.length ? { ...EMPTY, attachments: kept } : EMPTY));
    },
    restore: (botId, sent) => patch(botId, (c) => ({
      attachments: [...sent.attachments.filter((a) => !c.attachments.some((x) => x.uploadId === a.uploadId)), ...c.attachments],
      replyToId: c.replyToId ?? sent.replyToId,
      skillIds: [...new Set([...sent.skillIds, ...c.skillIds])],
      skillNames: { ...sent.skillNames, ...c.skillNames },
    })),
  };
});
export const composerState = (botId: string): BotComposer => useComposer.getState().byBot[botId] ?? EMPTY;
