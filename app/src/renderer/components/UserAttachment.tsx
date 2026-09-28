import { useState } from "react";
import { STR, type UserAttachmentEntry } from "@synapse/shared";
import { previewKind } from "../file-loader";
import { sizeLine } from "./FileCard";
import { FilePreview } from "./FilePreview";
import { FileIcon } from "./Icons";

export function UserAttachment({ entry }: { botId: string; entry: UserAttachmentEntry }) {
  const [open, setOpen] = useState(false);
  const path = entry.boxPath ?? entry.storePath;
  return (
    <>
      <button type="button" className="file-card user" aria-label={`${STR.open} ${entry.name}`} disabled={!path || previewKind(entry.mime, entry.name) === "none"} onClick={() => setOpen(true)}>
        <FileIcon /><span className="file-name">{entry.name}</span><span className="muted small">{sizeLine(entry.size, null)}</span>
      </button>
      {open && <FilePreview path={path} name={entry.name} mime={entry.mime} onClose={() => setOpen(false)} />}
    </>
  );
}
