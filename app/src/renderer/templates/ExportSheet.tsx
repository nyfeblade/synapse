import { useEffect, useRef, useState } from "react";
import { STR, STR5, type TemplateManifest } from "@synapse/shared";
import { call } from "../bridge";
import { Dialog } from "../components/Dialog";
import { nativeCall } from "../native";
import { useTemplates } from "./store";

type Key = "memories" | "skills" | "routines" | "plugins";
const label = (k: Key, x: TemplateManifest[Key][number]) => (typeof x === "string" ? x : "name" in x ? x.name : "");

export function ExportSheet() {
  const { sheet, close } = useTemplates();
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false); // Task 34 fuzz: a triple-click used to export and open the save dialog three times
  useEffect(() => { setOff({}); setSaved(null); setError(null); }, [sheet]);
  // This used to keep its own `trigger` ref and its own window-level Escape. It opens from the
  // sidebar's Bot-actions MENU, which is exactly the route where reading document.activeElement in
  // an effect fails: the menu item is gone by then. <Dialog> reads the trigger from focus history.
  if (!sheet || sheet.kind !== "export") return null;
  const d = sheet.draft;
  const sections: [Key, string][] = [["memories", STR5.factsItKnows], ["skills", STR5.playbooks], ["routines", STR5.jobs], ["plugins", STR5.apps]];
  const save = async () => {
    if (!d || busy.current) return;
    busy.current = true;
    setSaving(true);
    const manifest: TemplateManifest = {
      ...d,
      memories: d.memories.filter((m) => !off[`memories:${m}`]),
      skills: d.skills.filter((s) => !off[`skills:${s.name}`]),
      routines: d.routines.filter((r) => !off[`routines:${r.name}`]),
      plugins: d.plugins.filter((p) => !off[`plugins:${p.name}`]),
    };
    try {
      const r = await call("exportTemplate", { id: sheet.botId, manifest });
      const { path } = await nativeCall<{ path: string | null }>("saveFile", { defaultName: r.fileName, bytesBase64: r.bytesBase64, filters: [{ name: "Bot template", extensions: ["botpack"] }] });
      setSaved(path);
    } catch (e) { setError((e as Error).message); } finally { busy.current = false; setSaving(false); }
  };
  return (
    <Dialog label={STR5.reviewTemplate} onClose={close} className="tpl-sheet">
      <>
        <h2>{STR5.reviewTemplate}</h2>
        {sheet.error && <span className="error" role="alert">{sheet.error}</span>}
        {!d && !sheet.error && <span className="muted">…</span>}
        {d && (
          <>
            <p><strong>{d.profile.name}</strong>{d.profile.title && <span className="chip">{d.profile.title}</span>}</p>
            <p className="muted pre-wrap">{d.profile.description}</p>
            <h3>{STR5.templateIncludes}</h3>
            {sections.map(([k, title]) => (d[k] as unknown[]).length > 0 && (
              <fieldset key={k} className="tpl-section"><legend>{title}</legend>
                {(d[k] as TemplateManifest[Key]).map((x) => {
                  const text = label(k, x);
                  return <label key={text} className="tpl-item"><input type="checkbox" checked={!off[`${k}:${text}`]} onChange={() => setOff({ ...off, [`${k}:${text}`]: !off[`${k}:${text}`] })} />{text}</label>;
                })}
              </fieldset>
            ))}
          </>
        )}
        {error && <span className="error" role="alert">{error}</span>}
        {saved && (
          <div className="settings-row"><span style={{ flexGrow: 1 }}>{STR5.templateSaved(saved)}</span>
            <button type="button" className="btn-outline small" onClick={() => void nativeCall("revealPath", { path: saved })}>{STR5.revealInFinder}</button>
            <button type="button" className="btn-outline small" onClick={() => void navigator.clipboard.writeText(saved)}>{STR5.copyFilePath}</button></div>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn-secondary" onClick={close}>{saved ? STR.close : STR.cancel}</button>
          {!saved && <button type="button" className="btn-primary" disabled={!d || saving} onClick={() => void save()}>{STR5.saveTemplate}</button>}
        </div>
      </>
    </Dialog>
  );
}
