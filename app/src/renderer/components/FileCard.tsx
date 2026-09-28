import { useState } from "react";
import { STR, type SendMessageEntry } from "@synapse/shared";
import { previewKind } from "../file-loader";
import "../styles/files.css";
import { FilePreview } from "./FilePreview";
import { FileIcon } from "./Icons";
import { newFlag } from "../is-new";

export function sizeLine(size: number | null, pages: number | null, caption?: string | null): string {
  const s = size === null ? "" : size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${Math.round(size / 104857.6) / 10} MB`;
  return [caption?.trim() || "", s, pages ? `${pages} page${pages === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
}

/** The file's document tile (the look study's `.file .ic`): its extension, or the file glyph when it has none. */
export function FileTile({ name }: { name: string }) {
  const ext = /\.([a-z0-9]{1,4})$/i.exec(name)?.[1]?.toUpperCase();
  return <span className="file-ic" aria-hidden="true">{ext ?? <FileIcon />}</span>;
}

export function FileCard({ entry, isNew = false }: { botId: string; entry: SendMessageEntry; isNew?: boolean }) {
  const [open, setOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (entry.message.type !== "attachment") return null;
  const m = entry.message;
  const remote = /^https:/i.test(m.url);
  const path = remote ? "" : decodeURIComponent(m.url.replace(/^file:\/\//, ""));
  const canPreview = !remote && previewKind(m.mime, m.name) !== "none";
  const save = () => {
    setSaveError(null);
    window.synapse.saveFile({ path, name: m.name }).catch((e) => setSaveError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="msg bot">
      <div className={`file-card${newFlag(isNew)}`}>
        {remote ? (
          <a className="file-main" href={m.url} target="_blank" rel="noreferrer"><FileTile name={m.name} /><span className="file-text"><span className="file-name">{m.name}</span><span className="muted small">{new URL(m.url).host}</span></span></a>
        ) : (
          <button type="button" className="file-main" disabled={!canPreview} onClick={() => setOpen(true)} aria-label={`${STR.open} ${m.name}`}>
            <FileTile name={m.name} /><span className="file-text"><span className="file-name">{m.name}</span><span className="muted small">{sizeLine(m.size, m.pages, m.caption)}</span></span>
          </button>
        )}
        {!remote && <button type="button" className="btn-outline" aria-label={`${STR.save} ${m.name}`} onClick={save}>{STR.save}</button>}
      </div>
      {saveError && <div role="alert" className="card-error">{saveError}</div>}
      {open && <FilePreview path={path} name={m.name} mime={m.mime} onClose={() => setOpen(false)} />}
    </div>
  );
}
