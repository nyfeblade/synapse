import { STR, STR5, type TemplateManifest } from "@synapse/shared";
import { Dialog } from "../components/Dialog";
import { useTemplates } from "./store";

type Key = "memories" | "skills" | "routines" | "plugins";
const label = (k: Key, x: TemplateManifest[Key][number]) => (typeof x === "string" ? x : "name" in x ? x.name : "");

/** Fix round 1 (finding 1): read-only "View template details" sheet — sheet.kind === "details" was set by
 * the store but nothing in the render tree consumed it. */
export function DetailsSheet() {
  const { sheet, close } = useTemplates();
  // Escape closes the topmost layer — it used to close the Marketplace behind this sheet. The
  // overlay stack settles that now; this surface only has to say it is a layer.
  if (!sheet || sheet.kind !== "details") return null;
  const t = sheet.template;
  const d = t.manifest;
  const sections: [Key, string][] = [["memories", STR5.factsItKnows], ["skills", STR5.playbooks], ["routines", STR5.jobs], ["plugins", STR5.apps]];
  return (
    <Dialog label={t.name} onClose={close} className="tpl-sheet">
      <>
        <h2>{t.name}</h2>
        {t.author && <span className="muted">{STR5.authorsBot(t.author.name)}</span>}
        <p className="muted pre-wrap">{d.profile.description}</p>
        <h3>{STR5.templateIncludes}</h3>
        {sections.map(([k, title]) => (d[k] as unknown[]).length > 0 && (
          <fieldset key={k} className="tpl-section"><legend>{title}</legend>
            {(d[k] as TemplateManifest[Key]).map((x) => {
              const text = label(k, x);
              return <div key={text} className="tpl-item">{text}</div>;
            })}
          </fieldset>
        ))}
        <div className="sheet-actions">
          <button type="button" className="btn-outline" onClick={close}>{STR.close}</button>
        </div>
      </>
    </Dialog>
  );
}
