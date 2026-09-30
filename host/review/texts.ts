/** Model-facing guard and card texts. */
export const TEXT = {
  /** Smarter approvals: a plan can only be proposed on the owner's own request, in this chat. */
  planNotOwner: "Not asked: a plan can only be approved for something the user asked for in this chat. Ask for each step as usual.",
  planCard: "Approve these steps once for this task.",
  planApprovedResume: "The user approved your plan. Don't propose it again: run its steps now. Calls that match a step need no card; anything else still asks.",
  ownership: "This changes another Bot's standing instructions, so it needs your OK.",
  macFloor: "This touches a protected part of your Mac (keys, passwords, startup items, app data or a network send), so it needs your OK.",
  ownershipShared: "This changes what every Bot is told or can use (instructions, skills, connectors or tools), so it needs your OK.",
  googleWrite: "This acts on your Google account (mail, calendar or Drive), so it needs your OK.",
  mcpChange: "This connector tool sends, changes or deletes something, so it needs your OK.",
  composioWrite: "This sends or changes something in an app you connected through Composio, so it needs your OK.",
  uiAutomation: "Shell can't drive the desktop's UI. For clicks, typing and other on-screen work, use the Computer tool.",
  barrier: "An earlier action is still waiting on Auto-review; nothing else with side effects can start until it is settled.",
  protectedPath: "This path is private to the app and can't be accessed.",
  /** Bug #61: another Bot's private data. The one sanctioned way across is asking that Bot. */
  otherBotPrivate: "This path is private to another Bot (or to the app), so it can't be accessed. To learn what a teammate knows, ask it: SendToAgent kind \"question\". It answers from its own history and memory.",
  background: "Run long or background commands with the Shell tool (block_until_ms: 0 starts it in the background), not Bash.",
  quiescing: "The app is restarting, so this action did NOT run; it was not declined by the user. Stop here; you'll be resumed with your conversation intact, then re-run this action and finish the task.",
  awaiting: "You're already waiting for the user's answer in this turn. End the turn now.",
  maxSteps: "This turn reached the 5,000-step limit. Send the user a short summary with SendMessage and stop.",
  reviewerError: "Auto-review failed while checking this action. It needs a person to look at it.",
  /** Bug 71 (usability ruling): an unbound command is a card in every mode, never a silent run and never a flat deny. */
  unboundCard: "Synapse couldn't see everything this will run: it couldn't read or follow a script or config this command runs, so no review could check it. Approve only if you trust this exact command.",
  unbound: "This review couldn't tie the command to the script it runs: the app couldn't find that script from the working directory. Run it as `cd <absolute project path> && <command>` (or the script by its absolute path).",
  toctou: "What the shell would run changed after it was reviewed. Run the command again to get a fresh review.",
  tooMany: "Several actions are already awaiting approval. Let the user answer those before asking for more.",
  deny: (reason: string) =>
    `Auto-review stopped this action: ${reason}. Don't retry it, and don't reach the same end another way (another paste site, anonymous file host, throwaway transfer link or anything like them). Ask the user how they want to go on.`,
  /** After the user clicks Deny on a card (APR-13, gate L-3). `deny` stays the reviewer-block text. */
  userDeny: "The user declined this action on its approval card, so it did not run. Don't try it again. Ask the user how they'd like to proceed, or continue with the parts of the task that don't depend on it.",
  expired: {
    user_redirect: "The user sent a new message instead of answering this approval request. The action did not run; follow the user's new message.",
    quiesce: "The approval request lapsed when the app restarted. The user did NOT decline it; run the action again if it's still needed.",
    ttl: "The approval request expired without an answer. The action did not run.",
    session_end: "The approval request was cancelled. The action did not run.",
    stopped: "The user pressed Stop, so this action did not run. Don't retry it; wait for the user's next message.",
    settings_change: "The Auto-review settings changed, so this request was cancelled. Re-run the action for a new review.",
  } as Record<string, string>,
  degraded: "Auto-review can't be reached right now, so this action needs your OK.",
  /** Bug 432. */
  wakeUnread: "What woke this Bot is longer than Auto-review can read in full, so this action needs your OK.",
  fallbackReason: "Blocked by Auto-review",
};
