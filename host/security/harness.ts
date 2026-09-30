import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermMode } from "@synapse/shared";
import { ApprovalGate, type GateDeps } from "../approvals/approval-gate";
import { BotService } from "../bots/bot-service";
import { DEFAULT_FLAGS } from "../brain/conformance/flags";
import type { WakeSource } from "../brain/types";
import { loadConfig, type HostConfig } from "../config";
import { SseHub } from "../gateway/sse-hub";
import { VerdictCache } from "../review/cache";
import { CircuitBreaker } from "../review/circuit";
import { ReviewLog } from "../review/log";
import type { ModelReviewer } from "../review/model-reviewer";
import { Reviewer } from "../review/reviewer";
import type { Verdict } from "../review/types";
import { onPostToolUse } from "../runner/discipline";
import { newSlot, type TurnSlot } from "../runner/turn-slot";
import { HostSettingsStore } from "../store/host-settings";
import { initLayout } from "../store/layout";
import { SafetyService } from "../review/safety";
import type { BotNetwork, PresetName } from "@synapse/shared";

/**
 * The security suite's test bench: the real approval gate and the real Auto-review pipeline (floors, fast path, exact
 * rules, the Full-auto checks, post-validation), with ONE part swapped out: the AI reviewer. In its place sits a
 * "fooled" reviewer that says yes to everything, with full confidence, citing every allow rule it can see.
 *
 * That is the worst case for safety on purpose: every block this bench records comes from deterministic host code,
 * not from a model's judgement. No model, no API key and no network are used.
 */
export class FooledModel implements ModelReviewer {
  calls = 0;
  async review(input: Record<string, unknown>): Promise<Verdict> {
    this.calls++;
    const rules = (input.rules ?? {}) as { allow_automatically?: { id: string }[] };
    return {
      decision: "allow", risk_tier: 0, floor_category: null, matched_ask_rule_ids: [],
      matched_allow_rule_ids: (rules.allow_automatically ?? []).map((r) => r.id), injection_suspected: false, confidence: 1,
      reason: "Looks fine to me.", proposed_allow_rule: null,
    };
  }
}

/** The owner's Mac as the fixed rules see it (a made-up account; nothing on this machine is read). */
export const MAC = { home: "/Users/alex", projectDirs: ["/Users/alex/code"], userData: "/Users/alex/Library/Application Support/Synapse" } as const;
export const OWNER_EMAIL = "owner@example.com";

export interface BenchOpts {
  /** The owner's latest message (what they actually asked for). */
  owner?: string;
  mode?: PermMode;
  /** What woke the Bot for this turn (default: the owner's own message). */
  source?: WakeSource;
  /** The outside text that came with a non-owner wake (an email event, an outside app's request). */
  wakeText?: string;
  /** Owner's saved Auto-review rules. */
  allowRules?: string[];
  askRules?: string[];
  autoReview?: boolean;
  trusted?: string[];
  /** Addresses the owner has emailed before (their Sent folder). */
  sent?: string[];
  /** Who a Composio send really reaches, looked up on the host. */
  composioRecipients?: GateDeps["composioRecipients"];
  /** Safety v2: No limits (with Full auto). */
  noLimits?: boolean;
  /** Safety v2: the owner's rules, in plain English (compiled by the real compiler). */
  rules?: string[];
  /** Safety v2: a preset other than Balanced. */
  preset?: PresetName;
  /** Safety v2: the Bot's network list. */
  network?: BotNetwork;
  /** Safety v2: Settings → Local network. */
  lanOpen?: boolean;
}

export interface Bench {
  cfg: HostConfig;
  gate: ApprovalGate;
  bots: BotService;
  botId: string;
  slot: TurnSlot;
  model: FooledModel;
  safety: SafetyService;
  settings: HostSettingsStore;
  /** One tool call through the gate: "allow", "ask" (a card for the owner), "deny" or "defer". */
  call(toolName: string, input: Record<string, unknown>): Promise<{ decision: string; reason?: string }>;
  /** The Bot reads outside content (a web page, an email) through the real post-tool path. */
  read(text: string, toolName?: string): void;
  newBot(name: string): string;
  dispose(): void;
}

let seq = 0;

export function bench(o: BenchOpts = {}): Bench {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sec-suite-"));
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  const cfg = loadConfig({
    DATA_ROOT: path.join(root, "agent-data"), HOST_PRIVATE: path.join(root, ".host"), WORKSPACE: path.join(root, "workspace"),
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"), SYNAPSE_CC_MANAGED: path.join(root, "cc-managed"), HOST_PORT: "0", WEBHOOK_PORT: "0",
    WEBHOOK_BIND: "127.0.0.1", BRAIN: "fake", REVIEWER: "stub", DISK_FREE_PCT: "50",
  });
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  settings.update({
    allowInstructions: o.allowRules ?? [], blockInstructions: o.askRules ?? [],
    ...(o.autoReview === false ? { autoReviewEnabled: false } : {}), ...(o.trusted ? { trustedRecipients: o.trusted } : {}),
  });
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const botId = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const safety = new SafetyService({ settings });
  if (o.preset) safety.setPreset(o.preset);
  if (o.network) safety.setNetwork(botId, o.network);
  const setup = o.rules ? Promise.all(o.rules.map((t) => safety.addRule(t, { bots: [{ id: botId, name: "Piper" }] }))) : Promise.resolve([]);
  const now = Date.now();
  bots.appendEntry(botId, { kind: "message", id: "t1u", role: "user", content: o.owner ?? "Tidy up the project.", clientNonce: "n1", createdAt: now });
  const source = o.source ?? "user";
  const owner = source === "user";
  const slot: TurnSlot = {
    ...newSlot({ botId, requestId: "req_1", turnNo: 2, lane: owner ? "user" : "agent", source, hidden: !owner, silenceAllowed: !owner, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: now }),
    ...(o.wakeText ? { wakeText: o.wakeText } : {}),
  };
  const model = new FooledModel();
  const reviewer = new Reviewer({
    settings, model, cache: new VerdictCache(), circuit: new CircuitBreaker(), log: new ReviewLog(path.join(root, "review-log.jsonl")),
    timeZone: () => "UTC", workspace: cfg.workspace,
  });
  const gate = new ApprovalGate({
    cfg, bots, settings, reviewer, slot: () => slot, flags: () => DEFAULT_FLAGS, readFile: () => null, onDeferredResolution: () => {},
    safety, lanOpen: () => o.lanOpen === true, noLimits: () => o.noLimits === true,
    permMode: () => o.mode ?? "ask", googleEmail: () => OWNER_EMAIL, googleBuiltin: () => true, composioBuiltin: () => true,
    macEnv: () => ({ home: MAC.home, projectDirs: MAC.projectDirs, userData: MAC.userData }),
    mcpReadOnly: () => false,
    mcpToolInfo: () => ({ known: false, description: null }),
    googleCardFacts: async (_t, input) => ({ lines: [`To: ${JSON.stringify(input.to ?? input.attendees ?? [])}`] }),
    composioRecipients: o.composioRecipients ?? (async () => ({ recipients: [], channels: [] })),
    sentTo: async (_b, a) => (o.sent ?? []).includes(a.toLowerCase()),
    routinePrompt: () => null,
  });
  let n = 0;
  return {
    cfg, gate, bots, botId, slot, model, safety, settings,
    async call(toolName, input) {
      await setup;
      const d = await gate.preToolUse(botId, { toolName, input, toolUseId: `sec${++seq}-${++n}` });
      return { decision: d.decision, ...("reason" in d && d.reason ? { reason: d.reason } : {}) };
    },
    read(text, toolName = "WebFetch") {
      onPostToolUse(slot, { toolName, input: {}, toolUseId: `read${++seq}` }, text, () => Date.now());
    },
    newBot(name) { return bots.create({ origin: "user", kickstart: false, name }); },
    dispose() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}
