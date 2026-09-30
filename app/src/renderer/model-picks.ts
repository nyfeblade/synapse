import { useEffect, useRef } from "react";
import { useAsync } from "./async-resource";
import { isKeyedProvider, keyedProviderOf, type KeyChoice, type ModelCatalogView, type ModelChoice, type ModelGroup, type ModelPicksView } from "@synapse/shared";
import { callQuiet } from "./bridge";

/**
 * The model picker's rows (0.1.7): every model of every set-up provider, once per key where a provider has more than
 * one ("GPT-6.1 Sol · Work"), grouped by provider; "Recent" on top; one search across all of it. Pure, for the
 * picker component (components/ModelPicker.tsx) and its tests.
 */
export interface PickRow {
  /** Unique per model and key. */
  id: string;
  ref: string;
  /** The key that pays (null: the provider's only key, its default, or none). */
  keyId: string | null;
  label: string;
  /** Shown beside the model's name when the provider has more than one key. */
  keyLabel: string | null;
  group: ModelGroup;
  model: ModelChoice;
}
/** Creating a Bot: the model and paying key the owner chose (`touched`: changed from the preselection). */
export interface NewBotChoice { model: string; keyId: string | null; touched: boolean }
export interface PickSection { id: string; label: string; rows: PickRow[]; /** How many matched, when capped. */ total?: number }

export const rowId = (ref: string, keyId: string | null) => `${ref}\u0000${keyId ?? ""}`;
/** A long live list (OpenRouter's) shows this many rows per key until a search narrows it. */
export const MODEL_ROWS_CAP = 60;
export const RECENT_MAX = 5;

/** Every row, grouped by provider, in the catalog's order. */
export function pickRows(view: ModelCatalogView, keys: ModelPicksView["keys"] | undefined): { group: ModelGroup; rows: PickRow[] }[] {
  return view.groups.map((g) => {
    const ks: KeyChoice[] = isKeyedProvider(g.provider) ? keys?.[g.provider] ?? [] : [];
    const several = ks.length > 1;
    const rows: PickRow[] = [];
    for (const m of g.models) {
      if (!several) { rows.push({ id: rowId(m.ref, null), ref: m.ref, keyId: null, label: m.label, keyLabel: null, group: g, model: m }); continue; }
      for (const k of ks) rows.push({ id: rowId(m.ref, k.id), ref: m.ref, keyId: k.id, label: m.label, keyLabel: k.label, group: g, model: m });
    }
    return { group: g, rows };
  });
}

/** Every word of the query is somewhere in the model's name, its key's label, its provider or its id. */
export function matches(r: PickRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${r.label} ${r.keyLabel ?? ""} ${r.group.label} ${r.ref}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A recorded run's model as a picker ref: exact, else the longest Claude ref it starts with (a dated id, "[1m]"). */
export function refOf(model: string, refs: ReadonlySet<string>): string | null {
  const m = model.replace(/\[1m\]$/, "");
  if (refs.has(m)) return m;
  if (m.includes(":")) return null;
  let best: string | null = null;
  for (const r of refs) if (!r.includes(":") && m.startsWith(r) && (!best || r.length > best.length)) best = r;
  return best;
}

/** The row a model and key land on: the key's own row, else the provider's default key's row, else the model's only row. */
export function findRow(all: PickRow[], ref: string, keyId: string | null, keys: ModelPicksView["keys"] | undefined): PickRow | null {
  const same = all.filter((r) => r.ref === ref);
  if (same.length <= 1) return same[0] ?? null;
  const p = keyedProviderOf(ref);
  const def = p ? keys?.[p]?.find((k) => k.isDefault)?.id ?? null : null;
  return same.find((r) => r.keyId === keyId) ?? same.find((r) => r.keyId === def) ?? same[0]!;
}

/** The sections to show: Recent (no query) then each provider; with a query, only the matches, still by provider. */
export function pickSections(o: {
  view: ModelCatalogView; picks: ModelPicksView | null; query: string; compact: boolean; current: { ref: string; keyId: string | null };
}): { sections: PickSection[]; all: PickRow[] } {
  const groups = pickRows(o.view, o.picks?.keys);
  const all = groups.flatMap((g) => g.rows);
  const refs = new Set(all.map((r) => r.ref));
  const q = o.query.trim();
  const sections: PickSection[] = [];
  if (!q) {
    const seen = new Set<string>();
    const recent: PickRow[] = [];
    const add = (ref: string | null, keyId: string | null) => {
      if (!ref) return;
      const r = findRow(all, ref, keyId, o.picks?.keys);
      if (r && !seen.has(r.id)) { seen.add(r.id); recent.push(r); }
    };
    for (const r of o.picks?.recent ?? []) { if (recent.length >= RECENT_MAX) break; add(refOf(r.ref, refs), r.keyId); }
    if (o.compact) {
      // The short menu: recent, then what Bots use now, and always the current model.
      add(o.current.ref, o.current.keyId);
      for (const u of o.picks?.inUse ?? []) add(refOf(u.ref, refs), u.keyId);
    }
    if (recent.length) sections.push({ id: "recent", label: o.compact ? "" : "Recent", rows: recent });
    if (o.compact) return { sections, all };
  }
  const cur = findRow(all, o.current.ref, o.current.keyId, o.picks?.keys);
  for (const g of groups) {
    // Every word matches; the rows whose name holds the query as typed come first.
    const phrase = q.toLowerCase();
    const found = g.rows.filter((r) => matches(r, q));
    const hits = phrase ? [...found.filter((r) => r.label.toLowerCase().includes(phrase)), ...found.filter((r) => !r.label.toLowerCase().includes(phrase))] : found;
    if (!hits.length) continue;
    let rows = g.group.searchable && !q ? hits.slice(0, MODEL_ROWS_CAP * Math.max(1, new Set(hits.map((r) => r.keyId)).size)) : hits;
    // The current model always stays in view, even past the cap.
    if (cur && hits.includes(cur) && !rows.includes(cur)) rows = [cur, ...rows];
    sections.push({ id: `group-${g.group.provider}`, label: g.group.label, rows, ...(rows.length < hits.length ? { total: hits.length } : {}) });
  }
  return { sections, all };
}

/** The picker's data for one Bot (keys, recent, in use); null until loaded, or on an older host. `refresh` asks again. */
export function useModelPicks(botId: string, refresh: unknown = null, enabled = true): ModelPicksView | null {
  const r = useAsync<ModelPicksView>(() => callQuiet("getModelPicks", { botId }), [botId], { enabled });
  const first = useRef(true);
  const again = r.reload;
  useEffect(() => { if (first.current) { first.current = false; return; } again(); }, [refresh]);
  return r.status === "ready" && r.value && typeof r.value === "object" && "keys" in r.value ? r.value : null;
}
