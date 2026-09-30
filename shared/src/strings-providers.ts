import { providerLabel, type ProviderId } from "./providers";

/** Multi-provider Bots (spec §6): what a failed provider call says, in the app's words. */
export const STR_PROVIDER = {
  keyRejectedTitle: "Key rejected",
  keyRejected: (p: ProviderId) => `${providerLabel(p)} rejected the saved key. Check it in Settings → Account.`,
  noKeyTitle: "No key saved",
  noKey: (p: ProviderId) => `There's no ${providerLabel(p)} key saved. Add one in Settings → Account.`,
  forbiddenTitle: "Not allowed",
  forbidden: (p: ProviderId, detail: string) => `${providerLabel(p)} refused this request${detail ? `: ${detail}` : "."}`,
  noCreditTitle: "No credit",
  noCredit: (p: ProviderId) => `The ${providerLabel(p)} account is out of credit or over its quota.`,
  overBudgetTitle: "Spend budget reached",
  noConsentTitle: "Not allowed yet",
  noConsent: (p: ProviderId) => `${providerLabel(p)} hasn't been allowed yet. Allow it in Settings → Account.`,
  overBudget: "The spend budget is reached, so the model wasn't called. Raise it in Settings → Usage.",
  rateLimitedTitle: "Rate limited",
  rateLimited: (p: ProviderId, sec?: number) => `${providerLabel(p)} is rate limiting this key${sec ? `; try again in about ${sec} s` : ""}.`,
  modelMissingTitle: "Model not available",
  modelMissing: (p: ProviderId, model: string) => `${providerLabel(p)} doesn't offer "${model}" to this key.`,
  contextTitle: "Conversation too long",
  context: (p: ProviderId) => `The conversation is longer than this ${providerLabel(p)} model can read.`,
  serverTitle: "Bot failed to respond",
  server: (p: ProviderId, status: number) => `${providerLabel(p)} had a server error (${status}).`,
  overloaded: (p: ProviderId, status: number) => `${providerLabel(p)} is overloaded right now (${status}).`,
  timeout: (p: ProviderId) => `${providerLabel(p)} stopped answering.`,
  unreachable: (p: ProviderId) => (p === "ollama" ? "Can't reach Ollama on this Mac. Is it running?" : p === "lmstudio" ? "Can't reach LM Studio on this Mac. Is its server running?" : `Can't reach ${providerLabel(p)}.`),
  refusedTitle: "The provider refused",
  refused: (p: ProviderId) => `${providerLabel(p)}'s safety filter stopped this reply.`,
  badRequest: (p: ProviderId, detail: string) => `${providerLabel(p)} couldn't take this request${detail ? `: ${detail}` : "."}`,
} as const;

/** Spec §4 (owner answer 4): one consent per provider before anything is sent to it. A new version asks again. */
export const PROVIDER_CONSENT_VERSION = 1;
export function providerConsentText(p: ProviderId): string {
  const name = providerLabel(p);
  if (p === "ollama" || p === "lmstudio") {
    return `Bots on ${name} run on a model on this Mac. Their conversations, tool results, files they read, safety checks and call transcripts stay on this Mac.`;
  }
  const what = `Bots on ${name} send ${name} their conversation, tool results, files they read, safety-check inputs, memory notes and call transcripts. ${name}'s own terms and privacy policy apply.`;
  return p === "openrouter" ? `${what} OpenRouter passes each request to the company that runs the model; Synapse asks it to use only companies that don't keep your data.` : what;
}

export const STR_PROVIDER_UI = {
  sectionTitle: "Model providers",
  keyLabel: (p: ProviderId) => `${providerLabel(p)} key`,
  keyPlaceholder: "Paste a key",
  noKey: "No key",
  local: "On this Mac",
  save: "Save",
  replace: "Replace",
  test: "Test key",
  testing: "Testing…",
  testLocal: "Test",
  remove: "Remove",
  consentTitle: (p: ProviderId) => `Use ${providerLabel(p)}?`,
  consentAllow: "Allow",
  consentCancel: "Cancel",
  consentNeeded: "Allow this provider first.",
  allowed: "Allowed",
  allow: "Allow",
  keyOk: "Key works",
  safetyTitle: "Safety reviewer",
  safetyModel: "Reviewer model",
  safetyState: "Automatic review",
  safetyQualified: "Qualified",
  safetyAskOnly: "Ask-only",
  safetyNotChecked: "Not checked",
  safetyRun: "Run safety check",
  safetyRunning: "Checking…",
  safetyProgress: (done: number, total: number) => `${done} of ${total}`,
  safetyCancel: "Cancel",
  safetyClaude: "Claude",
  badFormat: "That doesn't look like a key.",
} as const;

/** Any-key setup: the first-run key step's provider choice. Titles and labels only. */
export const STR_KEY_STEP = {
  provider: "Provider",
  onThisMac: "On this Mac",
  localApp: "App",
  saveKey: "Save key",
  continue: "Continue",
  keyNotWorking: "That key didn't work.",
  localNotAnswering: "No answer yet. Start it, then Test again.",
  noLocalModels: "No models on this Mac yet. Download one, then pick it in Settings → Account.",
  reviewerAsks: "Safety review asks you until its model passes the check.",
  needsAnthropicKey: "Needs an Anthropic key",
} as const;
