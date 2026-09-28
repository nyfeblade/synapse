import { LIMITS, STRV } from "@synapse/shared";
import { call } from "../bridge";
import { nativeCall } from "../native";
import { blobToBase64 } from "../uploads";

/**
 * Screen share on a call, token-cautious: sharing only ALLOWS a still. One goes (a) with a turn whose
 * words ask the Bot to look, or (b) when the Bot asks (SendMessage call: "look" → SSE call-look).
 * At most one still per user turn from (a); (b) is honoured once per user turn too, so a Bot can't
 * loop on it. Each still is ~1,420 image tokens (1280 px long edge).
 */

/**
 * The user asking the Bot to look, matched cheaply (one regex, no model): "look", "see this", "can
 * you see", "what's on my screen", "check my screen", "what am I looking at"... Not "I'll see you
 * tomorrow" or "let's see": seeing needs an object on the screen or a question to the Bot.
 */
const LOOK = new RegExp([
  String.raw`\b(take a )?look(ing)?\b(?! (forward|up|it up|after|for))`,
  String.raw`\b(see|check|read|watch) (this|that|here)\b(?! (through|week|weekend|time|morning|afternoon|evening))`,
  String.raw`\b(see|what) (what )?(i'm|i am|am i) (looking at|seeing|doing)\b`,
  String.raw`\b(see|check|read) (my|the|this) (screen|window|page|error|code|tab|chart|dialog|popup|box)\b`,
  String.raw`\bcan you (see|read|tell what)\b`,
  String.raw`\bdo you see\b`,
  String.raw`\b(on|at) (my|the) (screen|display|monitor)\b`,
  String.raw`\bmy screen\b`,
  String.raw`\bscreenshot\b`,
].join("|"), "i");
export function wantsLook(text: string): boolean {
  const t = text.replace(/’/g, "'").trim();
  return t !== "" && LOOK.test(t);
}
export type ShareOutcome = { attachmentId: string } | { fault: string; pane: "screen" | null; stop: boolean };

/** A capture failure in plain words. Permission off stops sharing (retrying every turn can't help). */
export function shareFault(message: string): { fault: string; pane: "screen" | null; stop: boolean } {
  const m = /permission:screen:(denied|restricted)/.exec(message);
  if (m) return m[1] === "restricted" ? { fault: STRV.screenAccessRestricted, pane: null, stop: true } : { fault: STRV.screenAccessDenied, pane: "screen", stop: true };
  return { fault: STRV.screenShareFailed, pane: null, stop: false };
}

const two = (n: number) => String(n).padStart(2, "0");
/** The attachment's name tells the Bot what it is looking at. */
export function stillName(at: Date): string {
  return `Shared screen ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}.jpg`;
}

export async function shareStill(botId: string, now = new Date()): Promise<ShareOutcome> {
  let b64: string;
  try {
    const r = await nativeCall<{ jpegBase64?: unknown }>("screen.capture");
    if (typeof r?.jpegBase64 !== "string" || !r.jpegBase64) return shareFault("");
    b64 = r.jpegBase64;
  } catch (e) {
    return shareFault(e instanceof Error ? e.message : String(e));
  }
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const uploadId = crypto.randomUUID();
    const name = stillName(now);
    for (let off = 0; ; off += LIMITS.uploadChunkBytes) {
      const end = Math.min(blob.size, off + LIMITS.uploadChunkBytes);
      const r = await call("uploadAttachment", { id: botId, uploadId, name, mime: "image/jpeg", size: blob.size, offset: off, chunkBase64: await blobToBase64(blob.slice(off, end)), final: end >= blob.size });
      if (end >= blob.size) return r.attachment ? { attachmentId: r.attachment.attachmentId } : shareFault("");
    }
  } catch {
    return shareFault("");
  }
}
