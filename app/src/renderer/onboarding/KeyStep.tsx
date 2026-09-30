import { useEffect, useState } from "react";
import { STR, STR_KEY_STEP, providerLabel, type ProviderView, type ProvidersView } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { Segmented } from "../components/Segmented";
import { AccountPanel } from "../components/settings/AccountSection";
import { ProviderRow } from "../components/settings/ProvidersBlock";

/**
 * Any-key setup (Wave 2): the first-run key step. A provider choice with Anthropic first and chosen by default; the
 * Anthropic path is the API-key panel exactly as before. Every other provider reuses Settings → Account's provider row:
 * its one-time consent shows here and must be accepted, then its key (tested before it is saved), or for "On this
 * Mac" Ollama or LM Studio and a Test. The step is done when the host says a key is set up.
 * Used by onboarding's setup step and the portable setup screen. Titles and labels only.
 */
type Choice = "anthropic" | "openai" | "openrouter" | "gemini" | "mistral" | "deepseek" | "local";
type Local = "ollama" | "lmstudio";
const CHOICES: readonly { value: Choice; label: string }[] = [
  { value: "anthropic", label: providerLabel("anthropic") },
  ...(["openai", "openrouter", "gemini", "mistral", "deepseek"] as const).map((p) => ({ value: p, label: providerLabel(p) })),
  { value: "local", label: STR_KEY_STEP.onThisMac },
];
const LOCALS: readonly { value: Local; label: string }[] = [{ value: "ollama", label: providerLabel("ollama") }, { value: "lmstudio", label: providerLabel("lmstudio") }];

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^[A-Z_]+: /, "") || STR.hostNoAnswer;

export function KeyStep({ onReady }: { onReady(): void }) {
  const [choice, setChoice] = useState<Choice>("anthropic");
  const [local, setLocal] = useState<Local>("ollama");
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wantsProviders = choice !== "anthropic";
  useEffect(() => {
    if (!wantsProviders || view) return;
    void callQuiet("getProviders", {}).then((v) => { if (Array.isArray(v?.providers)) { setView(v); setError(null); } }).catch((e) => setError(reason(e)));
  }, [wantsProviders, view]);
  // The host decides: a provider counts once its consent is given and its key (or the app on this Mac) answered.
  const confirm = async () => {
    const o = await callQuiet("getOnboarding", {});
    if (!o.tokenConfigured) throw new Error(STR_KEY_STEP.keyNotWorking);
    onReady();
  };
  const id = choice === "local" ? local : choice;
  const row: ProviderView | undefined = id === "anthropic" ? undefined : view?.providers.find((p) => p.id === id);
  return (
    <div className="key-step">
      <Segmented<Choice> label={STR_KEY_STEP.provider} value={choice} options={CHOICES} onChange={setChoice} />
      {choice === "local" && <Segmented<Local> label={STR_KEY_STEP.localApp} value={local} options={LOCALS} onChange={setLocal} />}
      {choice === "anthropic" ? <AccountPanel firstRun onReady={onReady} />
        : row ? (
          <div className="settings-card key-step-panel">
            <ProviderRow key={row.id} p={row} onView={setView} firstRun onReady={confirm} />
          </div>
        ) : error ? <p role="alert" className="error">{error}</p> : <div className="settings-card key-step-panel" aria-busy="true" />}
    </div>
  );
}
