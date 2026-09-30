import {
  isLocalProvider, isProviderModelRef, MODEL_CATALOG, modelLabel, OFFERED_PROVIDERS, parseProviderModelRef, PROVIDER_CATALOG, providerLabel, providerPrice,
  catalogModel, contextWindow, ACP_VENDORS, type LiveModel, STR_ACP, isAcpModelRef, parseAcpModelRef, type AcpVendorId, type ModelChoice, type ModelGroup, type ModelCatalogView, type ProviderId, type WhatWorks, type ModelId,
} from "@synapse/shared";
import { listPrice } from "../../usage/list-price";
import { badgesFor, type ProviderEvidenceStore } from "./conformance/evidence";
import { quirksFor } from "./adapters/quirks";
import { searchProviderFor } from "../../tools/builtin/web-search";

/**
 * The model picker's data (spec §10): models grouped by provider (Claude first when keyed), each with the badges its
 * measured evidence gives it and a short "What works" list (spec §9), phrased as labels and states only.
 */
type P = Exclude<ProviderId, "anthropic">;
export interface CatalogDeps {
  claudeModels(): ModelId[];
  usable(p: P): boolean;
  evidence: ProviderEvidenceStore;
  reviewerQualified(): boolean;
  /** Models a provider lists live (local models, OpenRouter's), beyond the catalog. */
  extraModels?(p: P): string[];
  /** A provider's live model list (OpenRouter's daily /models): every model it lists, searchable in the picker. */
  liveModels?(p: P): LiveModel[];
  /** Wave 3: the vendor coding CLIs the user allowed (consented); absent = none. */
  acpVendors?(): AcpVendorId[];
  /** Any-key setup: an Anthropic key is saved. false = what runs on Claude shows "Needs an Anthropic key"; absent = unknown. */
  anthropicKey?(): boolean;
}


export function whatWorks(ref: string, d: Pick<CatalogDeps, "usable" | "evidence" | "reviewerQualified" | "anthropicKey">): WhatWorks[] {
  const rows = whatWorksRows(ref, d);
  // Any-key setup: coding agents and computer and browser helpers run on Claude (rulings 65, 70, 71); with no Anthropic
  // key they are refused up front, and the picker says why instead of a plain No.
  if (d.anthropicKey?.() !== false || !parseProviderModelRef(ref)) return rows;
  return [...rows.map((w) => (w.label === "Coding agents" ? { ...w, state: "needs-key" as const } : w)), { label: "Computer helpers", state: "needs-key" }];
}

function whatWorksRows(ref: string, d: Pick<CatalogDeps, "usable" | "evidence" | "reviewerQualified">): WhatWorks[] {
  if (parseAcpModelRef(ref)) {
    // A vendor's own coding CLI: its tools ask Synapse's gate; Synapse's own tools (search, subagents, coding agents) aren't there.
    return [
      { label: "Tools and replies", state: "experimental" }, { label: "Auto-review", state: d.reviewerQualified() ? "yes" : "asks" },
      { label: "Web search", state: "no" }, { label: "Images", state: "no" }, { label: "Voice calls", state: "no" },
      { label: "Coding agents", state: "no" }, { label: "Subagents", state: "no" },
    ];
  }
  const p = parseProviderModelRef(ref);
  if (!p) {
    return [
      { label: "Tools and replies", state: "yes" }, { label: "Auto-review", state: "yes" }, { label: "Web search", state: "yes" },
      { label: "Images", state: "yes" }, { label: "Voice calls", state: "yes" }, { label: "Coding agents", state: "yes" }, { label: "Subagents", state: "yes" },
    ];
  }
  const pc = d.evidence.conformance(ref);
  const res = (id: string) => pc?.results.find((r) => r.id === id)?.status;
  const tools: WhatWorks["state"] = !pc ? "unchecked" : res("PC-02") === "pass" ? "yes" : "no";
  const row = catalogModel(ref);
  const vision = pc?.flags.vision ?? row?.vision ?? null;
  // Which provider would search (its own, else the first set up). Gemini's grounding has only been tried against a fake
  // server (ruling 43; phase 0 got a 429 on the free key), so search through it is Experimental.
  const searcher = searchProviderFor(ref, (x) => x !== "anthropic" && (x === p.provider || d.usable(x as P)));
  const local = isLocalProvider(p.provider);
  return [
    { label: "Tools and replies", state: tools },
    { label: "Auto-review", state: d.reviewerQualified() ? "yes" : "asks" },
    { label: "Web search", state: !searcher ? "no" : searcher === "gemini" ? "experimental" : "yes" },
    { label: "Images", state: vision === null ? "unchecked" : vision ? "yes" : "no" },
    { label: "Voice calls", state: local ? "experimental" : "yes" },
    { label: "Coding agents", state: "no" },
    { label: "Subagents", state: tools }, // spec P2: a Task child runs on the same provider model, so it works where tools do
  ];
}

export function modelCatalogView(d: CatalogDeps): ModelCatalogView {
  const groups: ModelGroup[] = [];
  const claude = d.claudeModels();
  if (claude.length) {
    // Ruling 48: Claude models are the reference every provider is measured against, so they carry no badge.
    groups.push({ provider: "anthropic", label: providerLabel("anthropic"), models: claude.map((m) => ({ ref: m, label: modelLabel(m), badges: [], whatWorks: whatWorks(m, d), contextWindow: contextWindow(m) })) });
  }
  for (const p of OFFERED_PROVIDERS) {
    if (p === "anthropic" as never || !d.usable(p)) continue;
    const refs = [...new Set([...MODEL_CATALOG.filter((r) => r.ref.startsWith(`${p}:`)).map((r) => r.ref as string), ...(d.extraModels?.(p) ?? []).map((m) => `${p}:${m}`)])].filter(isProviderModelRef);
    // The live list (OpenRouter's) adds every model it lists that takes tools (a Bot replies through one) and isn't above.
    const known = new Set<string>(refs);
    const live = (d.liveModels?.(p) ?? []).filter((m) => m.tools !== false && isProviderModelRef(m.ref) && !known.has(m.ref));
    const liveByRef = new Map(live.map((m) => [m.ref, m]));
    for (const m of d.liveModels?.(p) ?? []) if (known.has(m.ref)) liveByRef.set(m.ref, m); // a used model keeps its live name and price
    const all = [...refs, ...live.map((m) => m.ref)].filter(isProviderModelRef);
    if (!all.length) continue;
    const models: ModelChoice[] = all.map((ref) => {
      const lm = liveByRef.get(ref);
      const pr = isLocalProvider(p) ? null : lm?.price ?? (catalogModel(ref) ? providerPrice(ref) : null);
      return {
        ref, label: catalogModel(ref)?.label ?? lm?.name ?? parseProviderModelRef(ref)!.model,
        badges: badgesFor(ref, d.evidence.conformance(ref), d.evidence.bench(ref)), whatWorks: whatWorks(ref, d), contextWindow: contextWindow(ref),
        ...(pr ? { price: { input: pr.input, output: pr.output } } : {}),
        ...(!known.has(ref) ? { liveOnly: true as const } : {}),
      };
    });
    groups.push({ provider: p, label: providerLabel(p), models, ...(live.length ? { searchable: true as const } : {}) });
  }
  const vendors = d.acpVendors?.() ?? [];
  if (vendors.length) {
    groups.push({ provider: "acp", label: STR_ACP.groupLabel, models: vendors.map((v) => ({
      ref: `acp:${v}`, label: ACP_VENDORS[v].label, badges: ["experimental"], whatWorks: whatWorks(`acp:${v}`, d), contextWindow: contextWindow(`acp:${v}`),
    })) });
  }
  return { groups };
}

/** Spec §10 cost preview: the median turn of the last 30 days (tokens), priced on `model`, times 100. */
export function costPer100(model: string, turns: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }[]): number | null {
  // A turn that reported no tokens (a scripted one, an interrupted one) says nothing about cost.
  if (isAcpModelRef(model)) return 0; // the vendor's plan: no per-token cost (the picker says "Included in your … plan")
  turns = turns.filter((t) => t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens > 0);
  if (!turns.length) return null;
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
  const input = med(turns.map((t) => t.inputTokens));
  const cached = med(turns.map((t) => t.cacheReadTokens));
  const write = med(turns.map((t) => t.cacheWriteTokens));
  const out = med(turns.map((t) => t.outputTokens));
  let usd: number;
  if (isProviderModelRef(model)) {
    const pr = providerPrice(model, input + cached);
    usd = (pr.input * (input + write) + pr.cachedInput * cached + pr.output * out) / 1e6;
  } else {
    const lp = listPrice(model);
    usd = (lp.input * (input + cached * 0.1 + write * 1.25) + lp.output * out) / 1e6;
  }
  return Math.round(usd * 100 * 100) / 100;
}

/** The provider's helper and search facts, for tests and the view. */
export function providerHasHelper(p: P): boolean { return PROVIDER_CATALOG[p].helperModel !== null; }
export function providerSearches(p: P): boolean { return quirksFor(p).nativeSearch; }
