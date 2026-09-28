import { GatewayCallError, LIMITS, STR } from "@synapse/shared";
import { call } from "./bridge";
import { beginUpload, composerState, endUpload, isUploadCancelled, useComposer } from "./composer-store";

export function validateFiles(existing: number, files: File[]): string | null {
  if (existing + files.length > LIMITS.attachmentsPerMessage) return STR.tooManyAttachments;
  for (const f of files) {
    const max = f.type.startsWith("video/") ? LIMITS.attachmentVideoMaxBytes : LIMITS.attachmentDocMaxBytes;
    if (f.size > max) return STR.fileTooLarge(f.name, max / 1024 / 1024);
  }
  return null;
}

export async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function uploadFiles(botId: string, files: File[]): Promise<void> {
  const error = validateFiles(composerState(botId).attachments.length, files);
  const store = useComposer.getState();
  if (error) {
    store.upsertAttachment(botId, { uploadId: crypto.randomUUID(), name: files[0]?.name ?? "", size: 0, mime: "", progress: 0, ref: null, error });
    return;
  }
  await Promise.all(files.map(async (f) => {
    const uploadId = crypto.randomUUID();
    const base = { uploadId, name: f.name, size: f.size, mime: f.type || "application/octet-stream", ref: null, error: null };
    beginUpload(uploadId);
    store.upsertAttachment(botId, { ...base, progress: 0 });
    try {
      for (let off = 0; off < f.size || off === 0; off += LIMITS.uploadChunkBytes) {
        const end = Math.min(f.size, off + LIMITS.uploadChunkBytes);
        const r = await call("uploadAttachment", { id: botId, uploadId, name: f.name, mime: base.mime, size: f.size, offset: off, chunkBase64: await blobToBase64(f.slice(off, end)), final: end >= f.size });
        // The user can remove the chip between chunks; stop rather than re-create the row it owned.
        if (isUploadCancelled(uploadId)) return;
        useComposer.getState().upsertAttachment(botId, { ...base, progress: f.size ? end / f.size : 1, ref: r.attachment });
        if (end >= f.size) break;
      }
    } catch (e) {
      useComposer.getState().upsertAttachment(botId, { ...base, progress: 0, error: e instanceof GatewayCallError ? e.message : String(e) });
    } finally {
      endUpload(uploadId);
    }
  }));
}
