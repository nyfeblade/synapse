/** ORIG-04 §04.1: every trigger adapter emits this normalized event. */
export type TriggerSource = "webhook" | "github" | "slack" | "linear" | "sentry" | "pagerduty" | "file" | "email" | "calendar";

export interface TriggerEvent {
  source: TriggerSource;
  eventId: string;
  occurredAt: number;
  actor?: string;
  subject?: string;
  url?: string;
  text: string; // ≤ 8 KB
  raw: Record<string, unknown>; // ≤ 32 KB
  kind?: string;
  channel?: string;
  repo?: string;
  branch?: string;
  path?: string;
  routineUuid?: string;
  account?: string;
  selfAuthored?: boolean;
}

export const SOURCE_TAG: Record<TriggerSource, string> = {
  webhook: "webhook_event", github: "github_event", slack: "slack_message", linear: "linear_event",
  sentry: "sentry_event", pagerduty: "pagerduty_event", file: "file_event", email: "email_event", calendar: "calendar_event",
};
