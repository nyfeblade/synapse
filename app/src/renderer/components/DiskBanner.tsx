import { STRC } from "@synapse/shared";
import { call } from "../bridge";
import { useComputer } from "../computer-state";
import { useUi } from "../store";

/** CMP-15 / BOT-16: banner above the transcript while the disk is low. */
export function DiskBanner({ botId }: { botId: string }) {
  const disk = useComputer((s) => s.disk);
  if (!disk || disk.level === "ok") return null;
  const open = async () => {
    const { id } = await call("openDiskSaver", {});
    useUi.getState().openBot(id);
  };
  return (
    <div className={`disk-banner ${disk.level}`} role="region" aria-label="Disk space" data-bot={botId}>
      <span>{disk.level === "hard" ? STRC.diskCritical : STRC.diskLow}</span>
      <button type="button" className="btn-outline small" onClick={() => void open()}>{STRC.openDiskSaver}</button>
    </div>
  );
}
