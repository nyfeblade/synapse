/** Voice wave 3: the wake word, Bots calling the user, and screen sharing on a call. */
type WakeView = { enabled: boolean; listening: boolean; pausedFor: string[]; error: string | null };

export const STRV = {
  // ---- wake word ----
  wakeWord: "“Hey” + a Bot’s name starts a call",
  wakeWordHelp: "Say “Hey Nova” (any Bot’s name) to call that Bot. Listening happens on this Mac only: nothing is transcribed, sent or kept until it hears a name. The menu bar shows when it’s listening.",
  wakePauseOnBattery: "Pause on battery power",
  wakeStatus(s: WakeView): string {
    if (!s.enabled) return "Off";
    if (s.listening) return "Listening";
    switch (s.pausedFor[0]) {
      case "error": return s.error ?? "Stopped";
      case "user": return "Paused from the menu bar";
      case "locked": return "Paused while the screen is locked";
      case "asleep": return "Paused while the Mac sleeps";
      case "busy": return "Paused during dictation or a call";
      case "waking": return "Starting a call…";
      case "battery": return "Paused on battery power";
      case "bluetooth": return "Paused: listening on a Bluetooth headset would drop it to call quality. Choose another microphone above.";
      case "no-names": return "Paused: no Bots to listen for";
      default: return "Starting…";
    }
  },
  wakeNoBot: (name: string) => `Heard “Hey ${name}”, but no Bot has that name now.`,

  // ---- a Bot calls the user ----
  missedCall: (name: string, reason: string, why?: string) => `Missed call from ${name}: ${reason}${why ? ` (${why})` : ""}`,
  callByMessage: (name: string, reason: string) => `Call from ${name}: ${reason} · you chose to reply by message`,
  callRateLimited: "limit of 3 calls an hour",
  incomingCall: (name: string) => `${name} is calling`,
  acceptCall: "Accept",
  declineCall: "Decline",
  messageInstead: "Message instead",
  firstCallNote: (name: string) => `${name} hasn’t called you before. Accepting lets ${name} call you again.`,
  dontAllowCalls: (name: string) => `Don’t allow calls from ${name}`,
  callsFromBots: "Calls from Bots",
  callsFromBotsHelp: "A Bot can ring you when a long task finishes or it needs a decision: at most 3 calls an hour, never during quiet hours or a Focus. A missed call stays in the chat.",
  quietHours: "Quiet hours",
  quietFrom: "From",
  quietTo: "To",
  mayCall: (name: string) => `${name} may call you`,
  mayCallChoices: { ask: "Ask on first call", yes: "Allowed", no: "Not allowed" },

  // ---- screen share on a call ----
  shareScreen: "Share your screen",
  stopSharing: "Stop sharing your screen",
  sharingScreen: (name: string) => `Sharing your screen: ${name} gets a snapshot when you ask it to look, or when it asks`,
  sharingScreenRoom: "Sharing your screen: the Bots on the call get a snapshot when you ask them to look",
  snapshotSent: "Sent a snapshot",
  snapshotForBot: "(the screen snapshot you asked for)",
  botWantsToLook: (name: string) => `${name} wants to see your screen. Share it to send one snapshot.`,
  screenAccessDenied: "Synapse can't see your screen. Turn on Synapse in System Settings → Privacy & Security → Screen & System Audio Recording, then share again.",
  screenAccessRestricted: "Screen recording is blocked on this Mac (by a profile or Screen Time), so Synapse can't share your screen.",
  screenShareFailed: "Couldn't take a snapshot of your screen, so that turn went without it.",

  // ---- calls that feel like calling teammates (bug 134) ----
  /** Until a Bot has authored its own greetings (or when that fails). */
  stockGreetings: (user: string | null): { text: string; when?: "morning" | "afternoon" | "evening" }[] => [
    { text: "Hello!" },
    { text: user ? `Hey ${user}!` : "Hey there!" },
    { text: "You called?" },
    { text: "What can I do for you?" },
    { text: "How are you today?" },
    { text: "Hi! How's it going?" },
    { text: "Ready to tackle your next project?" },
    { text: "I'd make you breakfast, but I can't." },
    { text: user ? `Hi ${user}, what's up?` : "Hi, what's up?" },
    { text: user ? `Good morning, ${user}!` : "Good morning!", when: "morning" },
    { text: "Did you get your coffee this morning?", when: "morning" },
    { text: "Good afternoon!", when: "afternoon" },
    { text: user ? `Afternoon, ${user}! How's the day?` : "Afternoon! How's the day going?", when: "afternoon" },
    { text: user ? `Good evening, ${user}.` : "Good evening!", when: "evening" },
    { text: "Evening! How was your day?", when: "evening" },
  ],
  /** Said when the first sentence of a reply is slow to come (never over real speech). */
  fillers: ["Hmm, let me check.", "One sec.", "Let me see.", "Okay, give me a second.", "Hmm, let me think.", "Good question, one moment."],
  /**
   * Bug 218: the Bot's short sound the moment the user stops, only when its answer can't start at once (so the
   * line never sounds dead). Chosen by what the user said — a question gets a thinking sound, a request an
   * okay, anything else a listening sound — from a shuffle bag, never the same one twice running. Pre-rendered
   * in each Bot's own voice; never a model call.
   */
  acks: {
    question: ["Hmm.", "Mm.", "Hm, okay.", "Let's see."],
    request: ["Okay.", "Sure.", "Yep.", "Mm-hm.", "Alright."],
    other: ["Mm-hm.", "Mm.", "Yeah.", "Right."],
  },
  /**
   * Bug 223: what the call says when the Bot's voice handed a task over without a word of its own (it called delegate
   * before writing anything). Pre-rendered with the stock lines: no model call, and the turn is never run again.
   */
  delegatedOnIt: "On it.",
  /** After the user talks over the Bot with something short or a question (not every time). */
  sorryLines: ["Sorry, go ahead.", "Oh, sorry, go on.", "Sorry, you first."],
  /** Once a turn, when the work runs long. */
  longTaskLines: ["That'll take a minute, I'll stay on.", "This one takes a minute. I'm still here."],
  /** Hang-up when the call was short or the wrap-up line didn't come in time. */
  goodbyes: ["Okay, talk soon.", "Alright, bye for now.", "Talk later!"],
  // Bug 142: a spoken yes / no to a card read aloud on a call (matched in code, said in the Bot's voice).
  approvalYes: "Okay, going ahead.",
  approvalNo: "Okay, I won't.",
  voicemailText: (user: string | null, bot: string, reason: string) =>
    `${user ? `Hi ${user}` : "Hi"}, it's ${bot}. I tried to call you about this: ${reason.trim().replace(/[.!?…]+$/, "")}. It's in the chat too, so reply whenever you can.`,
  voicemail: (name: string) => `Voicemail from ${name}`,
  playVoicemail: "Play voicemail",
  pauseVoicemail: "Pause voicemail",
  voicemailGone: "This voicemail's audio has expired (kept 30 days); the transcript stays.",
  callSummaryTitle: (length: string) => `Call summary · ${length}`,
  actionItems: "Action items",
  handRaised: (name: string) => `${name} has something to add`,
  goAheadBot: (name: string) => `Go ahead, ${name}`,
  presenceOnCall: "On a call",
  // UI polish pass: one presence vocabulary (Working, On a call, Idle) — the header already said Working.
  presenceBusy: (task: string) => (task ? `Working · ${task}` : "Working"),
  presenceIdle: "Idle",
  /** New-user walk, finding 6: waiting on the user (an approval card), not working. */
  presenceWaiting: "Needs you",
  callBot: (name: string) => `Call ${name}`,
  callSounds: "Call sounds",
  callShortcut: "Call shortcut",
  callShortcutHelp: "Calls the Bot whose chat is open, from anywhere on the Mac.",
  callShortcutTaken: "That shortcut is already used by another app. Try a different one.",
  callShortcutInvalid: "Use at least one of ⌘, ⌥ or ⌃ plus a letter or number.",
  trayCall: "Call…",
  returnToCall: (name: string) => `Return to the call with ${name}`,
  miniCall: "Call in progress",
  wrappingUp: "Wrapping up…",
  noBotCalled: (name: string) => `I couldn't find a Bot called ${name}.`,
  /** Bug 158: said (with the leave sound) whenever a Bot comes off the call — by voice, by the ×, or by another Bot. */
  botLeftCall: (name: string) => `Okay, ${name} has left the call.`,
  pickBotToAdd: "Add which Bot?",
  pickBotToRemove: "Remove which Bot?",
  neverMind: "Never mind",
  keepVoiceReady: "Keep voice ready (uses about 800 MB of memory)",
  keepVoiceReadyHelp: "The natural voice loads shortly after Synapse opens and stays loaded, so every call speaks in it from the first word.",
  shortcutOff: "Off",
  shortcutRecording: "Press the keys…",
  shortcutTurnOff: "Turn off",
  // Bug 165: whisper re-transcribes what you said, in Full mode only. Every number here is measured.
  whisperTitle: "Extra-accurate transcription",
  whisperNoModel: "The speech model hasn’t been downloaded yet, so dictation is using Apple’s transcription. The download is 574 MB and it is kept on this Mac.",
  whisperDownload: "Download",
  whisperDownloadingShort: "Downloading…",
  whisperDownloading: (got: number, total: number) => `Downloading the speech model — ${got} MB of ${total} MB.`,
  whisperReady: "The speech model is ready.",
  whisperFailed: (why: string) => `The speech model couldn’t be downloaded: ${why}. Dictation is using Apple’s transcription meanwhile.`,
  whisperOffline: "no connection",
  whisperNoBuild: "This build of Synapse doesn’t include Whisper, so dictation is using Apple’s transcription.",
  whisperInCalls: "Use extra-accurate transcription in calls too",
  whisperInCallsHelp: (size: string) =>
    `Dictation already uses it: measured, it cuts word errors by about a third and gets every Bot and project name right, for ${size} on disk and about 800 MB of memory while it runs. Calls are left off because it adds around half a second to every turn and rewords half of them, which throws away the head start a call gets from answering before you finish.`,
} as const;
