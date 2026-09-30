import type { ModelId } from "./models";
import type { ProviderModelRef } from "./providers";
import type { AcpModelRef } from "./acp-vendors";
import type { HistoryKeep } from "./history-budget";
import type { PermMode } from "./perm-rules";
import type { ComputerPerception } from "./computer";
import type { AvatarClip } from "./avatar-anim";

export const AVATAR_SHAPES = [
  "pebble", "orb", "tile", "pill", "dome", "gem", "puff", "bead",
  "hex", "diamond", "shield", "crescent", "petal", "stadium", "notch", "wave",
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];
/** What each form draws is app/src/renderer/avatar/face-forms.ts. */
export const AVATAR_SHAPE_LABELS: Record<AvatarShape, string> = {
  pebble: "Pebble", orb: "Orb", tile: "Tile", pill: "Pill",
  dome: "Dome", gem: "Gem", puff: "Puff", bead: "Bead",
  hex: "Hex", diamond: "Diamond", shield: "Shield", crescent: "Crescent",
  petal: "Petal", stadium: "Stadium", notch: "Notch", wave: "Wave",
};
/** The six Synapse forms the avatar editor offers ("Nodes"), the pebble
 *  first. The other ten ids stay valid so saved Bots keep loading; each draws the nearest form
 *  (app/src/renderer/avatar/face-forms.ts, FORM_OF). */
export const AVATAR_EDITOR_SHAPES = AVATAR_SHAPES.slice(0, 6) as readonly AvatarShape[];
/** A new Bot's body: the pebble. */
export const DEFAULT_AVATAR_SHAPE: AvatarShape = "pebble";
/** Bug 292: shape ids saved before the rename (a profile, a group, a botpack, a tool call) and the Synapse id each became. */
const LEGACY_AVATAR_SHAPES: Readonly<Record<string, AvatarShape>> = {
  circle: "pebble", blob: "orb", "rounded-square": "tile", capsule: "pill",
  triangle: "dome", octagon: "gem", cloud: "puff", droplet: "bead",
};
/** A stored or requested shape id as a current one (an old id maps to its Synapse form), or null when it is none. */
export function normalizeAvatarShape(s: unknown): AvatarShape | null {
  if (typeof s !== "string") return null;
  if ((AVATAR_SHAPES as readonly string[]).includes(s)) return s as AvatarShape;
  return LEGACY_AVATAR_SHAPES[s] ?? null;
}
export const AVATAR_COLORS = ["#ffffff", "#777777", "#83603e", "#d23f40", "#ec7431", "#f0a13b", "#46995f", "#4ba495", "#3674d8", "#7b53d7", "#d04088"] as const;
export const AVATAR_COLOR_NAMES = ["White", "Gray", "Brown", "Red", "Orange", "Amber", "Green", "Teal", "Blue", "Purple", "Pink"] as const;
/** The colour a new Bot starts with in onboarding. */
export const DEFAULT_AVATAR_COLOR: string = AVATAR_COLORS[8];
/** Bug 292: colours saved before the palette was rebuilt, each mapped to the colour of the same name. */
const LEGACY_AVATAR_COLORS: Readonly<Record<string, string>> = {
  "#7f5e3c": "#83603e", "#ce383d": "#d23f40", "#ed712e": "#ec7431", "#f19d38": "#f0a13b", "#43975d": "#46995f",
  "#49a393": "#4ba495", "#3472d9": "#3674d8", "#7951d8": "#7b53d7", "#ce3d86": "#d04088",
};
/** A stored or requested colour as a current palette colour (lower case; an old one maps by name), or null. */
export function normalizeAvatarColor(c: unknown): string | null {
  if (typeof c !== "string") return null;
  const l = c.toLowerCase();
  if ((AVATAR_COLORS as readonly string[]).includes(l)) return l;
  return LEGACY_AVATAR_COLORS[l] ?? null;
}
export const AVATAR_MATERIALS = ["matte", "glass", "grain", "glow"] as const;
export type AvatarMaterial = (typeof AVATAR_MATERIALS)[number];
export const AVATAR_MATERIAL_LABELS: Record<AvatarMaterial, string> = {
  matte: "Matte", glass: "Glass", grain: "Grain", glow: "Glow",
};
export const AVATAR_MOTIONS = ["calm", "curious", "kinetic", "stoic"] as const;
export type AvatarMotion = (typeof AVATAR_MOTIONS)[number];
export const AVATAR_MOTION_LABELS: Record<AvatarMotion, string> = {
  calm: "Calm", curious: "Curious", kinetic: "Kinetic", stoic: "Stoic",
};

export interface BotProfile {
  name: string;
  title: string;
  description: string;
  avatarShape: AvatarShape;
  avatarColor: string;
  avatarKind: "shape" | "image";   // BOT-18: "image" = avatar.(png|jpg|webp|gif|svg) in the Bot folder
  avatarVersion?: number;          // bumps on every avatar change so the renderer refetches
  avatarMaterial?: AvatarMaterial; // kept so saved Bots load; no longer offered or drawn (one flat look)
  avatarMotion?: AvatarMotion;     // kept so saved Bots load; no longer offered or drawn (one measured motion)
  effort?: EffortLevel;            // absent = high (the SDK default)
  /** A Claude model, or a provider model "<provider>:<id>" (spec 2026-09-29 §5). */
  model?: ModelId | ProviderModelRef | AcpModelRef;
  /**
   * Which loop runs a Bot on a Claude model (2026-09-30, "no feature may require Claude Code"): "synapse" is Synapse's
   * own loop (ProviderBrain on Anthropic's Messages API), "claude-code" the Claude Agent SDK / Claude Code CLI. Absent =
   * "claude-code": a Bot made before the switch keeps its engine until the owner changes it. Ignored for other models.
   */
  engine?: BotEngine;
  /** Bot-authored avatar animations (shared/src/avatar-anim.ts), validated by the host before storing. */
  avatarAnimations?: AvatarClip[];
  /** A request to play one stored clip once: avatars play it when `seq` rises past the one they mounted with. */
  avatarCue?: { name: string; seq: number };
  /** 0.1.7: the saved key that pays for this Bot's calls, per provider (a key id); absent = the provider's default key. */
  modelKeys?: Partial<Record<import("./key-ring").KeyedProvider, string>>;
}

export const BOT_ENGINES = ["synapse", "claude-code"] as const;
export type BotEngine = (typeof BOT_ENGINES)[number];
export const BOT_ENGINE_LABELS: Record<BotEngine, string> = { synapse: "Synapse (Experimental)", "claude-code": "Claude Code" };
export function isBotEngine(x: unknown): x is BotEngine {
  return typeof x === "string" && (BOT_ENGINES as readonly string[]).includes(x);
}
/** The engine a Bot made before the engine setting existed runs on (it keeps it until the owner switches). */
export const LEGACY_BOT_ENGINE: BotEngine = "claude-code";
/**
 * The engine a NEW Bot on a Claude model gets. The offline parity gates pass (ruling 89), but it stays "claude-code"
 * until the live smoke test (`npm run smoke:claude-live`, ruling 91) passes against the real API: one wrong request
 * field would break every turn. "Synapse" is selectable, labelled Experimental, meanwhile.
 */
export const NEW_BOT_ENGINE: BotEngine = "claude-code";
export function botEngineOf(p: { engine?: BotEngine } | undefined): BotEngine {
  return p?.engine ?? LEGACY_BOT_ENGINE;
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: EffortLevel = "high";
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};
export function isEffortLevel(x: unknown): x is EffortLevel {
  return typeof x === "string" && (EFFORT_LEVELS as readonly string[]).includes(x);
}

export interface BotSettings {
  notifyOnAgentUpdates: boolean;
  hiddenFromSidebar: boolean;
  voice?: string | null;           // BOT-24; null/absent = "Not set"
  speechRate?: number;             // SPEECH_RATES; absent = 1
  spokenLanguage?: string | null;  // BCP-47; null/absent = Auto-detect
  archived?: boolean;              // ORIG-17 ArchiveAgent
  /** ORIG-11; historyKeep: token diet (2), absent = standard. (A Claude Bot's coding agents follow its Engine.) */
  advanced?: { followups?: boolean; historyKeep?: HistoryKeep };
  google?: boolean;                // ORIG-GOOGLE: built-in Google tools for this Bot (default off)
  engineeringMode?: boolean;       // ON = Claude Code preset + Bot prompt + ENGINEERING MODE section; OFF = standalone. Takes effect next turn
  engineeringModeSince?: number;   // epoch ms the user last turned it on (the Bot is told when)
  engineeringOffered?: boolean;    // WHETHER the one-shot suggestion already fired (silenced on decline; reset on→off)
  /** feat-mac-access-parity: the Bot's permission MODE, borrowed from Claude Code (default "ask").
   *  ask = edits/commands ask the first time and always-allow rules apply; accept-edits = file edits in project
   *  dirs don't ask; full-auto = nothing asks except ALWAYS ASK / NEVER (like CLI --dangerously-skip-permissions).
   *  ALWAYS ASK and NEVER fixed rules hold in every mode. */
  permMode?: PermMode;
  /** Bug 258: "No limits", on top of Full auto (opt-in, confirmed in the app; any mode change clears it). The Mac keeps
   *  its own signed record and never takes this from the host. */
  noLimits?: boolean;
  /** cost-diet-2 lever 1: this Bot's "Save usage" (simple messages on a faster model); absent = the account's setting. */
  saveUsage?: boolean;
  /** "Computer perception" for this Bot's computerUse subagents; absent = the account's setting (default Screenshots). */
  computerPerception?: ComputerPerception;
  /** Voice wave 3: this Bot may call the user (a ring). Absent/null = never asked: its first call asks. */
  mayCall?: boolean | null;
  /** 4.3 Email in: the owner can forward mail to this Bot (default off). */
  emailIn?: boolean;
  /** 4.3: the plus-address tag (`<owner>+<tag>@…`), set when Email in is first turned on and kept on rename. */
  emailInTag?: string;
}

/**
 * The system-prompt measurement the Engineering switch's cost is derived from (decisions.md 2026-09-20,
 * the CLI's own /context accounting on one real Bot): preset 6,022 vs standalone 3,552 tokens, so the
 * preset is 2,470 tokens longer; our own prompt text runs 4.0 chars per token (9,440 chars -> 2,360).
 */
export const PROMPT_MEASURED = { presetOverStandaloneTokens: 2_470, charsPerToken: 4.0 } as const;
/** Extra system-prompt tokens per model call with Engineering mode on, to the nearest 100.
 *  host/test/perf/prompt-budget.test.ts recomputes it from PROMPT_MEASURED and the real prompts. */
export const ENGINEERING_MODE_EXTRA_TOKENS = 2_700;

export type Presence = "idle" | "thinking" | "working" | "sending" | "searching" | "loading" | "orbit";
export interface Activity { thinking?: true; tool?: string; detail?: string }
export type SidebarMarker = "blocked" | "unread" | "working" | null;
export interface AwaitingUser {
  tabId: "auto-review" | "widget" | "secret" | "box"; reason: string; since: number;
  /** Smarter approvals: the pending card this is (auto-review only), so a notification can answer it. */
  approvalId?: string;
}

export interface BotSummary {
  id: string;
  profile: BotProfile;
  settings: BotSettings;
  presence: Presence;
  activity: Activity | null;
  marker: SidebarMarker;
  statusLine: string;
  running: boolean;
  awaiting: AwaitingUser | null;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms of the Bot's newest SendMessage (NTF-01 "turn finished with a new last message"); 0 if none. */
  lastBotMessageAt: number;
  /** The newest message came from a scheduled or triggered run that did not ask to notify. */
  lastBotMessageQuiet?: boolean;
  group?: { memberIds: string[] } | null; // GRP-01: set for group chats
  archived?: boolean;
  /** settings-persist: this Bot's publish sequence on this host run (monotonic, never wall-clock) … */
  rev?: number;
  /** … and that run's id: a different epoch (host restart) means the counters aren't comparable. */
  epoch?: string;
}
