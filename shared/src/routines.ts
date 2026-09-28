/** RTN-01, RTN-10, RTN-17, ORIG-04, §4.3. */
export const GITHUB_EVENT_KINDS = [
  "prOpened", "prPushed", "prMerged", "prClosed", "prCommented", "reviewRequested", "reviewApproved",
  "reviewChangesRequested", "reviewCommented", "reviewComment", "threadResolved", "threadUnresolved", "issueAssigned", "ciCompleted",
] as const;
export type GithubEventKind = (typeof GITHUB_EVENT_KINDS)[number];
export type SlackMatch = "mention" | "message" | { keyword: string } | { reaction: { emoji?: string[]; bySelf?: boolean } };
export type FileEventKind = "created" | "modified" | "deleted";

export type Trigger =
  | { cron: { schedule: string } }
  | { slack: { channel: string; match: SlackMatch } }
  | { github: { repo: string; events: GithubEventKind[]; userAllowlist?: string[]; ciBranch?: string } }
  | { linear: { event: "issueCreated" | "statusChanged" | "endOfCycle"; projectIds?: string[]; teamIds?: string[] } }
  | { sentry: { event: string; projectIds?: string[] } }
  | { pagerduty: { event: string; serviceIds?: string[] } }
  | { microsoftTeams: Record<string, unknown> }
  | { webhook: Record<string, never> }
  | { file: { paths: string[]; events: FileEventKind[]; ignore?: string[] } }
  | { email: { account: string; query: string; folder?: string } }
  /** A calendar event starts in `minutesBefore` minutes (the built-in Google connector). `match`: words in the title, all required. */
  | { calendar: { minutesBefore: number; calendarId?: string; match?: string } }
  | { group: { listeners: Trigger[] } };

export interface WebhookFields { routineUuid: string; keyHash: string; keyPreview: string }

export interface RoutineDef {
  name: string;
  prompt: string;
  schedule?: string;          // cron, alias, @every, RRULE:… or CRON_TZ=… prefix (ORIG-03); stored normalized
  trigger?: Trigger;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  raisedNotices?: string[];
  webhook?: WebhookFields;
  /** "22:00-07:00" in the account zone: scheduled runs never fall inside it. */
  quietHours?: string;
  /** A slot missed while the Mac or box slept runs once on wake (with a "caught up" note) instead of being skipped. */
  catchUp?: boolean;
  /** Trigger routines: at most this many runs per rolling 24 h (default LIMITS_SCHED.triggerDailyCapDefault). */
  dailyCap?: number;
}

export type RunTrigger = "schedule" | "manual" | "event" | "bot";
export type RunStatus = "running" | "ok" | "error";
export interface RoutineRun {
  id: string;
  trigger: RunTrigger;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  detail?: string;            // ≤ 300
  event?: string;             // ≤ 300
  coalescedRunIds?: string[]; // ≤ 25
  requestId: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  attempts?: number;          // ORIG-02 §02.8: only when ≥ 2
  lateByMs?: number;          // only when > 60 s
  caughtUp?: number;          // a catch-up run: how many slots were missed while asleep
}

export type RoutineTriggerKind = "schedule" | "webhook" | "slack" | "github" | "linear" | "sentry" | "pagerduty" | "file" | "email" | "calendar" | "group";

export interface RoutineView {
  botId: string;
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  triggerKind: RoutineTriggerKind;
  schedule: string | null;     // stored form
  scheduleRaw: string | null;  // C4 tooltip, e.g. "CRON_TZ=America/New_York 0 8 * * *"
  description: string;         // plain English, e.g. "Every day at 8:00 AM" or "When a file is added to /workspace/inbox"
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  runs: RoutineRun[];
  webhook: { url: string; keyPreview: string; header: string } | null;
  trigger: Trigger | null;
  listenerConnected: boolean | null; // slack/github (RTN-12); email mailbox reachability after N connect failures (bug 51)
  quietHours?: string | null;
  catchUp?: boolean;
  dailyCap?: number | null;
}

export interface MailboxInfo { label: string; host: string; user: string }
