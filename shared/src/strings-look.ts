// The Carbon look (docs/decisions.md, "the Carbon Graphite look"): the words the new chrome adds.
// Titles and labels only, and secondary text only where it carries data (a count, a time, a value).

export const STRL = {
  home: "Home",
  schedules: "Schedules",
  usage: "Usage",
  bots: "Bots",
  groups: "Groups",
  /** The search field's shortcut hint (⌘K opens the command palette from anywhere). */
  searchKey: "⌘K",
  /** The account row's second line: the share of the weekly budget spent, when one is set (API spend, never a plan). */
  weekLine: (budgetPct: number | null) => (budgetPct === null ? "" : `${Math.round(budgetPct)}% of weekly budget`),
  usageRing: (pct: number) => `${Math.round(pct)}% of this week's budget`,
  send: "Send message",
  tabs: { now: "Now", memory: "Memory", files: "Files" },
  detailsTabs: "Details",
  computer: "Computer",
  /** The right column's Computer card: which machine the screen belongs to. Data, not an explanation. */
  computerMeta: "Your Mac",
  scheduled: "Scheduled",
  /** The open run, step by step (the Plan card). */
  plan: "Plan",
  planEmpty: "Nothing running",
  planProgress: (done: number, total: number) => `${done} of ${total}`,
  planNow: "now",
  scheduledEmpty: "Nothing scheduled",
  remembers: "Remembers",
  noFiles: "No files yet",
  onCall: "On a call",
  thinking: "Thinking",
} as const;
