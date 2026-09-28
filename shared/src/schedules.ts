/** Scheduled jobs, triggers and the daily standup (schedules-triggers-standup). */

export const LIMITS_SCHED = {
  /** A trigger routine starts at most this many turns per rolling 24 h unless its own dailyCap says otherwise. */
  triggerDailyCapDefault: 50,
  triggerDailyCapMax: 500,
  /** Gmail history poll (no model call; one cheap API request when nothing changed). */
  gmailPollMs: 60_000,
  gmailFetchMax: 25,
  /** Calendar "starts in N minutes" poll. */
  calendarPollMs: 60_000,
  calendarLeadMaxMin: 24 * 60,
  /** Mac folder poll over the local bridge (names only). */
  macFolderPollMs: 60_000,
  /** Standup: activity window, digest size and the one short model call's budget. */
  standupWindowMs: 24 * 3_600_000,
  standupDigestMaxChars: 1_200,
  standupLineMaxChars: 160,
  standupKept: 14,
} as const;

export interface StandupSettings {
  enabled: boolean;
  /** "HH:MM" in the account time zone. */
  time: string;
  weekdaysOnly: boolean;
  /** Speak the card when a voice call is active. */
  spoken: boolean;
}

export const DEFAULT_STANDUP: StandupSettings = { enabled: false, time: "09:00", weekdaysOnly: true, spoken: false };

export interface StandupLine {
  botId: string;
  name: string;
  did: string;
  blocked: string;
  needs: string;
}

export interface StandupCard {
  id: string;
  createdAt: number;
  /** The slot it was for; later than createdAt only never. */
  scheduledFor: number;
  caughtUp: boolean;
  lines: StandupLine[];
  /** Bots that were idle in the window: no line and no model call. */
  idle: string[];
  usage: { modelCalls: number; inputTokens: number; outputTokens: number };
  /** Bug 115: the standup for this slot failed; the card says so instead of leaving yesterday's in its place. */
  error?: string;
}

export interface StandupView { settings: StandupSettings; latest: StandupCard | null; nextAt: number | null }

export const STRS = {
  quietHoursInvalid: "Enter quiet hours like 22:00-07:00",
  scheduledOrigin: (name: string, caughtUp: boolean) => `Scheduled · ${name}${caughtUp ? " · caught up" : ""}`,
  triggeredOrigin: (name: string) => `Triggered · ${name}`,
  caughtUpNote: (missed: number) =>
    ` (caught up: the computer was asleep or off at the scheduled time${missed > 1 ? `, and ${missed} runs were missed` : ""}. This is the one catch-up run; say so briefly if you send anything)`,
  dailyCapReached: (cap: number) => `Not run: this trigger reached its limit of ${cap} runs in 24 hours.`,
  firstScheduleConfirm: "This Bot is setting up its first schedule or trigger. It will start turns on its own from now on.",
  schedules: "Schedules",
  schedulesEmpty: "No schedules or triggers yet. Ask a Bot, for example: every weekday at 8, summarize my inbox.",
  quietHours: "Quiet hours",
  teamStandup: "Team standup",
  standup: "Daily standup",
  standupHelp: "Each morning every Bot writes one line from its own recent activity. Idle Bots are skipped and cost nothing.",
  standupTime: "Time",
  standupWeekdays: "Weekdays only",
  standupSpoken: "Read it aloud during a voice call",
  standupRunNow: "Run now",
  standupPlay: "Play",
  standupNone: "No standup yet.",
  standupAllIdle: "Every Bot was idle.",
  standupDid: "Did",
  standupBlocked: "Blocked on",
  standupNeeds: "Needs from you",
  standupIdle: (names: string[]) => `Idle: ${names.join(", ")}`,
  standupCaughtUp: "caught up",
  standupFailed: "This standup couldn't be written. Run it again with Run now.",
  standupSpokenText: (lines: StandupLine[]) =>
    lines.length
      ? `Team standup. ${lines.map((l) => `${l.name}: ${l.did}.${l.blocked && l.blocked !== "nothing" ? ` Blocked on ${l.blocked}.` : ""}${l.needs && l.needs !== "nothing" ? ` Needs from you: ${l.needs}.` : ""}`).join(" ")}`
      : "Team standup. Every Bot was idle.",
} as const;
