import { SHARE_MESSAGES } from "./bot-share.js";

/** Bot sharing: the Share sheet, the Import sheet's additions and the link's one calm line per failure. Labels only. */
export const STRSH = {
  shareBot: "Share Bot…",
  copyLink: "Copy link",
  copied: "Copied",
  shareMenu: "Share…",
  neverIncluded: "Never included: memory, chats, keys, accounts.",
  tooBig: SHARE_MESSAGES["too-big"],
  saveBotpack: "Save .botpack",
  instructions: "Instructions",
  skills: "Skills",
  tools: "Tools",
  look: "Look",
  runsCode: "Runs code",
  unusualText: "Unusual text",
  alreadyHave: "You already have this Bot.",
  addACopy: "Add a copy",
  hidden: (what: string) => `${what} hidden`,
  exportForWebsite: "Export for website",
  blurb: "Blurb",
  saveEntry: "Save entry",
  linkNeedsNewer: "This link needs a newer Synapse.",
  update: "Update",
  pasteBotLink: "Paste a Bot link",
  noBotLink: "No Bot link copied.",
  showDeveloperTools: "Show developer tools",
  damaged: SHARE_MESSAGES.damaged,
  /** Any third-party add (a link, the website, a .botpack — including your own from another Mac): Ask mode, no kickstart. */
  addedAsShared: "Added as a shared Bot: asks before acting.",
  previewExpired: "This preview expired. Open the link again.",
} as const;
