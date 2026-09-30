/**
 * google-setup: the guided "Connect Google" sheet, the "Let a Bot do it" task and the weekly reconnect check.
 *
 * Pure string code (no node imports): the renderer draws the steps from GOOGLE_SETUP_GUIDE, the host writes the
 * Bot's task prompt from it, and the Mac's browser controller uses the URL rules below to refuse the final
 * Google consent click and to word the approval card for each Google Cloud console change.
 */
import { GOOGLE_REDIRECT_URI, GOOGLE_SCOPES } from "./google";

export type GoogleSetupStepId = "project" | "apis" | "consent" | "production" | "client" | "connect";
export interface GoogleSetupCopy { label: string; value: string }
export interface GoogleSetupLink { label: string; path: string }
export interface GoogleSetupStep {
  id: GoogleSetupStepId;
  title: string;
  /** Console pages this step happens on ("Open in browser"). The project is added as ?project= when known. */
  links: GoogleSetupLink[];
  /** Every value the user types into the console, each with its own Copy button. */
  copies: GoogleSetupCopy[];
}

export const GOOGLE_CONSOLE = "https://console.cloud.google.com";
export const GOOGLE_SETUP_APP_NAME = "Synapse";
const API_IDS = ["gmail.googleapis.com", "calendar-json.googleapis.com", "drive.googleapis.com"] as const;
const scopeShort = (s: string) => s.replace("https://www.googleapis.com/auth/", "");

export const GOOGLE_SETUP_GUIDE: readonly GoogleSetupStep[] = [
  { id: "project", title: "Create a project",
    links: [{ label: "Open in browser", path: "/projectcreate" }],
    copies: [{ label: "Project name", value: GOOGLE_SETUP_APP_NAME }] },
  { id: "apis", title: "Enable the Gmail, Calendar and Drive APIs",
    // One page that enables all three, with Google's own project picker when none is chosen.
    links: [{ label: "Open in browser", path: `/flows/enableapi?apiid=${API_IDS.join(",")}` }],
    copies: [] },
  { id: "consent", title: "Consent screen: External, app name, scopes, your email",
    links: [{ label: "Branding", path: "/auth/branding" }, { label: "Scopes", path: "/auth/scopes" }],
    copies: [
      { label: "User type", value: "External" },
      { label: "App name", value: GOOGLE_SETUP_APP_NAME },
      { label: "All scopes", value: GOOGLE_SCOPES.join(",") },
      ...GOOGLE_SCOPES.map((s) => ({ label: scopeShort(s), value: s })),
    ] },
  { id: "production", title: "Publishing status: In production",
    links: [{ label: "Open in browser", path: "/auth/audience" }],
    copies: [] },
  { id: "client", title: "Create the Desktop OAuth client",
    links: [{ label: "Open in browser", path: "/auth/clients/create" }],
    copies: [{ label: "Application type", value: "Desktop app" }, { label: "Name", value: `${GOOGLE_SETUP_APP_NAME} Desktop` }, { label: "Redirect URI", value: GOOGLE_REDIRECT_URI }] },
  { id: "connect", title: "Paste the Client ID and secret, then Connect", links: [], copies: [] },
];

/** The step titles, in order (docs/google-setup.md carries each one). */
export const GOOGLE_SETUP_STEPS: readonly string[] = GOOGLE_SETUP_GUIDE.map((s) => s.title);

/** A Google Cloud project id as the console accepts it (6–30 chars, lower case, starts with a letter). */
export const isGoogleProjectId = (v: string): boolean => /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v);

/** The console page for a step link, pinned to the user's project when they named one (else Google's picker). */
export function googleConsoleUrl(path: string, projectId?: string | null): string {
  const p = (projectId ?? "").trim();
  const base = `${GOOGLE_CONSOLE}${path}`;
  return p && isGoogleProjectId(p) ? `${base}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(p)}` : base;
}

// ---------- The final consent is the user's (enforced on the Mac, in app/src/main/browser/controller.ts) ----------

/** Lower case, and a fully-qualified trailing dot dropped ("accounts.google.com." is the same host). */
const host = (u: string): string => { try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; } };
const pathOf = (u: string): string => { try { return new URL(u).pathname; } catch { return ""; } };

/** Google's OAuth consent (approval) pages: the page whose button grants an app access to the account. */
const CONSENT_PATH = /^(?:\/b\/\d+)?\/(?:signin\/oauth\/(?:v\d+\/)?(?:consent|consentsummary|approval|delegation)|o\/oauth2\/(?:v\d+\/)?(?:approval|consent))(?:\/|$)/i;
/** Google's OAuth and sign-in flow: account chooser, sign-in, the unverified-app warning, consent. */
const OAUTH_FLOW_PATH = /^(?:\/b\/\d+)?\/(?:signin\/oauth|o\/oauth2|v3\/signin)(?:\/|$)/i;
/** The unverified-app warning page ("Google hasn't verified this app"). */
const WARNING_PATH = /^(?:\/b\/\d+)?\/signin\/oauth\/(?:v\d+\/)?warning(?:\/|$)/i;

export const isGoogleAccountsUrl = (u: string): boolean => host(u) === "accounts.google.com";
export const isGoogleOAuthConsentUrl = (u: string): boolean => isGoogleAccountsUrl(u) && CONSENT_PATH.test(pathOf(u));

/**
 * Security fix 4: true when a Bot's page action lands in Google's OAuth or sign-in flow — every click, key, typing
 * or select there. The one exception is following a LINK on the unverified-app warning ("Advanced", "Go to … (unsafe)"),
 * told apart by structure (a link on the warning page), never by its English label. No mode, rule or approval lifts it.
 */
export function blocksGoogleConsent(url: string, el: { action: string; role?: string; tag?: string } = { action: "click" }): boolean {
  if (!isGoogleAccountsUrl(url)) return false;
  const p = pathOf(url);
  if (!OAUTH_FLOW_PATH.test(p)) return false;
  if (WARNING_PATH.test(p) && el.action === "click" && (el.tag === "a" || el.role === "link")) return false;
  return true;
}

/** A Chrome/Safari window showing a Google sign-in or consent page (MacApp's Accessibility path sees only titles). */
export const isGoogleAccountsWindow = (title: string): boolean => /\bGoogle Accounts\b|accounts\.google\.com/i.test(title ?? "");

// ---------- Plain words for each Google Cloud console change (the approval card) ----------

const CONSOLE_HOST = "console.cloud.google.com";
const CHANGE_LABEL = /^\s*(?:create|enable|save|save and continue|next|publish(?: app)?|confirm|push to production|add|update|done|get started|finish)\b/i;
const API_NAMES: Record<string, string> = { gmail: "Gmail API", "calendar-json": "Google Calendar API", drive: "Google Drive API" };

/** The card's words for a click that changes the user's Google Cloud project, or null for anything else. */
export function googleConsoleChange(url: string, label: string): string | null {
  if (host(url) !== CONSOLE_HOST || !CHANGE_LABEL.test(label ?? "")) return null;
  const p = pathOf(url);
  const said = (label ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  const api = /^\/apis\/library\/([a-z-]+)\.googleapis\.com/.exec(p)?.[1];
  if (api) return `Turn on the ${API_NAMES[api] ?? `${api} API`} in your Google Cloud project`;
  if (p.startsWith("/flows/enableapi")) return "Turn on the Gmail, Calendar and Drive APIs in your Google Cloud project";
  if (p.startsWith("/projectcreate")) return "Create a Google Cloud project";
  if (/^\/auth\/(?:branding|overview)|^\/apis\/credentials\/consent/.test(p)) return "Save the consent screen (app name, user type, contact email)";
  if (p.startsWith("/auth/scopes")) return "Save the consent screen's scopes";
  if (p.startsWith("/auth/audience")) return /publish|push|confirm/i.test(said) ? "Set the app's publishing status to In production" : "Change who can use the app (test users or publishing status)";
  if (/^\/auth\/clients|^\/apis\/credentials\/oauthclient/.test(p)) return "Create the Desktop OAuth client";
  return `Change your Google Cloud project: “${said}”`;
}

// ---------- Secrets the setup task captures host-side (never shown to the Bot) ----------

/** The Google Cloud console's OAuth client pages (Clients / Credentials), where a client secret can be on screen. */
export function isGoogleClientPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.toLowerCase().replace(/\.$/, "") === "console.cloud.google.com" && /^\/(?:auth\/clients|apis\/credentials)(?:\/|$)/.test(u.pathname);
  } catch { return false; }
}

/** A Google OAuth client secret. */
export const GOOGLE_CLIENT_SECRET_RE = /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;
/** A Google OAuth client ID. */
export const GOOGLE_CLIENT_ID_RE = /(?<![A-Za-z0-9-])\d{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com/g;
export const GOOGLE_SECRET_PLACEHOLDER = "[secret:GOOGLE_CLIENT_SECRET]";
/** Page text with any Google client secret or client ID replaced (the Mac's own comparisons run on this). */
export const scrubGoogleClientValues = (text: string): string =>
  text.replace(GOOGLE_CLIENT_SECRET_RE, GOOGLE_SECRET_PLACEHOLDER).replace(GOOGLE_CLIENT_ID_RE, "[google-client-id]");
/** Text that is, or starts, a client secret or a client ID: never accepted as something to look for on a page. */
export const probesGoogleClient = (text: string): boolean => /GOCSPX|apps\.googleusercontent|\d{6,}-[a-z0-9]/i.test(text ?? "");
export const GOOGLE_CLIENT_ID_PLACEHOLDER = "[google-client-id]";

// ---------- The setup task ----------

export type GoogleSetupMode = "setup" | "reconnect";
export interface GoogleSetupTaskView {
  botId: string;
  botName: string;
  mode: GoogleSetupMode;
  startedAt: number;
  /** The client the Bot read off the page is saved (the secret never reached the Bot). */
  clientSaved: boolean;
}

/** The weekly reconnect check (Settings → Connected accounts). */
export interface GoogleReconnectCheckView {
  enabled: boolean;
  /** Whether the user chose, or it follows the default (on only while the app is in Testing). */
  explicit: boolean;
  /** Google marks a Testing app's refresh token as expiring (refresh_token_expires_in); null before a sign-in. */
  testing: boolean | null;
  lastRunAt: number | null;
}

export const STRGS = {
  setUp: "Set up",
  sheetTitle: "Connect Google",
  doItYourself: "Do it yourself",
  letABot: "Let a Bot do it",
  letABotClick: "Let a Bot click through",
  openInBrowser: "Open in browser",
  projectId: "Project ID",
  done: "Done",
  bot: "Bot",
  start: "Start",
  cancel: "Stop",
  working: (bot: string) => `${bot} is working in your browser`,
  clientSaved: "Client saved",
  clickAllow: "Click Allow in your browser",
  openChat: "Open chat",
  noBots: "Create a Bot first",
  browserOff: (bot: string) => `Turn on the browser for ${bot}`,
  unverifiedNote: "Google will say it hasn't verified this app. Choose Continue: it's your own app.",
  reconnectCheck: "Weekly Google sign-in check (on by default only while your app is in Testing)",
  // Tool and refusal text (the Bot reads these)
  typeRefused: "Refused: a Bot never types a Google client ID or client secret. The client is read off the console's own dialog by Synapse.",
  waitRefused: "Refused: wait text can't look like a Google client secret or client ID. Wait for other text on the page.",
  consentBlocked: "Refused: a Bot never approves a Google sign-in consent. The user clicks Allow (or Continue) on this page in their browser themselves. Tell them: \"Click Allow in your browser.\" Then wait.",
  consoleCard: (what: string) => `${what}. This changes your Google Cloud project, so it needs your OK.`,
  noScreenshots: "Screenshots are off on Google Cloud's OAuth client pages, and everywhere during Google setup: they can show a client secret. Use snapshot.",
  saveTool: "Save the Google OAuth client (Client ID and Client secret) that is on the page to Synapse. Takes no values: Synapse reads them from the page you last read, and they never reach you. Call it right after the \"OAuth client created\" dialog (or the client's page) is on screen.",
  multiClient: "More than one client on this page. Open the new client's own page.",
  saveNoClient: "No Client ID and secret were on the pages you read. Open the client (Clients → your Desktop client), make sure the ID and secret show, take a snapshot, then call SaveGoogleClient again.",
  saveDone: "Saved the Google client to Synapse. Your part is done: tell the user to click Connect in the Connect Google sheet, then Allow in their browser. Don't open the consent page yourself.",
  saveNotTask: "SaveGoogleClient is only available during the Google setup task the user started.",
};

/** The guided task's opening message to the Bot (shown in the chat as the user's request). */
export function googleSetupTaskPrompt(mode: GoogleSetupMode, o: { projectId?: string | null } = {}): string {
  const url = (p: string) => googleConsoleUrl(p, o.projectId);
  if (mode === "reconnect") {
    return [
      "Help me reconnect Google. Use the Browser tool on my Mac.",
      "1. I'll click Connect in Synapse, which opens Google's sign-in in my browser. If it opens in your window and shows \"Google hasn't verified this app\", follow its link to continue (it's my own app). I choose the account myself.",
      "2. Everything else on Google's sign-in pages is mine: choosing the account, signing in and Allow. Synapse refuses your clicks there, so tell me what the page asks and wait.",
      "Rules: never type a password. If a Google sign-in page asks for a password or a code, stop and ask me to sign in.",
    ].join("\n");
  }
  const s = GOOGLE_SETUP_GUIDE;
  return [
    "Set up my own Google OAuth client for Synapse in the Google Cloud console. Use the Browser tool on my Mac (I'm signed in to Google there). Do these steps in order and tell me briefly after each:",
    `1. ${s[0]!.title} named "${GOOGLE_SETUP_APP_NAME}": ${url("/projectcreate")} (or use one I already have, if I say so).`,
    `2. ${s[1]!.title}: ${url(s[1]!.links[0]!.path)}`,
    `3. Consent screen: ${url("/auth/branding")}. User type External, app name "${GOOGLE_SETUP_APP_NAME}", my email as the support and developer contact. Then add exactly these scopes at ${url("/auth/scopes")} (Add or remove scopes → Manually add): ${GOOGLE_SCOPES.join(", ")}`,
    `4. Publishing status → In production: ${url("/auth/audience")} → Publish app → Confirm. (This avoids a sign-in every 7 days.)`,
    `5. Create an OAuth client, type "Desktop app", name "${GOOGLE_SETUP_APP_NAME} Desktop": ${url("/auth/clients/create")}. When the dialog shows the Client ID and secret, call SaveGoogleClient. Don't copy them into the chat; you won't see them.`,
    "Rules: never type a password. If a Google sign-in page appears, stop and ask me to sign in. Never click Allow on a Google consent page; I do that.",
  ].join("\n");
}
