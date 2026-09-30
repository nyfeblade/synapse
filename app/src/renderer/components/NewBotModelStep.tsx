import { useEffect, useRef, useState } from "react";
import { STR_KEYS, keyedProviderOf, modelLabel, type ModelPicksView } from "@synapse/shared";
import { call } from "../bridge";
import { useModelCatalog } from "../model-catalog";
import { useModelPicks, type NewBotChoice } from "../model-picks";
import { acceptAgent } from "../store";
import { ChevronDownIcon } from "./Icons";
import { ModelPicker } from "./ModelPicker";

/**
 * Creating a Bot (0.1.7): the owner picks its model — and, when that model's provider has more than one key, which key
 * pays, the provider's default preselected. One short step inside each way a Bot is made (New chat, onboarding's first
 * Bot, a starter, a template, a shared Bot). The compact model picker opens from the Model row; a key row shows only
 * with several keys. Nothing is sent until the Bot exists: `applyNewBotChoice` saves the choice to it exactly as the
 * picker does (pickAgentModel). A choice left as preselected changes nothing (the host's default model and key apply).
 */
export type { NewBotChoice };

/** After the Bot is made: the owner's choice, saved as the picker saves it. Untouched: nothing to save. */
export async function applyNewBotChoice(botId: string, choice: NewBotChoice | null): Promise<void> {
  if (!choice?.touched) return;
  const r = await call("pickAgentModel", { id: botId, model: choice.model, keyId: choice.keyId });
  if (r?.agent) acceptAgent(r.agent);
}

const keysFor = (picks: ModelPicksView | null, model: string) => {
  const p = keyedProviderOf(model);
  return p ? picks?.keys[p] ?? [] : [];
};

export function NewBotModelStep({ choice, onChange }: { choice: NewBotChoice | null; onChange(c: NewBotChoice): void }) {
  const catalog = useModelCatalog((s) => s.view);
  useEffect(() => { void useModelCatalog.getState().load(); }, []);
  const picks = useModelPicks("");
  // Preselected: the model a new Bot gets, paid by its provider's default key.
  useEffect(() => {
    if (choice || !picks) return;
    onChange({ model: picks.newBotModel ?? "claude-sonnet-5", keyId: null, touched: false });
  }, [picks, choice]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Escape inside the open picker closes just the picker (in a sheet, not the sheet under it).
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && ref.current?.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); setOpen(false); } };
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("mousedown", onDown); };
  }, [open]);
  if (!choice) return null;
  const keys = keysFor(picks, choice.model);
  const keyId = choice.keyId ?? keys.find((k) => k.isDefault)?.id ?? null;
  return (
    <div className="new-bot-model" ref={ref} role="group" aria-label={STR_KEYS.model}>
      <div className="new-bot-row">
        <span className="new-bot-label">{STR_KEYS.model}</span>
        <button type="button" className="dropdown select" aria-haspopup="listbox" aria-expanded={open} aria-label={`${STR_KEYS.model}: ${modelLabel(choice.model as never)}`}
          onClick={() => setOpen(!open)}>
          <span>{modelLabel(choice.model as never)}</span><ChevronDownIcon />
        </button>
        {open && catalog && (
          <div className="new-bot-pop">
            <ModelPicker compact view={catalog} picks={picks} current={{ ref: choice.model, keyId }} botId=""
              onPick={(model, k) => { setOpen(false); onChange({ model, keyId: k ?? (keysFor(picks, model).length > 1 ? keysFor(picks, model).find((x) => x.isDefault)?.id ?? null : null), touched: true }); }} />
          </div>
        )}
      </div>
      {keys.length > 1 && (
        <div className="new-bot-row">
          <span className="new-bot-label" id="new-bot-key">{STR_KEYS.key}</span>
          <span className="segmented" role="radiogroup" aria-labelledby="new-bot-key">
            {keys.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={k.id === keyId} className={k.id === keyId ? "seg on" : "seg"}
                onClick={() => onChange({ ...choice, keyId: k.id, touched: true })}>{k.label}</button>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}
