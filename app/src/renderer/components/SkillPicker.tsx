import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { STR, type SkillView } from "@synapse/shared";
import { call } from "../bridge";
import { useComposer } from "../composer-store";
import { useOverlays } from "../overlays";
import { CloseIcon } from "./Icons";
import "../styles/skill-picker.css";

export function SkillPicker({ botId, query, onPick, onClose }: { botId: string; query: string; onPick(id: string, name: string): void; onClose(): void }) {
  const [all, setAll] = useState<SkillView[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => { void call("getWorkflows", {}).then((r) => setAll(r.workflows)).catch(() => setAll([])); }, []);
  const q = query.toLowerCase();
  const items = useMemo(() => all.filter((x) => !x.disabledFor.includes(botId) && (x.name.toLowerCase().includes(q) || x.id.includes(q))).slice(0, 8), [all, botId, q]);
  // The query narrows the list on every keystroke, so a selection made against the longer list can
  // fall off the end — leaving no row highlighted and Enter hitting `items[sel]` === undefined.
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, items.length - 1))), [items.length]);
  // useLayoutEffect, not useEffect: this re-binds on every `items` change (the async getWorkflows load
  // populates `items` after first paint), and it must be attached in the same commit that shows the
  // listbox — a deferred passive effect can still be pending when a caller's `findByRole` resolves on
  // the DOM mutation and immediately dispatches a key, missing the freshly-filtered `items` closure.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!items.length || useOverlays.getState().open) return; // an overlay on top owns the keyboard
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); const it = items[sel]; if (it) onPick(it.id, it.name); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items, sel, onPick, onClose]);
  if (!items.length) return null;
  return (
    <div className="skill-picker-anchor">
      <ul role="listbox" aria-label={STR.skills} className="skill-picker">
        {items.map((it, i) => (
          <li key={it.id} role="option" aria-selected={i === sel} className={i === sel ? "skill-picker-row selected" : "skill-picker-row"} onMouseDown={(e) => { e.preventDefault(); onPick(it.id, it.name); }}>
            <span>/{it.name}</span><span className="muted clamp1">{it.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const NONE: string[] = [];
const NO_NAMES: Record<string, string> = {};
export function SkillChips({ botId }: { botId: string }) {
  const ids = useComposer((s) => s.byBot[botId]?.skillIds ?? NONE);
  // The chip shows the name the picker showed; the id is a slug ("/deploy-to-prod" for "Deploy to prod").
  const names = useComposer((s) => s.byBot[botId]?.skillNames ?? NO_NAMES);
  if (!ids.length) return null;
  return (
    <div className="chips-row">
      {ids.map((id) => (
        <span key={id} className="chip">/{names[id] ?? id}<button type="button" className="chip-x" aria-label={`Remove skill ${names[id] ?? id}`} onClick={() => useComposer.getState().removeSkill(botId, id)}><CloseIcon size={10} /></button></span>
      ))}
    </div>
  );
}
