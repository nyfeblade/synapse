/**
 * How every model call the box makes (Bots, helpers, reviewer, memory…) reaches Claude: an Anthropic API key
 * (Console billing), and nothing else. Bots still run on Claude Code (the Agent SDK spawns the CLI); the CLI gets
 * the key as ANTHROPIC_API_KEY (through the key proxy), never a Claude login. The key is sealed to the box public
 * key on the Mac, kept encrypted on the box, and never sent back: the app sees `sk-ant-…last4` only.
 */
export interface AuthView {
  /** The saved key, masked (never the key itself). */
  apiKey: { masked: string; savedAt: number } | null;
  /** What the Mac seals a new key to (crypto_box_seal). */
  boxPublicKey: string;
}

/**
 * Which models the saved key can reach, and which have 1M context (free count_tokens probes, after a key is saved and
 * on demand). A model missing from `models` hasn't been checked; false = the key can't use it (hidden in the picker).
 */
export interface ModelAccessView {
  checkedAt: number | null;
  checking: boolean;
  models: Partial<Record<import("./models").ModelId, boolean>>;
  /** 1M context per model that has a [1m] arm; false = spawn at 200k. */
  longContext: Partial<Record<import("./models").ModelId, boolean>>;
}

export type AuthProblemKind = "web-search-disabled" | "invalid-key" | "billing" | "rate-limited" | "overloaded" | "permission" | "model-unavailable" | "server" | "bad-request" | "network" | "no-key" | "over-budget" | "proxy-down";

export interface AuthTestResult {
  ok: boolean;
  /** An HTTP answer came back from Anthropic (even a rejection proves the box reaches it). */
  reached: boolean;
  kind: "ok" | AuthProblemKind;
  status: number | null;
  title: string;
  detail: string;
  retryAfterSec?: number;
}

/**
 * Bug 281: the API-key check (Settings → Account → Check, and after a key is saved). The host runs the free count_tokens
 * probe, then sends ONE tiny real message (max_tokens 8, the cheapest reachable model, through the key proxy, the
 * budget and usage like any other spend) and says what it found. Kept in hostPrivate/anthropic-auth (no secrets).
 */
export interface KeyCheckView {
  checkedAt: number | null;
  checking: boolean;
  /** true: the message went through; false: something failed (`problem`); null: not checked yet. */
  works: boolean | null;
  problem: { kind: AuthProblemKind; title: string; detail: string; status: number | null; retryAfterSec?: number } | null;
  /** The model the message went to (the cheapest the key reaches). */
  model: import("./models").ModelId | null;
  /** The models the probe found the key can use. */
  models: import("./models").ModelId[];
  /** Whether any model has 1M context for this key; null = unknown. */
  longContext: boolean | null;
  /** Whether web search is on for the key's organization; null = unknown. */
  webSearch: boolean | null;
}

/** Console API keys (sk-ant-api03-…). Anything else, a Claude login token included, is refused: it is not an API key. */
export const API_KEY_RE = /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}$/;

/**
 * Bug 280: the betas a Claude login adds (every `oauth-*` one, dated like the others). The public build signs in with
 * an API key only, so both key proxies drop them from `anthropic-beta` before a request goes upstream; every other
 * beta passes in its order. Undefined when nothing is left (the header is then left out).
 */
export function withoutLoginBetas(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  const kept = (Array.isArray(v) ? v.join(",") : v).split(",").map((b) => b.trim()).filter((b) => b && !/^oauth-/i.test(b));
  return kept.length ? kept.join(",") : undefined;
}

/**
 * Bug 280: "prompt is too long", in the API's words ("prompt is too long: 207706 tokens > 200000 maximum", recording
 * 0046) or the CLI's ("Prompt is too long · the request is ~207706 tokens (limit 200000) …"), with its two numbers
 * when they are there.
 */
export function promptTooLong(text: string | null | undefined): { tokens?: number; limit?: number } | null {
  const t = text ?? "";
  if (!/prompt is too long/i.test(t)) return null;
  const m = /(\d[\d,]*)\s*tokens\s*(?:>\s*(\d[\d,]*)\s*maximum|\(limit\s*(\d[\d,]*)\))/i.exec(t);
  const n = (v?: string) => (v ? Number(v.replace(/,/g, "")) : undefined);
  return m ? { tokens: n(m[1]), limit: n(m[2] ?? m[3]) } : {};
}

/** The API's words when an organization has web search turned off (inferred: "not enabled" / "disabled" / "turned off"). */
export const WEB_SEARCH_OFF_RE = /web[ _-]?search\b[^.\n]{0,60}\b(not enabled|disabled|turned off|not allowed|not available)/i;

export function maskApiKey(key: string): string {
  return `sk-ant-…${key.slice(-4)}`;
}

export const STR_AUTH = {
  sectionTitle: "Account",
  keyLabel: "Anthropic API key",
  keyHelp: "Billed to your Anthropic Console account.",
  keyPlaceholder: "sk-ant-api03-…",
  saveKey: "Save key",
  createKey: "Create a key",
  /** console.anthropic.com, where an Anthropic API key is created (the first-run choice and Settings → Account). */
  consoleKeysUrl: "https://console.anthropic.com/settings/keys",
  replaceKey: "Replace key",
  removeKey: "Remove key",
  savedKey: (masked: string) => `Saved: ${masked}`,
  noKey: "No API key saved yet.",
  badKeyFormat: "That doesn't look like an Anthropic API key (it starts with sk-ant-api).",
  testConnection: "Test connection",
  testing: "Testing…",
  appliesNext: "Takes effect from each Bot's next turn. Replies already being written finish as they started.",
  firstRunTitle: "Add your AI key",
  firstRunContinue: "Continue",
  // Test connection and turn errors.
  // New-user walk, finding 9: no check mark beside a failure.
  ok: "Key works",
  keyRejected: "Key rejected",
  keyRejectedDetail: "Anthropic didn't accept this API key. Check it was copied whole, or create a new one in the Console.",
  billing: "No API credits",
  billingDetail: "Your Anthropic account has no credits or billing isn't set up. Add credits in the Anthropic Console → Billing.",
  rateLimited: "Rate limited by Anthropic",
  rateLimitedDetail: (sec?: number) => (sec ? `Too many requests. Try again in ${sec} s.` : "Too many requests. Try again in a moment."),
  overloaded: "Anthropic is overloaded",
  overloadedDetail: "Anthropic's servers are busy. Bots retry on their own with backoff.",
  permission: "Key can't use this",
  permissionDetail: "This API key doesn't have permission for that request. Check the key's workspace and limits in the Console.",
  modelUnavailable: "Model not available to this key",
  modelUnavailableDetail: "This Bot's model isn't available to your API key. Pick another model in the Bot's settings.",
  server: "Anthropic had an error",
  serverDetail: "Anthropic's API returned a server error. Try again shortly.",
  badRequest: "Request refused",
  network: "Couldn't reach Anthropic",
  networkDetail: "The computer couldn't connect to api.anthropic.com. Check its internet connection.",
  noKeyTitle: "No API key",
  noKeyDetail: "Bots need an Anthropic API key. Add one in Settings → Account.",
  macKeyTitle: "Save the API key on this Mac",
  // New-user walk, finding 2: a changed box identity is trusted where it's reported (the key panel), not in a missing section.
  pinMismatch: "The Bots' computer has changed since this Mac paired with it. Trust it in Settings → Account if you reset or set it up again.",
  pinChanged: "The Bots' computer has changed since this Mac paired with it.",
  trustComputer: "Trust this computer",
  // A native alert: a short message, the reason and the evidence in the detail (UI-controls pass, 2026-09-29).
  trustConfirmTitle: "The Bots' computer's identity changed",
  trustConfirmDetail: (oldFp: string, newFp: string) => `Only trust it if you reset or reinstalled it yourself.\n\nPaired with: ${oldFp}\nNow: ${newFp}`,
  trustConfirmCancel: "Cancel",
  trusted: "Trusted. Save the key again to send it.",
  keyNotSaved: "The key wasn't saved. Try again.",
  macKeyNotSaved: "Saved on the Bots' computer, but not on this Mac:",
  save: "Save",
  webSearchDisabled: "Web search is off for this API key",
  webSearchDisabledDetail: "Your Anthropic organization has web search turned off. An organization admin can turn it on in the Anthropic Console.",
  modelFallbackTitle: "Model not available to this key",
  modelFallback: (from: string, to: string) => `${from} isn't available to your API key, so this Bot is using ${to}.`,
  checkModels: "Check models",
  // Bug 281: the API-key check. Titles and plain labels only.
  check: "Check",
  checking: "Checking…",
  keyWorks: "Key works",
  rowModels: "Models",
  rowLongContext: "1M context",
  rowWebSearch: "Web search",
  available: "Available",
  notAvailable: "Not available",
  on: "On",
  off: "Off",
  unknown: "Unknown",
  none: "None",
  overBudget: "Spend budget reached",
  overBudgetDetail: "The check sends one small request, and the spend budget is used up. Raise it in Settings → Usage.",
  noModels: "No model available to this key",
  noModelsDetail: "Your API key can't use any of the models Synapse offers. Check the key's workspace in the Anthropic Console.",
  // Bug 280: a request over the model's context window (400 invalid_request_error "prompt is too long: N tokens > M maximum").
  promptTooLong: "Chat too long for the model",
  promptTooLongDetail: (tokens?: number, limit?: number) =>
    `This chat is longer than the model can read${tokens && limit ? ` (about ${tokens.toLocaleString("en-US")} tokens; the limit is ${limit.toLocaleString("en-US")})` : ""}. The Bot compacts it and tries again; if it still doesn't fit, start a new chat.`,
  proxyDownTitle: "Couldn't start the key proxy",
  proxyDownDetail: "Bots are paused so the API key never reaches them directly. Retry, or restart the Bots' computer.",
} as const;

/**
 * The one mapping from an Anthropic API error (HTTP status + error.type, the documented wire format
 * `{"type":"error","error":{"type":"authentication_error","message":…}}`) to what the app says.
 */
export function classifyAnthropicError(status: number | null, errorType?: string | null, retryAfterSec?: number, message?: string): { kind: AuthProblemKind; title: string; detail: string; retryAfterSec?: number } {
  const t = errorType ?? "";
  // Review round 2 (P5): an organization with web search turned off, said plainly (not "Request refused").
  if (WEB_SEARCH_OFF_RE.test(message ?? "")) return { kind: "web-search-disabled", title: STR_AUTH.webSearchDisabled, detail: STR_AUTH.webSearchDisabledDetail };
  if (status === null) return { kind: "network", title: STR_AUTH.network, detail: STR_AUTH.networkDetail };
  const long = promptTooLong(message);
  if (long) return { kind: "bad-request", title: STR_AUTH.promptTooLong, detail: STR_AUTH.promptTooLongDetail(long.tokens, long.limit) };
  if (status === 401 || t === "authentication_error") return { kind: "invalid-key", title: STR_AUTH.keyRejected, detail: STR_AUTH.keyRejectedDetail };
  if (status === 402 || t === "billing_error" || /credit balance/i.test(message ?? "")) return { kind: "billing", title: STR_AUTH.billing, detail: STR_AUTH.billingDetail };
  if (status === 429 || t === "rate_limit_error") return { kind: "rate-limited", title: STR_AUTH.rateLimited, detail: STR_AUTH.rateLimitedDetail(retryAfterSec), ...(retryAfterSec ? { retryAfterSec } : {}) };
  if (status === 529 || t === "overloaded_error") return { kind: "overloaded", title: STR_AUTH.overloaded, detail: STR_AUTH.overloadedDetail };
  if (status === 403 || t === "permission_error") return { kind: "permission", title: STR_AUTH.permission, detail: STR_AUTH.permissionDetail };
  if (status === 404 || t === "not_found_error") return { kind: "model-unavailable", title: STR_AUTH.modelUnavailable, detail: STR_AUTH.modelUnavailableDetail };
  if (status >= 500) return { kind: "server", title: STR_AUTH.server, detail: STR_AUTH.serverDetail };
  return { kind: "bad-request", title: STR_AUTH.badRequest, detail: message || `Anthropic refused the request (HTTP ${status}).` };
}

type None = Record<string, never>;
declare module "./gateway" {
  interface GatewayCommands {
    getAuth: { args: None; result: AuthView };
    /** `sealed` = base64 crypto_box_seal of the key to AuthView.boxPublicKey; never the plaintext key. */
    setApiKey: { args: { sealed: string }; result: AuthView };
    clearApiKey: { args: None; result: AuthView };
    /** One tiny request to Anthropic with the saved key, or with a not-yet-saved sealed one. */
    testAuthConnection: { args: { sealed?: string }; result: AuthTestResult };
    /** `refresh` re-probes now (free count_tokens calls); otherwise the last answer. */
    getModelAccess: { args: { refresh?: boolean }; result: ModelAccessView };
    /** Bug 281: the API-key check; `refresh` runs it now (one tiny metered message), otherwise the last answer. */
    checkApiKey: { args: { refresh?: boolean }; result: KeyCheckView };
  }
}
