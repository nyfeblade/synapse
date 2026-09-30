import { useState } from "react";
import { useAsync } from "../async-resource";
import { BADGE_LABELS, STR_ACP, STR_KEY_STEP, modelLabel, parseAcpModelRef, type CostPreview, type ModelCatalogView, type ModelChoice, type ModelGroup, type WhatWorks } from "@synapse/shared";
import { call } from "../bridge";
import { CheckIcon } from "./Icons";

/**
 * Rendered inside the picker's popover (BotSettingsPanel), which grows from its trigger with usePopOrigin; this list
 * is the popover's content, not a popover of its own.
 *
 * Spec §10 ModelPicker: models grouped by provider, each with its badges (Supported, Experimental, Blocked,
 * Not checked, Local — from measured results, never claimed), and for the model under the pointer a short
 * "What works" list and the cost of 100 turns like this Bot's recent ones. Titles and labels only.
 */
const STATE_LABEL: Record<WhatWorks["state"], string> = { yes: "Yes", no: "No", asks: "Asks you", experimental: "Experimental", unchecked: "Not checked", "needs-key": STR_KEY_STEP.needsAnthropicKey };

export function Badges({ m }: { m: ModelChoice }) {
  if (!m.badges.length) return null; // Claude models are the reference: the host gives them no badge (ruling 48)
  return <span className="model-badges">{m.badges.map((b) => <span key={b} className={`model-badge ${b}`}>{BADGE_LABELS[b]}</span>)}</span>;
}

export function ModelPickerList({ view, current, botId, onPick }: { view: ModelCatalogView; current: string; botId: string; onPick(ref: string): void }) {
  const all = view.groups.flatMap((g) => g.models);
  const [active, setActive] = useState(current);
  const [queries, setQueries] = useState<Record<string, string>>({});
  const chosen = all.find((m) => m.ref === active) ?? all.find((m) => m.ref === current) ?? all[0];
  // Keyed by Bot and model (bug #19 guard): a preview never outlives the model it was asked for.
  const costR = useAsync<CostPreview>(() => call("getCostPreview", { id: botId, model: chosen?.ref ?? current }), [botId, chosen?.ref ?? current]);
  const cost = costR.status === "ready" && costR.value && typeof costR.value === "object" && "turns" in costR.value ? costR.value : null;
  return (
    <>
      <ul role="listbox" aria-label="Model" className="model-list">
        {view.groups.map((g) => (
          <li key={g.provider} role="presentation" className="model-group">
            <div className="model-group-label" id={`model-group-${g.provider}`}>{g.label}</div>
            {g.searchable && (
              <input type="search" className="text-input model-search" aria-label={`Search ${g.label} models`} placeholder="Search"
                value={queries[g.provider] ?? ""} onChange={(e) => setQueries({ ...queries, [g.provider]: e.target.value })} />
            )}
            <ModelRows g={g} query={queries[g.provider] ?? ""} current={current} onActive={setActive} onPick={onPick} />
          </li>
        ))}
      </ul>
      {chosen && (
        <section className="model-details" aria-label={`${chosen.label}: what works`}>
          <h4>{modelLabel(chosen.ref as never)}</h4>
          <dl className="what-works">
            {chosen.whatWorks.map((w) => <div key={w.label} className={`ww ${w.state}`}><dt>{w.label}</dt><dd>{STATE_LABEL[w.state]}</dd></div>)}
            {chosen.price && <div className="ww price"><dt>Price per 1M tokens</dt><dd>{`${usd(chosen.price.input)} in · ${usd(chosen.price.output)} out`}</dd></div>}
            <div className="ww cost"><dt>100 turns</dt><dd>{parseAcpModelRef(chosen.ref) ? STR_ACP.planNote(parseAcpModelRef(chosen.ref)!) : cost && cost.model === chosen.ref ? (cost.usdPer100 === null ? "No turns yet" : cost.usdPer100 === 0 ? "Free" : `≈ $${cost.usdPer100.toFixed(2)}`) : "…"}</dd></div>
          </dl>
        </section>
      )}
    </>
  );
}

/** A long live list (OpenRouter's) shows this many rows until a search narrows it. */
export const MODEL_ROWS_CAP = 60;
const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(2)}`);

function ModelRows({ g, query, current, onActive, onPick }: { g: ModelGroup; query: string; current: string; onActive(ref: string): void; onPick(ref: string): void }) {
  const q = query.trim().toLowerCase();
  const hits = q ? g.models.filter((m) => m.label.toLowerCase().includes(q) || m.ref.toLowerCase().includes(q)) : g.models;
  let rows = g.searchable ? hits.slice(0, MODEL_ROWS_CAP) : hits;
  // The current model always stays in view, even past the cap.
  const cur = hits.find((m) => m.ref === current);
  if (cur && !rows.includes(cur)) rows = [cur, ...rows];
  return (
    <>
      <ul role="group" aria-labelledby={`model-group-${g.provider}`}>
        {rows.map((m) => (
          <li key={m.ref} role="option" aria-selected={m.ref === current} className={m.ref === current ? "opt selected" : "opt"}
            onMouseEnter={() => onActive(m.ref)} onFocus={() => onActive(m.ref)} tabIndex={-1} onClick={() => onPick(m.ref)}>
            <span className="grow">{m.label}</span>
            {g.searchable && m.price && <span className="model-price" title="Per 1M tokens, in / out">{`${usd(m.price.input)} / ${usd(m.price.output)}`}</span>}
            <Badges m={m} />{m.ref === current && <CheckIcon />}
          </li>
        ))}
      </ul>
      {g.searchable && (hits.length > rows.length || !hits.length) && (
        <div className="model-more muted">{hits.length ? `${rows.length} of ${hits.length}` : "No matches"}</div>
      )}
    </>
  );
}
