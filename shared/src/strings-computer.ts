import { COMPUTER_NAME } from "./strings";

/** "Bots' Computer" — COMPUTER_NAME capitalized for titles (D13). */
export function computerTitle(): string {
  return COMPUTER_NAME.replace(/ computer$/, " Computer");
}

/** Phase 3 copy (CMP-*, SEC-*, SET-13). */
export const STRC = {
  // CMP-06 / S14
  openComputer: "Open computer",
  computerGlyph: "Computer activity",
  // CMP-08 box-help card and banner (Computer.dc.html)
  computer: "Computer",
  boxHelpBadge: "Action needed",
  takeOver: "Take over",
  imDone: "I'm done",
  skip: "Skip",
  needsAttention: "Needs your attention",
  skipThisStep: "Skip this step",
  imDoneContinue: "I'm done, continue",
  youreInControl: "You're in control",
  // Bug 32: the in-control bar's way out of the remote. The key itself is rendered as <kbd> beside it.
  releaseKeyboard: "Release keyboard",
  pausedUntilHandBack: (bot: string) => `${bot} is paused until you hand it back`,
  handedBack: "Handed back",
  skipped: "Skipped",
  viewerClosed: "Closed",
  boxHelpDuplicate: "You already asked the user for help on the computer and they haven't answered yet. Do NOT ask again; end your turn and wait.",
  boxHelpSent: "Asked the user to take over the computer. End your turn now; you'll be woken when they hand it back.",
  // CMP-09, CMP-18 takeover
  inUse: `${computerTitle()}, in use`,
  // UI polish pass: the title bar says Idle while there is no screen, instead of "in use" over a stage
  // that says there is nothing to show.
  idle: "Idle",
  teachTask: "Teach a task",
  openTerminal: "Terminal",
  exitFullscreen: "Exit fullscreen",
  moreScreens: "More screens",
  you: "You",
  connecting: "Connecting to the computer…",
  cantReach: "The computer isn't responding",
  // UI polish pass: one plain line under each stage state, and the elapsed time on a slow connect.
  dialFailedHelp: "The connection didn't come up.",
  stillConnecting: (secs: number) => `Still trying · ${secs} s`,
  // CMP-04, CMP-05
  screensFull: "All of the shared computer's desktop screens are taken. Try again once another Bot is done, or do this without a screen.",
  // Controller ruling 1 (2026-09-19, phase-3-computer): shown on a Bot's screen thumbnail while it's waiting for a seat to free up.
  waitingForScreen: "Waiting for a screen",
  // Bug 36: a blank screen area has to say WHICH of three things happened, because all three used to
  // render as the same empty rectangle. The three headlines are deliberately distinct — the headline
  // is what a user quotes back in a bug report, and telling them apart is what makes bug 3 diagnosable.
  // (1) the getDisplays fetch failed — the only one of the three with an action.
  screenUnreachable: "Can't check for a screen",
  screenUnreachableHelp: "The app couldn't reach the computer.",
  // (2) the host answered and has no display for this Bot. Ordinary, not a failure.
  noScreen: "No screen",
  noScreenHelp: (bot: string) => `${bot} hasn't opened anything on the computer yet.`,
  // (3) every seat on the shared computer is taken (MAX_SCREENS). Also ordinary, and by design.
  waitingForScreenHelp: "Every screen is in use right now.",
  // The preview dialled a screen the host says exists and the connection did not come up.
  previewFailed: "Preview unavailable",
  computerUseBusy: "Another computerUse subagent has the box's desktop right now; only one at a time.",
  stillStarting: "The computer is still getting ready (fetching its image or starting up). Try again shortly.",
  // TOOL-14
  tooManyTasks: "There are already as many background tasks as allowed; wait until one finishes.",
  // CMP-13 connection states
  updatingComputer: "Updating your computer",
  recover: "Recover",
  // CMP-11 banners
  step: {
    getting_ready: "Getting ready", backing_up: "Backing up your data", recreating: "Recreating", starting: "Starting",
    cleaning_up: "Cleaning up", reconnecting: "Reconnecting", wiping: "Wiping your data", creating: "Creating",
  } as Record<string, string>,
  // SET-13 Updates (keeps "assistants")
  updatesNav: "Updates",
  updateTitle: `Update ${computerTitle()}`,
  updateHelp: "Brings the shared computer up to date for all your assistants at once. Files and sign-ins are kept; apps and packages you installed are removed.",
  onLatest: "The computer is up to date",
  update: "Update",
  resetTitle: `Reset ${computerTitle()}`,
  resetHelp: "If the computer gets stuck, start it fresh. It's restored from your most recent snapshot, so the newest changes might not survive.",
  resetButton: "Reset",
  resetConfirm: "Reset now",
  alsoRestoreBots: "Also restore Bots and chats",
  updateWhenDone: "Update once agents finish",
  updateAnyway: "Update anyway",
  backupNotReady: "Backup not ready",
  agentBusy: "Agent busy",
  // Hand-testing round: the deferred update needs a visible, cancellable waiting state.
  waitingForAgents: "Waiting for the agents to finish…",
  resetDone: "Your computer was reset.",
  updateFailed: "The computer couldn't be updated",
  recoverFailed: "The computer couldn't be recovered",
  resetFailed: "The computer couldn't be reset",
  // CMP-15 disk
  diskLow: "The computer is running out of disk space",
  diskCritical: "Computer is critically low on disk space",
  openDiskSaver: "Open Disk Saver",
  diskReminder: "Disk space on the box is nearly used up. Hold off on disk-heavy work (big downloads, builds, caches, recordings), remove files that aren't needed any more, and tell the user if a task needs more room.",
  diskSaverName: "Disk Saver",
  // SEC-02 secret card
  secretPlaceholder: (label: string) => `Paste your ${label}`,
  saveSecurely: "Save securely",
  saved: "Saved",
  savedPrivately: "Saved securely and kept private",
  secretFooter: "Kept encrypted; your Bot never sees it",
  secretNotSaved: "Couldn't save the secret. Please try again.",
  // SEC-03
  filledIntoPage: "Entered on the page. Your Bot never saw the secret values.",
  couldNotFill: "Couldn't enter it on the page",
  // SEC-04 forms
  submit: "Submit",
  formSubmitted: "Sent",
  formNotSubmitted: "The form was not submitted. Try again.",
  // SEC-05 Secrets section
  secrets: "Secrets",
  addSecret: "Add secret",
  saveSecret: "Save secret",
  replace: "Replace",
  replaceValue: "Replace value",
  remove: "Remove",
  noSecrets: "No secrets yet.",
  secretName: "Name",
  secretDescription: "Description (visible to your Bot)",
  secretValue: "Value",
  shortValueWarning: "Short values can't be reliably hidden from your Bot's output.",
  secretTooShort: "Secret values must be at least 4 characters.",
  updatedAgo: (text: string) => `Updated ${text}`,
  // Bug 56: a stored name the Bot's env refuses (saved under older name rules)
  secretUnusable: (reason: string) => `Your Bot can't use this secret. ${reason} Rename it or remove it.`,
  // Bug 57: secrets on the box whose values this Mac doesn't have (new profile, reinstall, new Mac)
  boxOnlyNotice: (n: number) => `This Mac doesn't have the values for ${n} ${n === 1 ? "secret" : "secrets"} this Bot uses. ${n === 1 ? "It stays" : "They stay"} on the computer and ${n === 1 ? "keeps" : "keep"} working. Re-enter a value to manage it from this Mac.`,
  keepOnBox: "Keep them on the computer",
  boxOnlyRow: "On the computer only. This Mac doesn't have its value.",
  reenter: "Re-enter",
  removeFromBox: "Remove from computer",
  rename: "Rename",
  renameSecretAria: (name: string) => `Rename ${name}`,
  newSecretName: "New name",
  renameSecret: "Rename secret",
  // ORIG-12 §12.4
  secretInText: (name: string) => `That text contains the value of secret ${name}. Refer to it as $${name} instead.`,
  // APR-07
  pageChanged: "The page has changed since it was reviewed; take a new browser_snapshot and try the action again.",
  // BRW-03 enforce mode
  needsDescription: "Add a description of what this click or drag is for (Auto-review needs it), then retry.",
};
