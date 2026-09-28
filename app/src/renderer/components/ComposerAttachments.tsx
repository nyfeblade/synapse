import { useEffect } from "react";
import { useComposer, type PendingAttachment } from "../composer-store";
import { uploadFiles } from "../uploads";
import { CloseIcon, FileIcon } from "./Icons";

const NONE: PendingAttachment[] = [];

export function ComposerAttachments({ botId }: { botId: string }) {
  const items = useComposer((s) => s.byBot[botId]?.attachments ?? NONE);
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!(document.activeElement as HTMLElement | null)?.classList.contains("composer-input")) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) { e.preventDefault(); void uploadFiles(botId, files); }
    };
    const onDragOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      // Scoped to the chat surface: a drop on the sidebar, a modal or an overlay scrim must not
      // attach the file to whichever chat happens to be mounted behind it. .botpack files belong to
      // App's Bot-template importer, which handles the same drop, so they are left out here.
      if (!(e.target instanceof Element) || !e.target.closest("main.main")) return;
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => !f.name.toLowerCase().endsWith(".botpack"));
      if (!files.length) return;
      e.preventDefault();
      void uploadFiles(botId, files);
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => { window.removeEventListener("paste", onPaste); window.removeEventListener("dragover", onDragOver); window.removeEventListener("drop", onDrop); };
  }, [botId]);
  if (!items.length) return null;
  return (
    <div className="chips-row attachments">
      {items.map((a) => (
        <span key={a.uploadId} className={a.error ? "chip file error" : "chip file"} title={a.error ?? undefined}>
          <FileIcon /><span className="clamp1">{a.name}</span>
          {!a.ref && !a.error && <span className="muted small">{Math.round(a.progress * 100)}%</span>}
          {a.error && <span role="alert" className="small">{a.error}</span>}
          <button type="button" className="chip-x" aria-label={`Remove ${a.name}`} onClick={() => useComposer.getState().removeAttachment(botId, a.uploadId)}><CloseIcon size={10} /></button>
        </span>
      ))}
    </div>
  );
}
