import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useAsync } from "../async-resource";
import { BADGE_LABELS, STR_ACP, STR_KEY_STEP, STR_KEYS, modelLabel, parseAcpModelRef, type CostPreview, type ModelCatalogView, type ModelChoice, type ModelPicksView, type WhatWorks } from "@synapse/shared";
import { call } from "../bridge";
import { pickSections, type PickRow } from "../model-picks";
import { CheckIcon, SearchIcon } from "./Icons";

/**
 * The model picker (0.1.7): one searchable list across every set-up provider and key, grouped by provider, "Recent" on
 * top, a model shown once per key where a provider has more than one ("GPT-6.1 Sol · Work"). Type to search, arrows
 * and Enter to pick. Badges are quiet labels and never block. Rendered inside a popover (Bot settings, the Composer's
 * model chip); `compact` is the Composer's short form: recent and in-use models, then "All models…" for the rest.
 *
 * For the model under the pointer or the arrows: a short "What works" list and the cost of 100 turns like this Bot's.
 * Titles and labels only.
 */
const STATE_LABEL: Record<WhatWorks["state"], string> = { yes: "Yes", no: "No", asks: "Asks you", experimental: "Experimental", unchecked: "Not checked", "needs-key": STR_KEY_STEP.needsAnthropicKey };

export function Badges({ m }: { m: ModelChoice }) {
  if (!m.badges.length) return null; // Claude models are the reference: the host gives them no badge (ruling 48)
  return <span className="model-badges">{m.badges.map((b) => <span key={b} className={`model-badge ${b}`}>{BADGE_LABELS[b]}</span>)}</span>;
}

/**
 * A hook for the per-Bot Engine setting (Synapse's own loop or Claude Code), shown compactly beside Claude models.
 * The picker renders it only when given; Bot settings passes it once the engine setting exists.
 */
export interface EngineChoice { value: string; options: { id: string; label: string }[]; onChange(id: string): void }

export interface ModelPickerProps {
  view: ModelCatalogView;
  /** Keys, recent and in-use models (getModelPicks); null = none yet (the list still works). */
  picks: ModelPicksView | null;
  current: { ref: string; keyId: string | null };
  botId: string;
  onPick(ref: string, keyId: string | null): void;
  compact?: boolean;
  engine?: EngineChoice;
}

const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(2)}`);
const isClaudeRow = (r: PickRow | undefined) => !!r && r.group.provider === "anthropic";

export function ModelPicker({ view, picks, current, botId, onPick, compact = false, engine }: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(!compact);
  const short = compact && !expanded && !query.trim();
  const { sections } = useMemo(() => pickSections({ view, picks, query, compact: short, current }), [view, picks, query, short, current.ref, current.keyId]);
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  // One stop per listed row (Recent repeats a provider's row): "<section>|<row id>".
  const stops = useMemo(() => sections.flatMap((s) => s.rows.map((r) => ({ key: `${s.id}|${r.id}`, r }))), [sections]);
  const selectedId = rows.find((r) => r.ref === current.ref && (r.keyId === current.keyId || r.keyId === null))?.id
    ?? rows.find((r) => r.ref === current.ref && r.keyId === defaultKeyOf(picks, r))?.id
    ?? rows.find((r) => r.ref === current.ref)?.id ?? null;
  // The keyboard's position: a stop, or "all" for the short menu's "All models…".
  const [active, setActive] = useState<string | null>(null);
  const nav = useMemo(() => [...stops.map((x) => x.key), ...(short ? ["all"] : [])], [stops, short]);
  const selectedStop = stops.find((x) => x.r.id === selectedId && !x.key.startsWith("recent|"))?.key ?? stops.find((x) => x.r.id === selectedId)?.key ?? null;
  const activeId = active && nav.includes(active) ? active : selectedStop && !query.trim() ? selectedStop : nav[0] ?? null;
  const activeRow = stops.find((x) => x.key === activeId)?.r;
  const detailRow = activeRow ?? rows.find((r) => r.id === selectedId);
  const uid = useId().replace(/:/g, "");
  const optId = (id: string) => `mp${uid}-${nav.indexOf(id)}`;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, [expanded]);
  // The active row stays in view as the arrows move it.
  useLayoutEffect(() => {
    if (!activeId) return;
    const el = list.current?.querySelector(`#${optId(activeId)}`) as HTMLElement | null;
    // Only the popover scrolls: scrollIntoView would also scroll the panel under it and push the trigger out of view.
    const box = el?.closest(".model-pop, .composer-model-pop") as HTMLElement | null;
    if (!el || !box) return;
    const search = box.querySelector(".model-search-row") as HTMLElement | null;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const head = search?.offsetHeight ?? 0;
    if (top < head) box.scrollTop += top - head;
    else if (top + el.offsetHeight > box.clientHeight) box.scrollTop += top + el.offsetHeight - box.clientHeight;
  }, [activeId]);

  const pick = (id: string | null) => {
    if (id === "all") { setExpanded(true); setActive(null); return; }
    const r = stops.find((x) => x.key === id)?.r;
    if (r) onPick(r.ref, r.keyId);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const i = activeId ? nav.indexOf(activeId) : -1;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(nav[Math.min(nav.length - 1, i + 1)] ?? null); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(nav[Math.max(0, i - 1)] ?? null); }
    else if (e.key === "Enter") { e.preventDefault(); pick(activeId); }
  };

  // Hover or the arrows: the model whose What works and cost show below.
  const costRef = detailRow?.ref ?? current.ref;
  const costR = useAsync<CostPreview | null>(() => (compact ? Promise.resolve(null) : call("getCostPreview", { id: botId, model: costRef })), [botId, costRef, compact]);
  const cost = costR.status === "ready" && costR.value && typeof costR.value === "object" && "turns" in costR.value ? costR.value : null;
  const chosen = detailRow?.model;

  return (
    <div className={compact ? "model-picker compact" : "model-picker"} onKeyDown={onKey}>
      <div className="model-search-row">
        <SearchIcon />
        <input ref={input} type="search" role="combobox" aria-expanded="true" aria-controls={`mp${uid}-list`} aria-autocomplete="list"
          aria-activedescendant={activeId ? optId(activeId) : undefined} className="model-search" aria-label={STR_KEYS.searchModels} placeholder={STR_KEYS.searchModels}
          value={query} onChange={(e) => { setQuery(e.target.value); setActive(null); }} spellCheck={false} autoComplete="off" />
      </div>
      <div ref={list} id={`mp${uid}-list`} role="listbox" aria-label="Model" className="model-list">
        {sections.map((s) => (
          <div key={s.id} role="group" aria-label={s.label || STR_KEYS.recent} className="model-group">
            {s.label && <div className="model-group-label" aria-hidden="true">{s.label}</div>}
            {s.rows.map((r) => {
              const stop = `${s.id}|${r.id}`;
              return (
                <Row key={stop} r={r} id={optId(stop)} selected={r.id === selectedId} active={stop === activeId} showPrice={!!r.group.searchable}
                  onHover={() => setActive(stop)} onPick={() => pick(stop)} />
              );
            })}
            {s.total !== undefined && <div className="model-more muted">{`${s.rows.length} of ${s.total}`}</div>}
          </div>
        ))}
        {!rows.length && <div className="model-more muted" role="status">{STR_KEYS.noMatches}</div>}
        {short && (
          <div role="option" id={optId("all")} aria-selected="false" className={activeId === "all" ? "opt model-all active" : "opt model-all"}
            onMouseEnter={() => setActive("all")} onMouseDown={(e) => e.preventDefault()} onClick={() => pick("all")}>{STR_KEYS.allModels}</div>
        )}
      </div>
      {engine && (isClaudeRow(detailRow) || (!detailRow && !current.ref.includes(":"))) && <EngineRow engine={engine} />}
      {!compact && chosen && detailRow && (
        <section className="model-details" aria-label={`${chosen.label}: what works`}>
          <h4>{modelLabel(chosen.ref as never)}{detailRow.keyLabel ? ` · ${detailRow.keyLabel}` : ""}</h4>
          <dl className="what-works">
            {chosen.whatWorks.map((w) => <div key={w.label} className={`ww ${w.state}`}><dt>{w.label}</dt><dd>{STATE_LABEL[w.state]}</dd></div>)}
            {chosen.price && <div className="ww price"><dt>Price per 1M tokens</dt><dd>{`${usd(chosen.price.input)} in · ${usd(chosen.price.output)} out`}</dd></div>}
            <div className="ww cost"><dt>100 turns</dt><dd>{parseAcpModelRef(chosen.ref) ? STR_ACP.planNote(parseAcpModelRef(chosen.ref)!) : cost && cost.model === chosen.ref ? (cost.usdPer100 === null ? "No turns yet" : cost.usdPer100 === 0 ? "Free" : `≈ $${cost.usdPer100.toFixed(2)}`) : "…"}</dd></div>
          </dl>
        </section>
      )}
    </div>
  );
}

function defaultKeyOf(picks: ModelPicksView | null, r: PickRow): string | null {
  const p = r.group.provider;
  return p === "acp" ? null : (picks?.keys as Record<string, { id: string; isDefault: boolean }[] | undefined> | undefined)?.[p]?.find((k) => k.isDefault)?.id ?? null;
}

function Row({ r, id, selected, active, showPrice, onHover, onPick }: { r: PickRow; id: string; selected: boolean; active: boolean; showPrice: boolean; onHover(): void; onPick(): void }): ReactNode {
  return (
    <div role="option" id={id} aria-selected={selected} aria-label={r.keyLabel ? `${r.label} · ${r.keyLabel}` : undefined} className={`opt${selected ? " selected" : ""}${active ? " active" : ""}`}
      onMouseEnter={onHover} onMouseDown={(e) => e.preventDefault()} onClick={onPick}>
      <span className="model-name">{r.label}{r.keyLabel && <span className="model-key">{` · ${r.keyLabel}`}</span>}</span>
      {showPrice && r.model.price && <span className="model-price" title="Per 1M tokens, in / out">{`${usd(r.model.price.input)} / ${usd(r.model.price.output)}`}</span>}
      <Badges m={r.model} />
      {selected && <CheckIcon />}
    </div>
  );
}

function EngineRow({ engine }: { engine: EngineChoice }) {
  return (
    <div className="model-engine" role="radiogroup" aria-label={STR_KEYS.engine}>
      <span className="muted">{STR_KEYS.engine}</span>
      <span className="segmented">
        {engine.options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={o.id === engine.value} className={o.id === engine.value ? "seg on" : "seg"}
            onMouseDown={(e) => e.preventDefault()} onClick={() => engine.onChange(o.id)}>{o.label}</button>
        ))}
      </span>
    </div>
  );
}

/** Before 0.1.7's keys (and for callers that pick a model only): the full picker, no key choice. */
export function ModelPickerList({ view, current, botId, onPick }: { view: ModelCatalogView; current: string; botId: string; onPick(ref: string): void }) {
  return <ModelPicker view={view} picks={null} current={{ ref: current, keyId: null }} botId={botId} onPick={(ref) => onPick(ref)} />;
}
