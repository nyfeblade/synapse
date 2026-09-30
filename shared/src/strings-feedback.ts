/** Send feedback (account menu, ⌘K, Help menu, the crash note) and 👍/👎 on replies and tasks. */
export const STRF = {
  sendFeedback: "Send feedback",
  sendReport: "Send a report",
  type: "Type",
  types: { bug: "Bug", idea: "Idea", confusing: "Something confusing", love: "Love it" } as Record<string, string>,
  message: "What's on your mind?",
  screenshot: "Include a screenshot of this window",
  logs: "Attach logs",
  preview: "Preview",
  hidePreview: "Hide preview",
  previewTitle: "What will be sent",
  noScreenshot: "No screenshot",
  showScreenshot: "Show screenshot",
  screenshotTitle: "Screenshot",
  willHide: (what: string) => `Hidden before sending: ${what}`,
  noLogs: "No logs",
  sendPrivately: "Send privately",
  postGithub: "Post on GitHub (public)",
  sending: "Sending…",
  sent: "Sent. Thank you.",
  sentTestMode: "Not sent: test mode.",
  chooseType: "Choose a type.",
  writeMessage: "Write a message first.",
  loading: "Loading…",
  close: "Close",
  app: "App",
  macos: "macOS",
  mac: "Mac",
  githubNoScreenshot: "A screenshot isn't included. Drag one in if it helps.",
  githubLogsCut: "The logs were cut to fit the link.",
  githubLogsCutNote: "Logs cut to fit the link",
  replyNotice: "You have a reply to your feedback",
  view: "View",
  yourFeedback: "Your feedback",
  noThreads: "No feedback sent yet",
  you: "You",
  synapse: "Synapse",
  closed: "Closed",
  replyLabel: "Reply",
  send: "Send",
  sentOn: (when: string) => `Sent ${when}`,
  copyLink: "Copy link",
  copied: "Copied",
  linkHint: "Open this link on any device to see replies.",
  ratings: "Ratings",
  ratingsCount: (up: number, down: number) => `👍 ${up} · 👎 ${down}`,
  rateUp: "Good",
  rateDown: "Bad",
};

/** "Post on GitHub" opens only this page: a new issue on the public repo, prefilled. */
export const FEEDBACK_ISSUE_PREFIX = "https://github.com/nyfeblade/synapse/issues/new?";
/** GitHub turns longer new-issue links away; the logs are cut to fit. */
export const FEEDBACK_MAX_ISSUE_URL = 8000;
export const FEEDBACK_TYPES = ["bug", "idea", "confusing", "love"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export const FEEDBACK_LIMITS = { message: 5000, logsBytes: 64 * 1024, screenshotChars: 1_500_000 };
/** Exactly what "Send privately" posts. */
export interface FeedbackPayload {
  source: "app"; type: FeedbackType; message: string;
  appVersion: string; macos: string; model: string; logs?: string; screenshot?: string;
}
