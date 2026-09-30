/**
 * Wave 3 (battle plan 3.3): Bots that run on a vendor's own coding CLI, signed in with the user's own subscription,
 * driven over the Agent Client Protocol (ACP, protocol version 1; schema from the official TypeScript SDK 1.5.1,
 * checked 2026-09-30). A Bot on one has the model "acp:<vendor>".
 *
 * Only vendors the subscription-terms research (2026-09-29) marks allowed or tolerated are listed. Every entry stays
 * Experimental until a live check with a real login passes. The vendor CLI keeps its own login in the Bot's own home;
 * Synapse never reads or stores its token.
 *
 * The box runs a vendor CLI only through the root helper box/files/bot-acp-as-box, which holds the same command table
 * (a test keeps the two equal), so the host can't make it run anything else.
 */
export const ACP_VENDOR_IDS = ["copilot", "cursor", "kimi", "vibe"] as const;
export type AcpVendorId = (typeof ACP_VENDOR_IDS)[number];
export type AcpModelRef = `acp:${AcpVendorId}`;

/** How the vendor documents its sign-in. "device": prints a link and a code; "browser": prints or opens a link;
 *  "terminal": an interactive setup the user completes in the Bot's terminal. */
export type AcpLoginFlow = "device" | "browser" | "terminal";

export interface AcpVendor {
  id: AcpVendorId;
  label: string;
  /** From research/market-2026-09-29/subscription-terms.md. */
  terms: "allowed" | "tolerated";
  /** Experimental until a live check with a real login. */
  status: "experimental";
  /** The executable's name; on the box it lives at ACP_VENDOR_ROOT/<vendor>/<bin>. */
  bin: string;
  /** Arguments that start the CLI as an ACP agent on stdio. */
  acpArgs: readonly string[];
  /** The vendor's documented sign-in command (same executable unless loginBin is set). */
  loginBin?: string;
  loginArgs: readonly string[];
  loginFlow: AcpLoginFlow;
  /** A sign-in link is shown only on these hosts (or their subdomains): the CLI's output can't send the user elsewhere. */
  loginHosts: readonly string[];
  /** Where the CLI keeps its login, relative to the Bot's home. Synapse never opens these. */
  credentialPaths: readonly string[];
  /** Where the vendor documents ACP and sign-in. */
  docs: string;
}

export const ACP_VENDORS: Record<AcpVendorId, AcpVendor> = {
  copilot: {
    id: "copilot", label: "GitHub Copilot", terms: "allowed", status: "experimental",
    bin: "copilot", acpArgs: ["--acp", "--stdio"],
    loginArgs: ["login", "--device-code"], loginFlow: "device", loginHosts: ["github.com"],
    credentialPaths: [".copilot"],
    docs: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
  },
  cursor: {
    id: "cursor", label: "Cursor", terms: "allowed", status: "experimental",
    bin: "agent", acpArgs: ["acp"],
    loginArgs: ["login"], loginFlow: "browser", loginHosts: ["cursor.com", "cursor.sh"],
    credentialPaths: [".cursor", ".config/cursor"],
    docs: "https://cursor.com/docs/cli/acp",
  },
  kimi: {
    id: "kimi", label: "Kimi Code", terms: "allowed", status: "experimental",
    bin: "kimi", acpArgs: ["acp"],
    loginArgs: ["login"], loginFlow: "device", loginHosts: ["kimi.com", "moonshot.cn", "moonshot.ai"],
    credentialPaths: [".kimi-code"],
    docs: "https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html",
  },
  vibe: {
    id: "vibe", label: "Mistral Vibe", terms: "tolerated", status: "experimental",
    bin: "vibe-acp", acpArgs: [],
    loginBin: "vibe", loginArgs: ["--setup"], loginFlow: "terminal", loginHosts: ["mistral.ai"],
    credentialPaths: [".vibe"],
    docs: "https://docs.mistral.ai/vibe/code/cli/install-setup",
  },
};

/**
 * 0.1.6: what Settings → Account → Coding CLIs → Install puts on the box: the vendor's official npm package at a
 * pinned version. Every package it pulls in is pinned by the sha512 npm publishes for it (`dist.integrity`), in
 * box/files/acp-pins/<vendor>/package-lock.json; the root helper box/files/bot-acp-install holds the same table (a test
 * keeps the three equal). null: the vendor publishes no npm package with an integrity value (Cursor ships a bare
 * download, Mistral Vibe a Python package), so there is nothing verified to install from here.
 */
export const ACP_INSTALL_PINS: Record<AcpVendorId, { package: string; version: string } | null> = {
  copilot: { package: "@github/copilot", version: "1.0.89" },
  cursor: null,
  kimi: { package: "@moonshot-ai/kimi-code", version: "2.1.1" },
  vibe: null,
};

/** Where the box keeps the vendor CLIs (root-owned; one folder per vendor). */
export const ACP_VENDOR_ROOT = "/usr/local/lib/synapse-acp";
/** The ACP protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

export function isAcpVendorId(x: unknown): x is AcpVendorId {
  return typeof x === "string" && (ACP_VENDOR_IDS as readonly string[]).includes(x);
}
export function isAcpModelRef(x: unknown): x is AcpModelRef {
  return typeof x === "string" && x.startsWith("acp:") && isAcpVendorId(x.slice(4));
}
export function parseAcpModelRef(x: unknown): AcpVendorId | null {
  return isAcpModelRef(x) ? (x.slice(4) as AcpVendorId) : null;
}
export function acpVendorLabel(v: AcpVendorId): string {
  return ACP_VENDORS[v].label;
}

/** The first https link in `text` on one of the vendor's own hosts (or a subdomain); anything else is never shown or opened. */
export function acpVendorLink(text: string, hosts: readonly string[]): string | null {
  for (const m of text.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) {
    let u: URL;
    try { u = new URL(m[0]); } catch { continue; }
    const h = u.hostname.toLowerCase();
    if (u.protocol === "https:" && !u.username && !u.password && hosts.some((x) => h === x || h.endsWith(`.${x}`))) return u.toString();
  }
  return null;
}

/**
 * Whether a call's text names a vendor CLI's own folder in the Bot's home (its login and its settings). The ACP client
 * denies such a call before the gate: the agent must not read its token out through Synapse, nor rewrite its own
 * settings to stop asking (an "allow all" config).
 */
export function acpTouchesVendorDir(text: string, home: string | null): boolean {
  const dirs = Object.values(ACP_VENDORS).flatMap((v) => v.credentialPaths);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const roots = ["~", "\\$HOME", "\\$\\{HOME\\}", ...(home ? [esc(home.replace(/\/+$/, ""))] : [])].join("|");
  return new RegExp(`(?:${roots})/+(?:${dirs.map(esc).join("|")})(?:/|$|[\\s"'])`).test(text);
}

/** One consent per vendor, the same store and version rule as the model providers (spec §4). */
export const ACP_CONSENT_VERSION = 1;
export function acpConsentText(v: AcpVendorId): string {
  const name = acpVendorLabel(v);
  return `Bots on ${name} send ${name} their conversation, the files they read and the results of the commands they run. ${name} runs on your own ${name} sign-in; Synapse never sees that sign-in. ${name}'s own terms and privacy policy apply.`;
}

export const STR_ACP = {
  groupLabel: "Coding CLIs",
  sectionTitle: "Coding CLIs",
  signIn: (v: AcpVendorId) => `Sign in with ${acpVendorLabel(v)}`,
  signedIn: "Signed in",
  notSignedIn: "Not signed in",
  checking: "Checking…",
  check: "Check",
  experimental: "Experimental",
  planNote: (v: AcpVendorId) => `Included in your ${acpVendorLabel(v)} plan`,
  openLink: "Open link",
  codeLabel: "Code",
  terminalStep: (cmd: string) => `Open the Bot's terminal and run ${cmd}`,
  needsSignInTitle: "Sign in needed",
  needsSignIn: (v: AcpVendorId) => `${acpVendorLabel(v)} isn't signed in for this Bot. Sign in with ${acpVendorLabel(v)} in the Bot's settings.`,
  noConsentTitle: "Not allowed yet",
  noConsent: (v: AcpVendorId) => `${acpVendorLabel(v)} hasn't been allowed yet. Allow it in Settings → Account.`,
  stoppedTitle: "Bot failed to respond",
  stopped: (v: AcpVendorId) => `${acpVendorLabel(v)} stopped unexpectedly.`,
  notInstalled: (v: AcpVendorId) => `${acpVendorLabel(v)} isn't installed on the computer yet. Install it in Settings → Account → Coding CLIs.`,
  install: "Install",
  remove: "Remove",
  installed: (version: string | null) => (version ? `Installed · ${version}` : "Installed"),
  installing: "Installing…",
  removing: "Removing…",
  notInstalledShort: "Not installed",
  noVerifiedPackage: "Can't be installed from here yet",
  installTitle: (v: AcpVendorId, version: string) => `Install ${acpVendorLabel(v)} ${version}?`,
  installText: (v: AcpVendorId, pkg: string, version: string) =>
    `Synapse downloads ${pkg} ${version} from npm, checks every file against the checksum npm publishes for it, and installs it on the Bots' computer. Each Bot then signs in with its own ${acpVendorLabel(v)} account.`,
  installFailed: (v: AcpVendorId) => `${acpVendorLabel(v)} couldn't be installed.`,
  accountsTitle: "Needs per-Bot accounts",
  accounts: "Coding CLIs run as each Bot's own account on the computer, and this computer doesn't use per-Bot accounts yet. New computers have them from the start. To move this one over, run box/migrate-per-bot-uid.sh --apply from the Synapse source folder in Terminal, then open Settings again.",
  offBox: "Coding CLIs are installed only on the Bots' computer.",
  refusedTitle: "The provider refused",
  refused: (v: AcpVendorId) => `${acpVendorLabel(v)} refused this request.`,
  badProtocol: (v: AcpVendorId) => `${acpVendorLabel(v)} speaks a version of the protocol Synapse doesn't support.`,
} as const;

export interface AcpVendorView {
  id: AcpVendorId;
  label: string;
  status: "experimental";
  consented: boolean;
  consentText: string;
  consentVersion: number;
  planNote: string;
  loginFlow: AcpLoginFlow;
  /** 0.1.6: the Install / Remove state; absent from an older host. */
  install?: AcpInstallView;
}
export interface AcpVendorsView {
  vendors: AcpVendorView[];
  /** 0.1.6: true while the computer doesn't run per-Bot accounts, so nothing can be installed or run yet. */
  accountsNeeded?: boolean;
}
export type AcpInstallState = "not-installed" | "installing" | "installed" | "removing" | "unavailable";
/** 0.1.6: a vendor CLI on the Bots' computer. `pinned` is the version Install puts there (null: no verified package). */
export interface AcpInstallView { state: AcpInstallState; version: string | null; pinned: string | null; package: string | null; error: string | null }
/** A started sign-in: a vendor link (and code) to open, or a command for the Bot's terminal. */
export type AcpLoginStart =
  | { kind: "link"; url: string; code: string | null }
  | { kind: "terminal"; command: string }
  | { kind: "failed"; detail: string };

type None = Record<string, never>;
declare module "./gateway" {
  interface GatewayCommands {
    getAcpVendors: { args: None; result: AcpVendorsView };
    consentAcpVendor: { args: { vendor: AcpVendorId; textVersion: number }; result: AcpVendorsView };
    /** Starts the vendor's own sign-in as the Bot; the token stays in the Bot's home. */
    startAcpLogin: { args: { id: string; vendor: AcpVendorId }; result: AcpLoginStart };
    /** Asks the vendor CLI (as the Bot) whether it can open a session. */
    checkAcpLogin: { args: { id: string; vendor: AcpVendorId }; result: { signedIn: boolean; detail: string } };
    /** 0.1.6, owner only: installs the pinned, checksum-verified vendor CLI on the Bots' computer (runs in the background). */
    installAcpVendor: { args: { vendor: AcpVendorId }; result: AcpVendorsView };
    /** 0.1.6, owner only: removes it. */
    removeAcpVendor: { args: { vendor: AcpVendorId }; result: AcpVendorsView };
  }
}
