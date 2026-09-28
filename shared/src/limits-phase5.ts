const MiB = 1024 ** 2;
const MIN = 60_000;
const HOUR = 3_600_000;

export const LIMITS5 = {
  // LOC-07 / §5.1 / §5.2
  localFileMaxBytes: 100 * MiB,
  localHeartbeatMs: 10_000,
  localLivenessMs: 30_000,
  localExecIdleWatchdogMs: 10_000,
  localDataPostMs: 120_000,
  localAskTtlMs: 10 * MIN,
  /** fix-mac-gate-and-approval-expiry (Bug B): a Mac card waits for the user's answer (spec §6.2: a card holds the turn
   *  until the user answers it). An unanswered card, and an answered-but-unused Mac approval, are dropped only for
   *  hygiene after this long, never after the old 10 minutes. */
  localApprovalHygieneMs: 7 * 24 * HOUR,
  localTargetMax: 10_000,
  localChunkBytes: 512 * 1024,
  localOutputMaxChars: 40_000,
  // feat-mac-access-parity: CLI-parity Mac file tools.
  localGlobMax: 1_000,     // paths returned by a Mac glob
  localGrepMax: 500,       // match lines returned by a Mac grep
  localReadLineMax: 2_000, // default lines a Mac read returns when no range is given
  // §5.3 MCP OAuth, §5.1 MCP output spill, SET-17 instructions
  mcpOAuthPendingTtlMs: 11 * MIN,
  mcpOutputSpillBytes: 40_000,
  mcpOutputSpillMaxChars: 1_000_000,
  mcpInstructionsMax: 500,
  // PLG header auth: a remote server's request headers. The cap is generous for the real shape of
  // this (one auth header, occasionally a second for an account/project id) and small enough that a
  // marketplace .mcp.json can't use the sealed store as bulk storage.
  mcpHeadersMax: 8,
  mcpHeaderNameMax: 128,
  mcpHeaderValueMax: 8192,
  mcpCallTimeoutMs: 14 * MIN,
  // PLG-11 / ORIG-18 §18.8
  forYouMax: 4,
  categoryPreview: 4,
  recentMarketplaceMax: 3,
  // BOT-18
  avatarMaxBytes: 5 * 1024 * 1024,
  avatarSvgMaxBytes: 20_000,
  avatarPromptMax: 300,
  // TPL
  templateMaxBytes: 16 * MiB,
  // ORIG-14
  ladderL1: 0.8,
  ladderL2: 0.9,
  ladderL3: 1.0,
  /** Review round 2 (P1): an API rate limit (429) with no wait given pauses background work this long, not limitDefaultResetMs. */
  rateLimitPauseMs: 60_000,
  limitDefaultResetMs: 5 * HOUR,
  routineResumeOffsetMaxMs: 5 * MIN,
  // MEM-07 / ORIG-06
  dreamEvidencePerBot: 12,
  dreamBots: 64,
  dreamSideChars: 8000,
  dreamDebounceMs: 15_000,
  dreamDeadlineMs: 90_000,
  dreamRetries: 3,
  dreamRetryMinMs: 2000,
  dreamRetryMaxMs: 30_000,
  dreamSweepMs: HOUR,
  dreamSweepBots: 4,
  dreamRefreshMs: 24 * HOUR,
  dreamIdleGateMs: 2 * MIN,
  dreamRecheckMs: MIN,
  dreamMaxChanges: 64,
  dreamContentMax: 300,
  noteExpiryStrength: 0.05,
  // ORIG-11
  followupHeartbeatMs: 30 * MIN,
  followupWindowStartHour: 9,
  followupWindowEndHour: 20,
  followupMaxOpen: 50,
  followupMaxAttempts: 2,
  followupPerBotPerDay: 2,
  followupPerAccountPerDay: 6,
  followupQuietMs: 2 * HOUR,
  followupActiveOwnerMs: 3 * 24 * HOUR,
  followupWhatMax: 200,
  // Fix round 1 finding 2: a heartbeat turn that never calls onSettled (error or lost lease)
  // must not permanently block the Bot from ever being woken again.
  followupPendingTimeoutMs: 10 * MIN,
  // ORIG-15 / TOOL-20
  codingAgentWallClockMs: 5 * HOUR,
  steerAtFraction: 0.9,
  // CHAT-08 voice mode
  voiceSilenceMs: 700,
  // Bug 101: one spoken reply chunk sent to the helper's synthesizer (a Bot SendMessage is far shorter).
  voiceSpeakMaxChars: 8_000,
  // Bug 107: the Kokoro sidecar — the engine probe's budget, how long an idle sidecar lives, a pause
  // between spoken sentences, and how long a sidecar with work may go without a frame before it counts as hung.
  kokoroProbeMs: 3_000,
  kokoroIdleMs: 5 * MIN,
  sentencePauseMs: 120,
  kokoroStallMs: 10_000,
  // Voice-mode restart guard: Apple's recognizer ends a session (and the helper process exits)
  // after a stretch of silence, so voice mode has to bring the helper back. A session that ends
  // within this window having heard nothing counts as a failed start; `voiceRestartCap` of those
  // in a row (e.g. a revoked microphone permission) stops the loop instead of spinning on spawn.
  voiceRestartWindowMs: 1500,
  voiceRestartCap: 5,
  // "sending" is the one state with nothing behind it: the helper has been stopped, so the
  // microphone is off, and the loop used to leave it only on a `send-message` entry of type
  // "text". A reply that is a card/widget/attachment — or a send that failed — left voice mode
  // dead with no way back. The wait is generous (an ordinary Bot turn, including short tool use,
  // is never cut short) but bounded; a reply that arrives after it is still spoken, because
  // onBotText() drains from "listening" as well.
  voiceSendTimeoutMs: 45_000,
  /** Bots on one voice call (the user isn't counted); the host's call registry enforces it. */
  callMaxBots: 6,
  /** A Bot added mid-call gets the call so far: its last turns, about 2k tokens at most. */
  callJoinContextTurns: 16,
  callJoinContextChars: 8_000,
  // Stopping the dictation helper: `stop\n` on stdin first (it flushes a final transcript on a
  // clean stop), then signals, so a wedged helper can never keep the microphone hot.
  dictationStopGraceMs: 2_000,
  dictationKillGraceMs: 2_000,
} as const;
