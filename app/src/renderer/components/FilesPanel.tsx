import { STR, STRL } from "@synapse/shared";
import { useUi } from "../store";
import { buildTranscriptItems } from "../transcript-items";
import { clockTime } from "../doc-heads";
import { FileTile, sizeLine } from "./FileCard";
import { PanelTabs } from "./PanelTabs";

/** Every file in this conversation, newest first: the ones the Bot sent and the ones you attached. */
export function FilesPanel({ botId }: { botId: string }) {
  const entries = useUi((s) => s.transcripts[botId]);
  const jumpTo = useUi((s) => s.jumpTo);
  const files = buildTranscriptItems(entries ?? [], Date.now())
    .flatMap((it) => (it.kind === "file" && it.entry.message.type === "attachment"
      ? [{ key: it.key, name: it.entry.message.name, meta: sizeLine(it.entry.message.size, it.entry.message.pages), at: it.entry.createdAt }]
      : []))
    .reverse();
  return (
    <aside aria-label="Conversation details" className="panel now" data-files={botId}>
      <PanelTabs current="files" />
      <section className="pcard" aria-label={STRL.tabs.files}>
        <h3 className="pcard-head">{STRL.tabs.files}{files.length > 0 && <span className="pcard-meta">{files.length}</span>}</h3>
        <div className="pcard-body">
          {files.length === 0 ? <span className="muted small">{STRL.noFiles}</span> : (
            <ul className="file-list">
              {files.map((f) => (
                <li key={f.key}>
                  <button type="button" className="file-row" aria-label={`${STR.open} ${f.name}`} onClick={() => void jumpTo(botId, f.key)}>
                    <FileTile name={f.name} />
                    <span className="file-row-text">
                      <span>{f.name}</span>
                      <span className="muted">{[f.meta, clockTime(f.at)].filter(Boolean).join(" · ")}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </aside>
  );
}
