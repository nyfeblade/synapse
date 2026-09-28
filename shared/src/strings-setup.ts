/**
 * Portable install: the first-run setup screen. Titles and labels only — no explanatory second lines
 * (the no-subtitles rule); a state word per step says where things are.
 */
export const STR_SETUP = {
  title: "Set up Synapse",
  stepDone: "Done",
  stepDoing: "Working",
  stepNeedsYou: "Needs you",
  stepWaiting: "Waiting",
  stepOptional: "Optional",

  orbstack: "OrbStack",
  getOrbStack: "Get OrbStack",
  startOrbStack: "Start OrbStack",

  computer: "Bots' computer",
  setUp: "Set up",
  retry: "Retry",
  stop: "Stop",
  log: "Log",
  hideLog: "Hide log",

  claude: "Sign in",

  voices: "Voices",
  kokoro: "Kokoro",
  kokoroReady: "Ready",
  kokoroMissing: "Missing",
  naturalVoices: "Natural voices",
  clonedVoices: "Cloned voices",
  whisper: "Accurate dictation",
  download: "Download",
  installed: "Installed",
  downloading: "Downloading",

  phone: "Phone access",
  open: "Open",

  updates: "Updates from GitHub",
  createToken: "Create a token",
  save: "Save",
  saved: "Saved",
  tokenSaved: "Saved",

  // Settings → Updates → the Bots' computer (fix round 1)
  rebuildTitle: "Rebuild the Bots' computer?",
  rebuildLine: "Kept: your Bots, chats, files and settings (backed up first, then put back). Rebuilt: the system and its software.",
  rebuildVerb: "Rebuild the Bots' computer",
  boxUpdating: "Updating the Bots' computer",
  boxUpdateFailed: "The Bots' computer couldn't be updated",

  finish: "Start using Synapse",
  close: "Close",
  settingsRow: "Setup",
  appleSilicon: "Synapse needs a Mac with Apple silicon.",
  freeSpace: (gb: number) => `${gb} GB free · 8 GB needed`,
  size: (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`),
} as const;

/** Where the "Create a token" link goes: a fine-grained token, read-only Contents on the one repo. */
export const GITHUB_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
