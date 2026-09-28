const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const H = 3_600_000;

/**
 * Phase 3 constants (spec §5.1–5.3, CMP-*, BRW-*, TOOL-11…14, ORIG-12, ORIG-15).
 *
 * `maxScreens` is 3, not the spec's default ceiling of 12 (pre-flight ruling MAX_SCREENS=3,
 * .superpowers/sdd/preflight-phase-3.md): the T1 spike measured ~1.4–1.7 GB per screen on a
 * 16 GB/9-vCPU box (Xvfb + xfwm4 + picom + plank + one Chromium tab), giving a computed
 * MAX_SCREENS_RECOMMENDED of 3 (docs/spec/phase3-spike-findings.md, S3-10). 12 would be
 * RAM-bound and unsafe as a default.
 */
export const LIMITSC = {
  // CMP-04 screens
  maxScreens: 3,
  firstDisplay: 2,
  primaryDisplay: 1,
  displayWidth: 1280,
  displayHeight: 800,
  cdpBase: 9222,
  displayIdleStopMs: 30 * 60_000,
  // Controller ruling (2026-09-19, phase-3-computer, ruling 1): a Bot's screen ASSIGNMENT (not just its X
  // server) is released after this long continuously idle — no running turn, no takeover, no open preview
  // or computer view, no pending box-help — so a 4th Bot can reclaim it instead of always seeing "screens full".
  screenIdleMs: 15 * 60_000,
  // BRW-03 Computer tool
  thenMax: 9,
  textMax: 2000,
  keyMax: 256,
  pathMaxPoints: 64,
  descriptionMax: 500,
  settleMs: 2000,
  waitMaxMs: 10_000,
  scrollAmountMax: 20,
  // BRW-04/05 browser
  snapshotNodes: 400,
  snapshotDepth: 20,
  browserActionMs: 10_000,
  navigateMs: 25_000,
  cdpOutputCap: 20_000,
  // TOOL-06 per-call timeouts for host tools
  perCallTimeoutMs: 14 * 60_000,
  computerUseCallTimeoutMs: 59 * 60_000,
  // TOOL-11/12 shells
  shellDefaultBlockMs: 30_000,
  shellNotifyDebounceMinMs: 5000,
  shellOutputReturnChars: 30_000,
  rewatchEveryMs: 10_000,
  rewatchMaxMs: 5 * H,
  pendingWakeMaxAgeMs: 48 * H,
  revivalBatchMs: 1000,
  // TOOL-13/14, ORIG-15 children
  childrenPerBot: 4,
  childrenTotal: 12,
  computerChildrenPerBot: 1,
  subagentWallClockMs: 2 * H,
  subagentSteerAt: 0.9,
  taskTitleMax: 80,
  checkLastActions: 24,
  // ORIG-12 / §5.1 secrets
  secretsPerBot: 100,
  secretValueMax: 32_768,
  secretsTotalMax: 98_304,
  secretMinChars: 4,
  secretWarnBelow: 8,
  secretLabelMax: 120,
  secretDescriptionMax: 400,
  // CMP-15 disk
  diskPollMs: 60_000,
  diskHardBytes: 2 * GiB,
  diskHardPct: 5,
  diskHardExitBytes: 3 * GiB,
  diskHardExitPct: 8,
  diskSoftBytes: 8 * GiB,
  diskSoftPct: 15,
  diskSoftExitBytes: 10 * GiB,
  diskSoftExitPct: 20,
  // CMP-12 snapshots
  snapshotEveryMs: 2 * H,
  snapshotKeep: 5,
  snapshotChunkBytes: 4 * MiB,
  // CMP-06/07/09 preview and takeover
  previewWarmMax: 3,
  /** Headless: a warm preview nobody shows closes after this (its open socket kept the box encoding and the screen from idle reclaim). */
  previewWarmIdleMs: 60_000,
  previewStatusTimeoutMs: 15_000,
  previewCrashLimit: 3,
  previewCrashWindowMs: 60_000,
  cursorPressDelayMs: 500,
  glyphActiveMs: 5000,
  clipboardPollMs: 500,
  monitorsShown: 3,
} as const;
