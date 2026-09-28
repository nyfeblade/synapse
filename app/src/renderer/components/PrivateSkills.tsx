import { useEffect, useState } from "react";
import { LIMITS, STR, STR5, type SkillView } from "@synapse/shared";
import { useAsync } from "../async-resource";
import { call, callQuiet } from "../bridge";
import { useOverlays } from "../overlays";
import { useUi } from "../store";
import { Async } from "./Async";
import { Dialog } from "./Dialog";
import { askConfirm } from "./ConfirmDialog";
import { CloseIcon } from "./Icons";
import { Menu } from "./Menus";
import { SkillEditor } from "./SkillEditor";
import "../styles/skills.css";

/** Mirrors the host's skill id (host/skills/skill-file.ts): a new skill silently overwrote one that slugified the same. */
function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, LIMITS.skillIdMax).replace(/-+$/, "");
  return s || "skill";
}

type Mode = { kind: "list" } | { kind: "edit"; id: string | null; initial: { name: string; description: string; body: string } } | { kind: "import"; how: "markdown" | "url" };

export function PrivateSkills() {
  const close = useOverlays((s) => s.close);
  const botMap = useUi((s) => s.bots); // select the map, derive below: zustand 5 selectors must return stable references
  const bots = Object.values(botMap).filter((b) => !b.settings.hiddenFromSidebar);
  // Was `useState<SkillView[] | null>(null)` + `.catch(() => {})`: a failed getWorkflows left `all`
  // null forever, which rendered as a skills manager with no skills, no empty state and no error —
  // the user's own skills looked deleted. Managed skills (the teach skill) are the app's, not the
  // user's private skills: the host reinstalls them at boot, so they aren't listed here to edit or delete.
  // callQuiet: this dialog presents the failure itself, inside the list it replaces.
  const workflows = useAsync(() => callQuiet("getWorkflows", {}).then((r) => r.workflows), []);
  const all = workflows.status === "ready" ? workflows.value : null;
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reload = () => workflows.reload();
  useEffect(() => window.synapse.onEvent((e) => { if (e.channel === "skills") workflows.setValue(e.payload.workflows); }), [workflows.setValue]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (f: () => Promise<unknown>) => { setError(null); try { await f(); reload(); setMode({ kind: "list" }); } catch (e) { setError((e as Error).message); } };
  const edit = async (s: SkillView) => {
    const r = await call("getWorkflow", { workflowId: s.id });
    setMode({ kind: "edit", id: s.id, initial: { name: s.name, description: s.description, body: r.body } });
  };
  // The host writes a new skill at slugify(name), replacing whatever is already there: ask first, and keep the
  // draft when the answer is no (the editor's text lives in its own state and dies with the overlay).
  const saveSkill = async (id: string | null, v: { name: string; description: string; body: string }) => {
    if (id) return run(() => call("updateWorkflow", { workflowId: id, ...v }));
    const wanted = slugify(v.name);
    const clash = (all ?? []).find((s) => s.id === wanted || s.name.trim().toLowerCase() === v.name.trim().toLowerCase());
    if (clash && !(await askConfirm({ title: `Replace the skill "${clash.name}"?`, verb: "Replace" }))) return;
    await run(() => call("createWorkflow", v));
  };
  const importFolder = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = await Promise.all([...files].filter((f) => f.size < 512 * 1024).map(async (f) => ({ path: (f as File & { webkitRelativePath: string }).webkitRelativePath.split("/").slice(1).join("/") || f.name, text: await f.text() })));
    const name = (files[0] as File & { webkitRelativePath: string }).webkitRelativePath.split("/")[0] || "Imported skill";
    await run(() => call("importWorkflowFolder", { name, files: list }));
  };

  return (
    <Dialog label={STR.managePluginsAndSkills} onClose={close} className="modal market">
      <>
        <header className="modal-head"><h2>{STR.managePluginsAndSkills}</h2><button type="button" className="icon-btn" aria-label={`${STR.close} ${STR.managePluginsAndSkills}`} onClick={close}><CloseIcon /></button></header>
        <div role="tablist" className="tabs">
          <button type="button" role="tab" aria-selected="false" className="tab" disabled title={STR5.notAvailableYet}>Plugins</button>
          <button type="button" role="tab" aria-selected="true" className="tab selected">{STR.privateSkills}</button>
          <span className="grow" />
          <button type="button" className="btn-outline" onClick={() => setMode({ kind: "edit", id: null, initial: { name: "", description: "Use this when ", body: "" } })}>{STR.newSkill}</button>
          <button type="button" className="btn-outline" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4 }); }}>{STR.importSkill}</button>
          <label className="btn-outline file-btn">{STR.importFolder}<input type="file" hidden {...({ webkitdirectory: "" } as object)} onChange={(e) => void importFolder(e.target.files)} /></label>
        </div>
        {error && <div role="alert" className="card-error pad">{error}</div>}
        {mode.kind === "edit" && (
          <SkillEditor initial={mode.initial} onCancel={() => setMode({ kind: "list" })} onSave={(v) => saveSkill(mode.id, v)} />
        )}
        {mode.kind === "import" && (
          <form className="skill-editor" onSubmit={(e) => { e.preventDefault(); void run(() => (mode.how === "markdown" ? call("importWorkflowText", { markdown: text }) : call("importWorkflowUrl", { url: text.trim() }))); }}>
            {mode.how === "markdown"
              ? <label className="form-field grow"><span>Markdown</span><textarea className="mono" rows={16} value={text} onChange={(e) => setText(e.target.value)} aria-label="Markdown" /></label>
              : <label className="form-field"><span>URL</span><input type="url" value={text} onChange={(e) => setText(e.target.value)} aria-label="URL" /></label>}
            <div className="card-actions"><button type="submit" className="btn-primary">Import skill</button><button type="button" className="btn-outline" onClick={() => setMode({ kind: "list" })}>{STR.cancel}</button></div>
          </form>
        )}
        {mode.kind === "list" && (
          <Async resource={workflows} label={STR.privateSkills}>{(loaded) => {
            const skills = loaded.filter((s) => !s.managed);
            return (
          <ul className="plain-list skills">
            {!skills.length && <li className="muted pad">{STR.noSkills}</li>}
            {skills.map((s) => (
              <li key={s.id} className="skill-row">
                <div className="skill-main">
                  <span className="skill-name">{s.name}</span>
                  <span className="muted clamp2">{s.description}</span>
                  {s.source && <span className="muted small">{sourceLabel(s.source)}</span>}
                </div>
                <button type="button" className="btn-outline" aria-label={`${STR.editSkill} ${s.name}`} onClick={() => void edit(s)}>{STR.editSkill}</button>
                <button type="button" className="btn-outline danger" aria-label={`${STR.deleteSkill} ${s.name}`} onClick={() => void askConfirm({ title: `Delete the skill "${s.name}"?`, verb: STR.deleteVerb }).then((ok) => { if (ok) void run(() => call("deleteWorkflow", { workflowId: s.id })); })}>{STR.deleteSkill}</button>
                <div className="skill-bots">
                  {bots.map((b) => {
                    const on = !s.disabledFor.includes(b.id);
                    return (
                      <label key={b.id} className="skill-bot">
                        <span>{b.profile.name}</span>
                        <button type="button" role="switch" aria-checked={on} aria-label={`${s.name} for ${b.profile.name}`} className={on ? "switch on" : "switch"}
                          onClick={() => void call("setAgentWorkflowEnabled", { id: b.id, workflowId: s.id, enabled: !on }).then(reload)} />
                      </label>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
            );
          }}</Async>
        )}
        {menu && (
          <Menu label={STR.importSkill} x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
            { label: STR.importMarkdown, onSelect: () => { setText(""); setMode({ kind: "import", how: "markdown" }); } },
            { label: STR.importUrl, onSelect: () => { setText(""); setMode({ kind: "import", how: "url" }); } },
          ]} />
        )}
      </>
    </Dialog>
  );
}

/** A skill's source: a URL's host, or the raw value for non-URL sources (Phase 4's "managed", "teach-a-task"). */
function sourceLabel(source: string): string {
  try { return new URL(source).host || source; } catch { return source; }
}
