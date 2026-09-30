/**
 * The LOOK harness's `window.synapse`: the real renderer, headless, over a rich CANNED state — six Bots
 * with colours, presence and live status lines, two groups, a conversation with a user message, a
 * Bot turn with an activity-steps card, a file card, an approval card, a call record and a typing
 * indicator, plus the right column's screen, plan, scheduled work and remembered facts.
 *
 * Dev-only (app/look, excluded from the build and from the packaged app): it exists so a visual
 * parity pass can photograph the REAL components against the look study instead of an empty app.
 * Bundled by esbuild into an init script (shoot.mjs), so it runs before the renderer's own modules.
 */
import type {
  BotSummary, HostSettingsView, MemoryFactView, RoutineView, SseEvent, StepBody, TranscriptEntry, UsageView,
} from "@synapse/shared";

const NOW = Date.UTC(2026, 8, 22, 13, 41, 0); // fixed, so two runs produce the same pixels
const min = (n: number) => n * 60_000;

interface Seed { name: string; colour: string; shape: string; status: string; presence: BotSummary["presence"]; marker: BotSummary["marker"]; running: boolean; detail?: string; title?: string }

const SEEDS: Seed[] = [
  { name: "Chief of Staff", colour: "#5B8CFF", shape: "pebble", status: "Drafting the Q4 plan", presence: "working", marker: "working", running: true, detail: "drafting the Q4 plan", title: "Ops" },
  { name: "Scout", colour: "#3FD08A", shape: "orb", status: "On a call · 4:12", presence: "thinking", marker: null, running: true, detail: "on a call" },
  { name: "Inbox Triage", colour: "#FF7A59", shape: "squircle", status: "3 new · replied to Priya", presence: "idle", marker: "unread", running: false },
  { name: "Disk Saver", colour: "#FFFFFF", shape: "pebble", status: "Freed 12 GB last night", presence: "idle", marker: null, running: false },
  { name: "Otto", colour: "#F5C543", shape: "squircle", status: "Running tests in /web", presence: "working", marker: "working", running: true, detail: "212 tests" },
  { name: "Muse", colour: "#C77DFF", shape: "orb", status: "Wrote 3 captions", presence: "idle", marker: null, running: false },
];
const GROUPS = [
  { name: "Launch crew", members: [0, 2, 4], status: "Otto: the build is green" },
  { name: "Home", members: [1, 3], status: "Groceries ordered" },
];

const id = (i: number) => `bot-${i + 1}`;
const groupId = (i: number) => `group-${i + 1}`;

function bot(i: number): BotSummary {
  const s = SEEDS[i]!;
  return {
    id: id(i),
    profile: { name: s.name, title: s.title ?? "", description: "", avatarShape: s.shape as BotSummary["profile"]["avatarShape"], avatarColor: s.colour, avatarKind: "shape", model: i % 2 === 0 ? "claude-opus-5" : "claude-sonnet-5" } as BotSummary["profile"],
    settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false, permMode: i === 0 ? "full-auto" : "ask" },
    presence: s.presence, activity: s.running ? { tool: "Bash", detail: s.detail ?? null } as BotSummary["activity"] : null,
    marker: s.marker, statusLine: s.status, running: s.running, awaiting: null,
    createdAt: NOW - min(6000), updatedAt: NOW - min(2), lastBotMessageAt: NOW - min(2),
  };
}
function group(i: number): BotSummary {
  const g = GROUPS[i]!;
  return {
    id: groupId(i),
    profile: { name: g.name, title: "", description: "", avatarShape: "pebble", avatarColor: "#8C8C8C", avatarKind: "shape" },
    settings: { notifyOnAgentUpdates: true, hiddenFromSidebar: false },
    presence: "idle", activity: null, marker: null, statusLine: g.status, running: false, awaiting: null,
    createdAt: NOW - min(9000), updatedAt: NOW - min(40), lastBotMessageAt: NOW - min(40),
    group: { memberIds: g.members.map(id) },
  };
}

const AGENTS: BotSummary[] = [...SEEDS.map((_, i) => bot(i)), ...GROUPS.map((_, i) => group(i))];

const SETTINGS: HostSettingsView = {
  autoReviewEnabled: true, allowInstructions: [], blockInstructions: [], userTimeZone: "America/New_York",
  userTimeZoneOverride: null, pinnedAgentIds: [], themePreference: "system",
  memoryRecall: true, advancedEnabled: false,
};

const step = (
  n: number, name: string, stepText: string, icon: string,
  metric: { verb: string; noun: string; nounPlural: string; count: number } | null, startedAt: number, body: StepBody | null = null,
): TranscriptEntry => ({
  kind: "tool-call", id: `t1tc${n}`, requestId: "r1", segmentId: "s1", hidden: false, name, step: stepText,
  icon: icon as never, metric, status: "done", startedAt, endedAt: startedAt + 4000, body,
});

/** bug 198: a Read step's own body — long enough (42 lines) to fold at 18/collapse-to-14, so the look
 *  shot proves the step-body card (StepBody.tsx / ActivityGroup.tsx), not just the fenced-block one
 *  bug 193 already covers. */
const Q3_NOTES_BODY = Array.from({ length: 42 }, (_, i) => `def note_${i}():\n    return "Q3 renewal note ${i}"`).join("\n");

const TRANSCRIPT: TranscriptEntry[] = [
  { kind: "event", id: "t1e1", createdAt: NOW - min(64), event: { type: "bot-created", botId: id(0), name: SEEDS[0]!.name } },
  { kind: "notice", id: "t1n1", createdAt: NOW - min(41), text: "Voice call · 4m 12s · with Scout", callSummary: { summary: "Agreed the Q4 plan lands Thursday.", actions: ["Book the review", "Share the draft with Priya"], durationMs: 252_000 } },
  { kind: "message", id: "t1u1", role: "user", content: "Pull last quarter's numbers and draft the Q4 plan. Then text Sam that the review is Thursday.", createdAt: NOW - min(21) },
  step(1, "Read", "Opened reports/q3-summary.xlsx on your Mac", "file", { verb: "Read", noun: "file", nounPlural: "files", count: 6 }, NOW - min(20)),
  step(2, "Bash", "Ran three commands in /workspace", "terminal", { verb: "Ran", noun: "command", nounPlural: "commands", count: 3 }, NOW - min(19)),
  step(3, "Search", "Queried Drive for \"renewals 2026\"", "search", { verb: "Searched", noun: "Drive", nounPlural: "Drive", count: 1 }, NOW - min(19)),
  step(4, "Read", "Opened reports/q3-notes.py", "file", null, NOW - min(19), { kind: "read", path: "reports/q3-notes.py", language: "py", content: Q3_NOTES_BODY, startLine: 1, truncated: false }),
  { kind: "send-message", id: "t1a1", requestId: "r1", createdAt: NOW - min(18), message: { type: "text", content: "Q3 closed at **$4.82M**, up 11% on Q2. Renewals landed early and churn fell to 2.4%. I built the plan around those two levers." } },
  { kind: "send-message", id: "t1a1b", requestId: "r1", createdAt: NOW - min(17), message: { type: "text", content: "The renewal rate came from `renewals_2026.csv` — run it with:\n\n```python\ndf = pd.read_csv(\"renewals_2026.csv\")\nrate = df[\"renewed\"].mean()\nprint(f\"{rate:.1%}\")\n```" } },
  { kind: "send-message", id: "t1a2", requestId: "r1", createdAt: NOW - min(18), message: { type: "attachment", url: "file:///workspace/q4-plan-draft-1.md", name: "Q4 plan — draft 1.md", size: 18_400, mime: "text/markdown", pages: null, caption: "3 sections · 2 open questions" } },
  {
    kind: "send-message", id: "t1a3", requestId: "r2", createdAt: NOW - min(3),
    message: {
      type: "auto-review-approval",
      approval: {
        approvalId: "ap1", requestId: "r2", surface: "computer", title: "Send an iMessage?",
        reason: "Sending a message on your behalf", summary: "Hey Sam — the Q4 plan review is Thursday 2:00–2:30. The draft is in the shared folder.",
        locationLine: "To Sam Rivera · +1 (415) •••-0192", details: null, command: null, items: [],
        hasProposedRule: true, status: "pending", cause: null, verdict: null, ruleAddedText: null,
        createdAt: NOW - min(3), settledAt: null,
      },
    },
  },
];

const ROUTINES: RoutineView[] = [
  { botId: id(0), id: "rt1", name: "Morning inbox brief", prompt: "", enabled: true, triggerKind: "schedule", schedule: "0 8 * * 1-5", scheduleRaw: "CRON_TZ=America/New_York 0 8 * * 1-5", description: "Weekdays at 8:00", nextRunAt: NOW + min(840), lastRunAt: NOW - min(1400), createdAt: NOW - min(9000), runs: [], webhook: null, trigger: null, listenerConnected: null },
  { botId: id(0), id: "rt2", name: "When an invoice arrives", prompt: "", enabled: true, triggerKind: "email", schedule: null, scheduleRaw: null, description: "Gmail · from:billing", nextRunAt: null, lastRunAt: NOW - min(120), createdAt: NOW - min(9000), runs: [], webhook: null, trigger: null, listenerConnected: true },
];

const prov = (source: "user" | "email", recordedAt: number): MemoryFactView["provenance"] =>
  ({ botId: id(0), botName: SEEDS[0]!.name, recordedAt, source, confidence: 1, chatBotId: id(0), messageId: null });

const FACTS: MemoryFactView[] = [
  { id: "m1", date: "2026-09-14", tier: "profile", kind: "fact", content: "Sam prefers texts over email for scheduling.", provenance: prov("user", Date.UTC(2026, 8, 14)) },
  { id: "m2", date: "2026-09-19", tier: "profile", kind: "fact", content: "Q4 reviews go to Priya first.", provenance: prov("email", Date.UTC(2026, 8, 19)), history: [{ content: "Q4 reviews go to Dana first.", validFrom: Date.UTC(2026, 8, 2), validTo: Date.UTC(2026, 8, 19), source: "user", botName: SEEDS[0]!.name }] },
];

const USAGE: UsageView = {
  source: "metering",
  budgetPct: 38, level: "ok" as UsageView["level"], limitedUntil: null,
  weekStart: NOW - min(5000), rows: [], efficiency: {} as UsageView["efficiency"],
};

const CANNED: Record<string, unknown> = {
  listAgents: { agents: AGENTS, activeAgentId: id(0) },
  getHostSettings: SETTINGS,
  getTrays: { trays: [] },
  getOnboarding: { hasSeenOnboarding: true, tokenConfigured: true },
  getTeachRecordingStatus: { status: { state: "IDLE", botId: null, sessionId: null, sessionDir: null, startedAtMs: null, elapsedMs: 0, goal: null } },
  openAgent: { agent: AGENTS[0] },
  getAgentTranscriptTail: { entries: TRANSCRIPT },
  getAgentAutomations: { routines: ROUTINES },
  getAgentMemories: { facts: FACTS, projects: [] },
  getUsage: USAGE,
  getDisplays: { displays: [], waiting: [] },
  getForeverBoxStatus: { phase: "ready", detail: null },
  getDiskPressure: { level: "ok", freeBytes: 120e9 },
  getMarketplace: { installed: { count: 0, logos: [] }, featuredBots: [], forYou: null, fromTeam: [], featuredPlugins: [], categories: [] },
  getStandup: { standup: null },
  getSkills: { workflows: [] },
};

const listeners = new Set<(e: SseEvent) => void>();
const inert = async () => ({ ok: false, error: { code: "UNSUPPORTED", message: "look harness" } });

(window as unknown as { synapse: unknown }).synapse = {
  call: async (cmd: string, args: unknown) => {
    void args;
    const result = CANNED[cmd];
    return result === undefined ? { ok: true, result: {} } : { ok: true, result };
  },
  onEvent: (cb: (e: SseEvent) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
  onConnection: (cb: (s: unknown) => void) => { cb({ kind: "connected" }); return () => {}; },
  retry: () => {},
  appInfo: async () => ({ userName: "Alex Rivera" }),
  vncUrl: () => null,
  secrets: { list: async () => [], save: inert, remove: inert, keepOnBox: inert, rename: inert, submitRequest: async () => "", submitForm: async () => "" },
  auth: { saveKey: inert, testKey: inert },
  box: { update: async () => ({ status: "done" }), recover: async () => {}, reset: async () => {}, info: async () => ({ bundledImageVersion: "look" }), onLifecycle: () => () => {} },
  saveFile: async () => ({ saved: false }),
  onOpenBot: () => () => {},
  setNativeTheme: () => {},
  native: { invoke: inert, on: () => () => {} },
};

/** The typing indicator: a live SSE event, the way the real host sends it. */
(window as unknown as { __look: unknown }).__look = {
  /** Bug 233 (living-app.mjs): the seed's Bots, and a live SSE event, the way the real host sends it. */
  agents: () => AGENTS,
  emit: (e: SseEvent) => { for (const cb of listeners) cb(e); },
  typing: () => { for (const cb of listeners) cb({ channel: "transcript", payload: { op: "typing", botId: id(0), typing: true, partialText: null } } as SseEvent); },
  /**
   * Smooth pass, Task 5: the right panel starts closed, so the default shots (app-dark.png,
   * app-light.png) never show it. This is the second capture's hook — it opens the panel the same
   * way the user does, by clicking the header's own "View conversation details" toggle, so the shot
   * is of the real control's real result rather than a shortcut into the store.
   */
  openPanel: () => { (document.querySelector('[aria-label="View conversation details"]') as HTMLButtonElement | null)?.click(); },
  /** bug 198: opens the Q3 activity group's step list, then expands the long Read step's own body —
   *  the step-body card (StepBody.tsx) this bug adds, next to the fenced-block card bug 193 already
   *  shot. Two separate clicks (not one function that does both) so shoot.mjs can let each render
   *  settle before the next. */
  /** UI polish pass: the Bot's synthetic cursor on the Computer stage, so its name label is on record. */
  cursor: (x: number, y: number) => {
    for (const cb of listeners) cb({ channel: "computer-action", payload: { botId: id(0), index: 1, kind: "move", x, y, at: Date.now(), source: "computer" } } as SseEvent);
  },
  openSteps: () => { (document.querySelector('[aria-label="Show steps"]') as HTMLButtonElement | null)?.click(); },
  expandStepBody: () => {
    const toggles = document.querySelectorAll<HTMLButtonElement>(".step-toggle");
    const last = toggles[toggles.length - 1];
    last?.click();
    // fix round 1: scrolled so the shot proves the LAYOUT fix — the toggle (summary line) and its
    // body both on screen at once, body below it, not just the body alone mid-scroll.
    last?.scrollIntoView({ block: "center" });
  },
};
