# Changelog

Every version of Synapse. The website's Changelog page is built from this file.
Newest first. A version headed `Unreleased` shows as "in progress".

## 0.1.3 — 2026-09-29

### Safety

- **Bots can no longer reach services running privately on your Mac or on your home network.** The public internet still works. If the Bots' computer's firewall is ever missing, Bots pause until it's back.
- **Tool servers a Bot adds can't be used to reach your Mac or your network either**, even through redirects.
- **Full auto no longer asks about things you just asked for;** it still asks before deleting, paying, messaging people you didn't mention, bulk actions, or anything an email or web page told a Bot to do.
- **Trusting a reset Bots' computer asks you first.** It shows the old and new identity, Cancel is the default, and your key is only sent when you save it again.

### Feedback

- **Send feedback from the app or the website.** Choose Bug, Idea, Something confusing or Love it, and add a screenshot or cleaned-up logs if you like. You see exactly what gets sent before it goes.
- **Replies come back to you.** In the app they appear under Your feedback. On the website, a private link shows the conversation.
- **Keys, emails, card numbers, phone numbers and addresses are hidden** before anything leaves your Mac.
- **👍 / 👎 on replies and finished tasks** stays on your Mac.

### Clearer and calmer

- **One monthly budget**, set in one place. Any other limit you've set is shown plainly.
- **"Needs you"** replaces "Working" while a Bot waits for your approval. **"Stopped by you"** replaces "Failed" when you stop one.
- **Dark mode opens dark**, with no white flash.
- **Setup is simpler:** one heading for the API key, starter Bots in a grid you can go back from, and a Skip button for tools.
- **Approvals fold away** once answered.
- **Export and Import Bot** are in the ⋯ menu and ⌘K. Your own exports aren't flagged as someone else's, and duplicate names get a number.
- **Behind-the-scenes details are hidden** unless you turn on advanced controls.
- **Easier reading:** chat keeps a comfortable width on big windows, and the side panel moves the chat over on small ones instead of covering it.
- **Controls look and work the same everywhere.** One kind of text field and menu, clearer edges and focus, and Cancel always on the left.
- **Money is typed into one field** that formats it for you, like $1,234.50.
- **Settings rows are simpler:** a label with its switch on the same line, and long Bot names fit in the message box.

### Connections

- **Connect Google step by step.** Settings shows each step with a button that opens the right Google page and Copy buttons for every value, including the step that stops Google asking you to sign in again every week.
- **Or let a Bot do most of it.** It works in your own signed-in browser and asks before each change. It never types your password, never sees your client secret, and can never click Google's final Allow for you.
- **A weekly check** tells you when Google needs you to sign in again, with one notification.
- **Connect apps through Composio in one click** after adding your own Composio key once. Gmail, Calendar, Drive, Slack, GitHub, Notion and Linear each get a Connect button, and you choose which Bots can use each app. A one-time note says the data goes through Composio.
- **Anything a connected app would send or change asks first**, outside Full auto, even with Auto-review off. That covers Composio, older custom connectors and any tool server.
- **Bots can't click or type in web pages through Mac control.** Web pages are only used through the browser tool, which checks where it is.

### Share Bots

- **Share a Bot with a link.** Copy link from the Bot's menu or the Share sheet. Keys and emails are removed, and memories, routines and your name never leave. A Bot too big for a link can be saved as a .botpack file.
- **Adding a shared Bot is safe by default.** You see what it is before adding it, it asks before acting, and its skills stay with it and never reach your other Bots.
- **Paste a Bot link at the end of setup** to start with a Bot someone sent you.
- **New Bots page on the website** with ready-made Bots to add in one click. A Bot link opened without Synapse installed is kept for you while you download it.

### Website

- **Privacy Policy and Terms of Use pages.**

### Licence

- **Synapse is now licensed under Apache-2.0 (versions up to 0.1.2 remain MIT).**

## 0.1.2 — 2026-09-29

- **Updates are always checked.** Synapse looks for a new version by itself and shows it when there is one. The Automatic Updates switch now only decides whether it's downloaded for you; it's on unless you turned it off.
- **Good updates stay installed.** A new version counts as working once its window opens, so a slow Bots' computer no longer makes Synapse go back to the old one.
- **A version that fails to start isn't offered again.** Synapse goes back to the working one, keeps saying why, and waits for a newer version.
- **Coding agents start from the latest code.** They branch from the repo's current default branch and keep your unpushed commits. Offline, they start from the last download and say how old it is.
- **Moving a file to the Trash asks first**, like any other delete, however the path is written.
- **Mac control handles unusual file names and inputs safely.** Adding a Finder tag keeps the file's other tags.
- **Editing a file on your Mac keeps `$` signs as written.**
- **No more settings that do nothing.** The security key switch, the Update Track menu and the placeholder Terms link are gone.
- **The docs are up to date** on running Synapse in two macOS accounts and on how updates work.

## 0.1.1 — 2026-09-29

- **Synapse in two macOS accounts on one Mac.** Each account gets its own connection to its own Bots' computer, and Synapse tells you clearly if it ever reaches another account's instead.
- **Sign-in never fails silently.** If adding, replacing or checking your API key fails, Synapse says what went wrong.
- **Your connection key stays yours.** Before Synapse sends its key to the Bots' computer, that computer has to prove it's yours, so another account on the same Mac can never pick it up.
- **Key changes happen in order.** Saving, testing and removing your API key run one at a time, so a slow save can't undo a removal.
- **Long jobs aren't cut off.** Restoring a backup or importing no longer stops after five minutes.

### Updating from 0.1.0

- The Bots' computer updates itself once, automatically, the first time 0.1.1 opens. If a Bot is mid-reply in a second macOS account at that moment, it may be interrupted once.

## 0.1.0 — 2026-09-28 — beta

The first public release.

### Bots

- A team of Bots, each with its own name, look, instructions, memory and skills, sharing a sandboxed Linux computer.
- Multi-step tasks with every step visible: files, commands, the web and the accounts you connect.
- Code work on its own branch in a separate copy of the repo, with tests run and a branch or pull request handed back.
- Voice calls, with speech transcribed and the voice generated on your Mac.
- Scheduled and triggered work.

### Your Mac and safety

- Bots use your Mac's apps and screen in a sandbox, and ask before anything risky: Allow once, Always allow or Deny.
- Secrets are sealed on your Mac with the app's own key, so there are no Keychain password prompts.
- Every model call is metered, and budgets pause or ask before a Bot overspends.

### Setup and updates

- Guided first run: OrbStack, the Bots' computer, your Anthropic API key, a short tour and your first Bot.
- The API key check tells you whether your key works, which models it can use, and whether web search is on.
- Signed updates: every update is verified before it's installed.
- The launch snap: two halves of a Bot click together as Synapse opens. You can turn it off in Settings → General.

### Known issues

- Running Synapse in two macOS accounts on one Mac at the same time doesn't work yet (fixed in 0.1.1).
- Synapse isn't notarized by Apple, so macOS asks once when you first open it.
