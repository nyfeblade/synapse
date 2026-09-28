// The memory screen (MEM-09).
// A Bot's memory is plain markdown on the host (MEM-01/02); every read and write here goes through the
// host, so those files stay the source of truth.

/** Which memory a list shows. `user` is "about you": every Bot's shard, since every Bot reads all of them (MEM-02). */
export type MemoryScopeRef = { kind: "agent" } | { kind: "user" } | { kind: "team" } | { kind: "project"; slug: string };

/** Where a fact came from (memory provenance). "migrated" = written before the ledger existed; provenance unknown. */
export type MemorySourceType = "user" | "email" | "doc" | "web" | "inferred" | "migrated";

export interface MemoryProvenanceView {
  /** The Bot that learned it; null when the user wrote or corrected it on this screen. */
  botId: string | null;
  botName: string | null;
  /** When it was recorded (epoch ms). */
  recordedAt: number;
  source: MemorySourceType;
  /** 0–1. A correction is 1. */
  confidence: number;
  /** The chat message it came from, when known: open with jumpTo(chatBotId, messageId). */
  chatBotId: string | null;
  messageId: string | null;
}

/** An earlier value this fact replaced, newest first. */
export interface MemoryHistoryView {
  /** null when the old line looks like a secret. */
  content: string | null;
  /** When it was true: from the day it was learned until it was replaced (epoch ms). */
  validFrom: number;
  validTo: number | null;
  source: MemorySourceType;
  botName: string | null;
}

/** The three tiers a person can tell apart: always known (profile), the dated log, and short-lived notes. */
export type MemoryTierChoice = "profile" | "log" | "note";

export interface MemoryFactView {
  id: string;
  /** YYYY-MM-DD, the day it was learned. */
  date: string;
  tier: "profile" | "log";
  kind: "fact" | "note" | "episode";
  /** null when the line looks like a secret: its text never leaves the host (ORIG-12). */
  content: string | null;
  /** User scope only: the Bot whose shard holds the line, and its name ("a deleted Bot" once it is gone). */
  owner?: string;
  ownerName?: string;
  /** From the host's fact ledger; absent only for a line the ledger hasn't imported yet. */
  provenance?: MemoryProvenanceView;
  /** What it replaced, newest first (empty when it never changed). */
  history?: MemoryHistoryView[];
}

export interface MemoryListView {
  facts: MemoryFactView[];
  /** The projects this Bot has joined, each a list of its own. */
  projects: string[];
}

/**
 * The history archive's storage readout for one Bot (designed). `bytes` is this Bot's
 * share of the archive file, apportioned by its text; `fileBytes` is the whole shared file.
 */
export interface HistoryArchiveStatsView {
  rows: number;
  bytes: number;
  fileBytes: number;
  oldestAt: number | null;
  newestAt: number | null;
}

export const STRM = {
  memory: "Memory",
  memoryRowHint: "See and edit what this Bot remembers",
  openMemory: "Open",
  openMemoryLabel: "Open memory",
  backToSettings: "Back to settings",
  closeDetails: "Close details",
  scopeAgent: "This Bot",
  scopeAgentHint: "Only this Bot sees these.",
  scopeUser: "About you",
  scopeUserHint: "Shared by all your Bots.",
  scopeTeam: "Team",
  scopeTeamHint: "What your Bots know about the team's work. Shared by all of them.",
  clearAskTeam: "Delete everything your Bots know about the team? Every Bot loses it. This can't be undone.",
  learnedFrom: (name: string) => `learned from ${name}`,
  learnedFromYou: "from you",
  source: { user: "said in chat", email: "from an email", doc: "from a document", web: "from the web", inferred: "noted by the Bot", migrated: "earlier memory" } as Record<MemorySourceType, string>,
  sourceCorrected: "your correction",
  openSource: "Open message",
  openSourceLabel: (name: string) => `Open the message ${name} learned this from`,
  history: (n: number) => (n === 1 ? "Changed once" : `Changed ${n} times`),
  historyLine: (from: string, to: string) => `${from} – ${to}`,
  projects: "Projects",
  noProjects: "Not in any project.",
  project: (slug: string) => `Project: ${slug}`,
  tierProfile: "Always known",
  tierLog: "Log",
  tierNote: "Notes",
  tierProfileHint: "In every conversation.",
  tierLogHint: "Dated; recent ones are in view, older ones are searched.",
  tierNoteHint: "Short-lived; fades fastest.",
  empty: "Nothing remembered yet.",
  hiddenSecret: "Hidden — this line looks like a secret.",
  via: (name: string) => `via ${name}`,
  // Memory provenance: an edit is a correction (a user-sourced fact that supersedes the old one, kept as history);
  // delete forgets the fact and its history.
  edit: "Correct this",
  delete: "Forget",
  save: "Save",
  cancel: "Cancel",
  add: "Add",
  rememberPlaceholder: "Remember that…",
  tierLabel: "Keep as",
  clear: "Clear",
  clearConfirm: "Clear all",
  clearAsk: (what: string) => `Delete everything in ${what}? This can't be undone.`,
  clearAskUser: "Delete everything your Bots know about you? Every Bot loses it. This can't be undone.",
  freezeNote: (name: string) => `Changes reach ${name} at its next context refresh. Until then it works from the memory it loaded.`,
  refreshNow: "Refresh now",
  refreshHint: "Compacts this conversation so the Bot reloads its memory now. Older messages are summarized.",
  refreshScheduled: "Refreshing. The Bot reloads its memory when the compaction finishes.",
  refreshUnavailable: "Can't refresh right now. The Bot picks up changes at its next context refresh.",
  editLabel: "Correct this memory",
  addLabel: (what: string) => `Remember in ${what}`,
} as const;
