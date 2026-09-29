import { describe, expect, it } from "vitest";
import { STR, type CommandName } from "@synapse/shared";
import { classifyTool } from "../../review/classify";
import { PARITY, READ_ONLY_COMMANDS, SPEC_GATEWAY_COMMANDS, USER_ONLY_TEXT } from "../../tools/parity";

/**
 * Every command the shared contract has today; adding a CommandName without listing it here fails
 * tsc. This repo's `GatewayCommands` (shared/src/gateway.ts) has grown past the task-40 brief's
 * snapshot (extra CRUD/read commands from workflows, attachments, reactions, search, context and
 * session management) — those extra keys are classified below too so this stays exhaustive.
 */
const IMPLEMENTED: Record<CommandName, true> = {
  getHealth: true, listAgents: true, createAgent: true, updateAgent: true, deleteAgent: true, openAgent: true, setAgentPinned: true,
  getAgentTranscriptTail: true, sendPrompt: true, interruptAgent: true, resolveAutoReviewApproval: true, getHostSettings: true,
  setHostSettings: true, getTrays: true, dismissTray: true, clearTrays: true,
  getAgentAutomations: true, listAllAutomations: true, getStandup: true, setStandupSettings: true, runStandupNow: true, setAgentAutomationEnabled: true, createAgentAutomation: true,
  updateAgentAutomation: true, deleteAgentAutomation: true, runAgentAutomationNow: true, getAutomationWebhook: true,
  rotateAutomationWebhookKey: true, setListenerCredentials: true, addMailbox: true, createGroup: true, setGroupMembers: true,
  respondToWidget: true, dismissWidget: true, broadcastToAgents: true, getUsage: true, startTeachRecording: true,
  stopTeachRecording: true, pauseTeachRecording: true, resumeTeachRecording: true, discardTeachRecording: true, getTeachRecordingStatus: true,
  // Extra keys present in this repo's current GatewayCommands beyond the brief's snapshot:
  setAgentHiddenFromSidebar: true, duplicateAgent: true, setAgentUnread: true, setAgentNotificationsEnabled: true,
  uploadAttachment: true, readAttachmentChunk: true, readWorkspaceFile: true, getAgentThread: true, reactToMessage: true,
  getAgentTranscriptPage: true, search: true, getAgentContext: true, compactAgentNow: true, newAgentSession: true, setAgentHistoryKeep: true,
  getWorkflows: true, getWorkflow: true, createWorkflow: true, updateWorkflow: true, deleteWorkflow: true,
  setAgentWorkflowEnabled: true, importWorkflowText: true, importWorkflowUrl: true, importWorkflowFolder: true,
  // Phase 3 (computer, secrets, disk, snapshots):
  getForeverBoxStatus: true, getDisplays: true, ensureDisplay: true, handBackForeverBox: true, setTakeoverActive: true, openComputerApp: true,
  getAsyncTasks: true, setBotSecrets: true, getBotSecretsStatus: true, submitSecret: true, submitForm: true,
  getDiskPressure: true, openDiskSaver: true, snapshotBoxStoreNow: true, getBoxStoreStatus: true, listSnapshots: true,
  restoreSnapshot: true, deleteSnapshot: true, prepareBoxRestart: true, setBoxMaintenance: true,
  // Phase 5:
  setWeeklyBudget: true, getUsageDashboard: true, getBudgets: true, setBudget: true, approveBudget: true, clearTaskAlert: true, getBudgetPrompt: true, dismissBudgetPrompt: true, setMonthlyBudget: true, macClaudeAuth: true, recordMacUsage: true, getModelAccess: true, getMarketplace: true, searchCatalog: true, getCatalogEntry: true, listPlugins: true, installPlugin: true,
  uninstallPlugin: true, listMcpServers: true, addMcpServer: true, removeMcpServer: true, renameMcpAccount: true, setMcpToolEnabled: true,
  setMcpInstructions: true, restartMcpServers: true, setMcpServerEnabled: true, setMcpServerTrusted: true, setMcpServerHeader: true, setOAuthLoopbackPort: true, startMcpAuth: true, completeMcpOAuth: true, listPluginMarketplaces: true,
  addPluginMarketplace: true, removePluginMarketplace: true, draftTemplate: true, exportTemplate: true, getTemplate: true,
  deleteTemplate: true, previewTemplateImport: true, importTemplate: true, listStarterTemplates: true, getLocalComputer: true, getLocalPolicyStatus: true, getLocalPolicyReset: true, dismissLocalPolicyReset: true, restoreLocalBotModes: true, resetLocalPolicy: true, getLocalBotMode: true, getLocalBrowserAllowed: true, setLocalBrowserAllowed: true, getLocalMacAppAllowed: true, setLocalMacAppAllowed: true, getBrowserUsage: true,
  setLocalComputer: true, registerLocalComputer: true, localExecHeartbeat: true, localExecOutput: true, localExecDone: true,
  localExecUpload: true, readLocalFile: true, resolveLocalToolPermission: true, getNetworkStats: true, generateAgentAvatar: true,
  setAgentAvatarBytes: true, getAgentAvatar: true, clearAgentAvatar: true, setAgentVoice: true, noteVoiceCall: true, startCall: true, addToCall: true, removeFromCall: true, endCall: true, getOnboarding: true,
  completeOnboarding: true, listCodingAgents: true, setMemoryMode: true,
  setAgentFollowups: true, setAgentEngineeringMode: true, setAgentPermMode: true, setAgentNoLimits: true, setAgentSaveUsage: true, setAgentComputerPerception: true, getPhase5Settings: true,
  // Built-in Google connector:
  getGoogleStatus: true, setGoogleClient: true, startGoogleAuth: true, disconnectGoogle: true, setAgentGoogle: true,
  getGitHubStatus: true, startGitHubSignIn: true, signOutGitHub: true,
  // The memory screen (MEM-09, designed):
  getAgentMemories: true, addAgentMemory: true, updateAgentMemory: true, deleteAgentMemory: true, clearAgentMemories: true, getHistoryArchiveStats: true,
  // Settings → Account (sign-in mode, API key):
  getAuth: true, setApiKey: true, clearApiKey: true, testAuthConnection: true, checkApiKey: true,
  listBotCalls: true, answerBotCall: true, setBotCallPermission: true, getCallGreetings: true, wrapUpCall: true, voiceSpeculate: true, voiceSpeculateCancel: true,
};

/** Tools the Phase 4 host registers, and the update_state targets it handles. */
const PHASE4_TOOLS = new Set(["SendMessage", "update_state", "CreateAgent", "UpdateAgent", "DuplicateAgent", "ArchiveAgent", "DeleteAgent", "CreateChannel", "UpdateChannel", "LeaveChannel", "SendToAgent", "TeachAnalyze", "TeachReview"]);
const PHASE4_TARGETS = new Set(["profile", "settings", "routine", "account_settings"]);

describe("control-plane parity (ORIG-17 §17.3)", () => {
  it("classifies every §4.5 and Phase 4 command exactly once", () => {
    const all = [...SPEC_GATEWAY_COMMANDS, ...READ_ONLY_COMMANDS];
    expect(new Set(all).size).toBe(all.length);
    for (const c of Object.keys(IMPLEMENTED)) expect(all, `unclassified command ${c}`).toContain(c);
  });

  it("maps every state-changing command to a tool, a later phase or a user-only reason", () => {
    const unmapped = SPEC_GATEWAY_COMMANDS.filter((c) => !PARITY[c]);
    expect(unmapped).toEqual([]);
    expect(Object.keys(PARITY).filter((c) => !SPEC_GATEWAY_COMMANDS.includes(c))).toEqual([]);
  });

  it("every in-phase tool it names exists", () => {
    for (const [cmd, e] of Object.entries(PARITY)) {
      if (!("tool" in e) || "laterPhase" in e) continue;
      const [tool, target] = e.tool.split(":");
      expect(PHASE4_TOOLS.has(tool!), `${cmd} → ${e.tool}`).toBe(true);
      if (target) expect(PHASE4_TARGETS.has(target), `${cmd} → ${e.tool}`).toBe(true);
    }
  });

  it("user-only rows carry the spec's refusal text", () => {
    expect(USER_ONLY_TEXT("Auto-review")).toBe(STR.userOnly("Auto-review"));
    expect(PARITY.resolveAutoReviewApproval).toEqual({ userOnly: "answering approval cards" });
  });

  it("DeleteAgent is reviewed as a control-plane action with floor F4; the other creation tools are not reviewed", () => {
    const c = (toolName: string, input: Record<string, unknown>) => classifyTool({ toolName, input, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host" });
    expect(c("mcp__bot__DeleteAgent", { agent_id: "x", confirm: true }).surface).toBe("control_plane");
    for (const t of ["CreateAgent", "UpdateAgent", "DuplicateAgent", "ArchiveAgent", "CreateChannel", "UpdateChannel", "LeaveChannel"]) {
      expect(c(`mcp__bot__${t}`, {}).surface, t).toBeNull();
    }
  });
});
