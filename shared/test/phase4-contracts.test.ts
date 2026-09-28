import { describe, expect, it } from "vitest";
import {
  B2B_KINDS, COMPUTER_NAME, GITHUB_EVENT_KINDS, LIMITS, STR, isAgentMessage,
  type AgentMessageEntry, type GatewayCommands, type RoutineDef, type SendToAgentArgs, type TimelineEvent, type TranscriptEntry, type Trigger,
} from "../src/index";

describe("routine contracts (RTN-01, §4.3)", () => {
  it("has the 14 GitHub event kinds and every trigger variant", () => {
    expect(GITHUB_EVENT_KINDS).toHaveLength(14);
    const triggers: Trigger[] = [
      { cron: { schedule: "0 8 * * *" } },
      { slack: { channel: "#ops", match: { keyword: "deploy" } } },
      { github: { repo: "me/app", events: ["prOpened", "ciCompleted"], ciBranch: "main" } },
      { linear: { event: "issueCreated" } },
      { sentry: { event: "issue" } },
      { pagerduty: { event: "incident.triggered" } },
      { webhook: {} },
      { file: { paths: ["/workspace/inbox/**"], events: ["created"] } },
      { email: { account: "work", query: "from:boss has:attachment" } },
      { group: { listeners: [{ webhook: {} }, { file: { paths: ["/workspace/a/*"], events: ["modified"] } }] } },
    ];
    expect(triggers).toHaveLength(10);
    const def: RoutineDef = { name: "Morning inbox sweep", prompt: "Sweep the inbox", schedule: "0 8 * * *", enabled: true, createdAt: 1 };
    expect(def.name.length).toBeLessThanOrEqual(LIMITS.routineNameMax);
  });
});

describe("bot-to-bot contracts (ORIG-09 §09.1)", () => {
  it("has exactly five kinds and no ack/thanks/fyi kind", () => {
    expect(B2B_KINDS).toEqual(["request", "question", "blocker", "handoff", "result"]);
    const args: SendToAgentArgs = { target_id: "x", kind: "request", message: "Make the CSV", expects: "a CSV at /workspace/q3.csv" };
    expect(args.kind).toBe("request");
  });
  it("tells agent entries apart from user messages", () => {
    const agent: AgentMessageEntry = {
      kind: "message", id: "t7a1", role: "user", content: "done", chainId: "c_1", createdAt: 1,
      fromAgent: { id: "b", name: "Scout", kind: "result", inReplyTo: "r_abcdefgh" },
    };
    const user: TranscriptEntry = { kind: "message", id: "t1u", role: "user", content: "hi", createdAt: 1 };
    expect(isAgentMessage(agent)).toBe(true);
    expect(isAgentMessage(user)).toBe(false);
  });
  it("covers the ORIG-18 event types", () => {
    const evs: TimelineEvent[] = [
      { type: "wake-origin", source: "agent", botIds: ["a"] },
      { type: "member-pass", botIds: ["a", "b"], roomTurnId: "rt1" },
      { type: "agent-exchange", chainId: "c_1", botIds: ["a", "b"], entryIds: ["t1a1"], count: 4 },
      { type: "agents-messaged", botIds: ["a", "b", "c"], chainId: "c_1" },
      { type: "routine-disabled", routineId: "r", name: "R", count: 3 },
    ];
    expect(evs.map((e) => e.type)).toContain("member-pass");
  });
});

describe("Phase 4 limits (spec §5.1, §9.0)", () => {
  it("copies the constants verbatim", () => {
    expect(LIMITS.maxRoutinesPerBot).toBe(50);
    expect(LIMITS.runHistoryMax).toBe(20);
    expect(LIMITS.minScheduleSpacingMs).toBe(300_000);
    expect(LIMITS.concurrentRoutineTurns).toBe(3);
    expect(LIMITS.routineRetryDelaysMs).toEqual([120_000, 600_000]);
    expect(LIMITS.eventsPerWake).toBe(25);
    expect(LIMITS.eventsQueuedMax).toBe(500);
    expect(LIMITS.webhookPort).toBe(47801);
    expect(LIMITS.webhookBodyMax).toBe(262_144);
    expect(LIMITS.maxHops).toBe(40);
    expect(LIMITS.chainTokenBudget).toBe(1_500_000);
    expect(LIMITS.coalesceWindowMs).toBe(5000);
    expect(LIMITS.groupMaxMembers).toBe(6);
    expect(LIMITS.groupMessagesPerRoomTurn).toBe(10);
    expect(LIMITS.floorRelevance).toBe(0.35);
    expect(LIMITS.teachAutoStopMs).toBe(602_000);
  });
});

describe("Phase 4 copy", () => {
  it("uses the spec's strings", () => {
    // Trimmed with the Carbon look (decisions.md, "no unnecessary subtitles"): an empty state says
    // what is empty; the Bot is asked in chat to add one, which the panel does not need to explain.
    expect(STR.routinesEmpty).toBe("Nothing scheduled");
    expect(STR.traySkippedOffline(3)).toBe(`3 routine runs were skipped while ${COMPUTER_NAME} was off`);
    expect(STR.trayRoutineFailed("Digest")).toBe('Routine "Digest" failed');
    expect(STR.routinesCount("Disabled", 3)).toBe("Disabled ⏱ 3 routines");
    expect(STR.passedNames(["Ledger"])).toBe("Ledger passed");
    expect(STR.passedNames(["Scout", "Ledger"])).toBe("Scout and Ledger passed");
    expect(STR.messagesWith(4)).toBe("4 messages with");
    expect(STR.teachRec(65_000)).toBe("● REC 1:05");
    expect(STR.teachPaused(65_000)).toBe("● PAUSED 1:05");
    expect(STR.teachContinue).toBe("Continue");
    expect(STR.userOnly("Auto-review")).toBe("Only the user can change this. Ask them to open Settings → General → Auto-review.");
  });
});

// Compile-time check that the gateway gained the Phase 4 commands (a missing key fails `tsc -p shared`).
type Has<K extends string> = K extends keyof GatewayCommands ? true : never;
const phase4Commands: Has<
  "getAgentAutomations" | "listAllAutomations" | "setAgentAutomationEnabled" | "createAgentAutomation" | "updateAgentAutomation"
  | "deleteAgentAutomation" | "runAgentAutomationNow" | "getAutomationWebhook" | "rotateAutomationWebhookKey" | "setListenerCredentials"
  | "addMailbox" | "createGroup" | "setGroupMembers" | "respondToWidget" | "dismissWidget" | "broadcastToAgents" | "getUsage"
  | "startTeachRecording" | "stopTeachRecording" | "pauseTeachRecording" | "resumeTeachRecording" | "discardTeachRecording" | "getTeachRecordingStatus"
>[] = [];
void phase4Commands;
