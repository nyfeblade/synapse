import { useRef, useState } from "react";
import { GatewayCallError, STR, type SkillView } from "@synapse/shared";
import { call } from "../bridge";
import { useComposer } from "../composer-store";
import { uploadFiles } from "../uploads";
import { PlusIcon } from "./Icons";
import { useUi } from "../store";
import { Menu } from "./Menus";
import { useTeachEligibility } from "./TeachPill";

function errorMessage(e: unknown): string {
  return e instanceof GatewayCallError ? e.message : String(e);
}

export function ComposerPlusMenu({ botId }: { botId: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [skills, setSkills] = useState<{ x: number; y: number; list: SkillView[]; error: string | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const teach = useTeachEligibility(botId);
  // A named chip, not a blank one: `name: ""` rendered an empty label and a "Remove " button.
  const reportClipboard = (error: string) =>
    useComposer.getState().upsertAttachment(botId, { uploadId: crypto.randomUUID(), name: STR.clipboard, size: 0, mime: "", progress: 0, ref: null, error });
  const pastePhoto = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) { const blob = await item.getType(type); await uploadFiles(botId, [new File([blob], `clipboard.${type.split("/")[1]}`, { type })]); return; }
      }
      reportClipboard(STR.noImageOnClipboard); // text on the clipboard: say so instead of closing the menu silently
    } catch (e) {
      reportClipboard(errorMessage(e));
    }
  };
  return (
    <>
      <button type="button" className="round-btn" aria-label={STR.attachFile} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.top - 8 }); }}><PlusIcon /></button>
      <input ref={input} type="file" multiple hidden aria-label={STR.attachFiles} onChange={(e) => { void uploadFiles(botId, [...(e.target.files ?? [])]); e.target.value = ""; }} />
      {menu && (
        <Menu label={STR.attachFile} x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: STR.attachFiles, onSelect: () => input.current?.click() },
          { label: STR.photoFromClipboard, onSelect: () => void pastePhoto() },
          { label: STR.useASkill, submenu: true, onSelect: () => void call("getWorkflows", {}).then((r) => setSkills({ ...menu, list: r.workflows.filter((w) => !w.disabledFor.includes(botId)), error: null })).catch((e) => setSkills({ ...menu, list: [], error: errorMessage(e) })) },
          { label: STR.teachATask, disabled: teach.disabled, ...(teach.why ? { title: teach.why } : {}), onSelect: () => useUi.setState({ teachSetupFor: botId }) },
        ]} />
      )}
      {skills && (
        <Menu label={STR.useASkill} x={skills.x + 180} y={skills.y} onClose={() => setSkills(null)}
          items={skills.error ? [{ label: skills.error, disabled: true, onSelect: () => {} }] : skills.list.length ? skills.list.map((w) => ({ label: w.name, onSelect: () => useComposer.getState().addSkill(botId, w.id, w.name) })) : [{ label: STR.noSkills, disabled: true, onSelect: () => {} }]} />
      )}
    </>
  );
}
