import fs from "node:fs";
import { LIMITS, type UserAttachmentEntry } from "@synapse/shared";
import type { ModelMessage } from "../brain/types";
import type { BotService } from "../bots/bot-service";
import type { TurnHooks } from "../runner/hooks";
import { humanSize, isImageBlockType } from "./mime";

type AttachmentLike = Pick<UserAttachmentEntry, "name" | "mime" | "size" | "storePath" | "boxPath">;

/** CHAT-09: the model is told both paths; images within the limit are also sent as image blocks. Bug 126: a room
 *  member's turn uses the same rendering for the still a group call's post carried. */
export function attachmentMessages(atts: AttachmentLike[]): ModelMessage[] {
  if (!atts.length) return [];
  // Bug #61: only the staged copy is named; the original lives in the host-private Bot folder no Bot can read.
  const lines = atts.map((a) => a.boxPath
    ? `- ${a.name} (${a.mime}, ${humanSize(a.size)}): ${a.boxPath}`
    : `- ${a.name} (${a.mime}, ${humanSize(a.size)}): not available as a file (it couldn't be copied to your uploads folder); ask the user to attach it again`);
  const out: ModelMessage[] = [{ text: `<attached_files>\n${lines.join("\n")}\n</attached_files>` }];
  for (const a of atts) {
    if (isImageBlockType(a.mime) && a.size <= LIMITS.imageBlockMaxBytes) out.push({ image: { mediaType: a.mime, dataBase64: fs.readFileSync(a.storePath).toString("base64") } });
  }
  return out;
}

export function createAttachmentHooks(d: { bots: BotService }): TurnHooks {
  return {
    decorateUserMessage: (botId, entry) => {
      const atts = (entry.attachmentEntryIds ?? []).map((id) => d.bots.getEntry(botId, id)).filter((e): e is UserAttachmentEntry => e?.kind === "user-attachment");
      return { before: [], after: attachmentMessages(atts) };
    },
  };
}
