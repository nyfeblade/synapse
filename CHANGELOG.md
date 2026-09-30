# Changelog

Every version of Synapse. The website's Changelog page is built from this file.
Newest first. A version headed `Unreleased` shows as "in progress".

## 0.1.6 — 2026-09-30

### Any AI provider

- **Run a Bot on OpenAI, Gemini, OpenRouter, Mistral or DeepSeek** with your own API key, or on a model on your Mac with Ollama or LM Studio. A Bot on another provider uses it for chat, tools, subagents and voice calls. Coding agents, and computer and browser helpers, still run on Claude, so they need an Anthropic key.
- **Set up with any of them.** The key step offers every provider, with Anthropic first. Another provider's key is tested before it's saved, and a model on your Mac needs only a Test. With no Anthropic key, new Bots start on that provider's main model, and Synapse's shared work, like the safety reviewer and reading schedules, runs there too.
- **Consent first.** Nothing goes to a provider until you allow it once, at setup or in Settings → Account, and the consent says what is sent.
- **Your keys stay on your Mac.** They're encrypted, and only Synapse's own proxy adds them to a request. Your Bots never see them.
- **The model picker shows measured badges.** A model outside Claude earns Experimental or Supported only by passing checks run on it; every one starts as Not checked. The picker also shows what 100 turns like your Bot's recent ones would cost.
- **OpenRouter's whole model list,** searchable in the picker with live prices.
- **The safety reviewer is ask-only until it qualifies.** With an Anthropic key it runs on Claude, as before. On another provider's model (the default with no Anthropic key, or one you pick), anything the fixed rules don't settle comes to you as a card until the reviewer's model passes the safety check in Settings → Auto-review → Safety reviewer.
- **Web search** runs through OpenAI, Gemini or OpenRouter, so a Bot on DeepSeek, Mistral or a local model has it only when one of those is set up.
- **Experimental:** voice calls on local models, and web search through Gemini.

### Coding plans you already pay for

- **Run a Bot on the GitHub Copilot, Cursor, Kimi Code or Mistral Vibe CLI,** signed in with your own account, over the Agent Client Protocol. Experimental: none has passed a live check with a real sign-in yet. Every file change and command goes through Synapse's safety gate first. Not yet on these Bots: voice calls, web search, images, subagents, Synapse's coding agents, and choosing the vendor's model (the CLI uses its own default).
- **Install from Settings.** GitHub Copilot and Kimi Code install from Settings → Account → Coding CLIs at a fixed version, checked against the checksum npm publishes. Cursor and Mistral Vibe can't be installed from Synapse yet.

### Feedback

- **Copy link** on each conversation in Your feedback. Open the link on any device to see replies, so you keep the conversation if you reinstall or switch Macs.

## 0.1.5 — 2026-09-30

### Faster and smoother

- **Faster setup.** On an Apple silicon Mac, a new install downloads a ready-made Bots' computer (about 660 MB), checks its fingerprint, and is usually ready in about a minute instead of about three. If the download isn't available, it builds one from scratch as before.
- **Long chats stay fast.** In a 100-message chat, replies and approvals show in under 100 ms, close to a short chat (before, up to half a second).
- **The chat moves smoothly.** Sending quickly, replies landing and typing turning into text no longer jump.
- **Calls are timed.** Settings → Voice shows your last call's reply time, and replies start sooner when you pause mid-thought.

### Know what your Bots did

- **Activity.** Settings → Activity lists everything a Bot did on your Mac, what allowed it, and when. File contents are never recorded, and secrets are redacted.
- **Undo.** A Bot's file edits in your home folder can be undone from Activity for 7 days. It won't overwrite a file you've changed since.
- **Dry run.** Per Bot, for the next task or always: the Bot says what it would do on your Mac and changes nothing there. Work in the Bots' computer and connected apps still runs.
- **A live spend meter** in the header, and a Bot that keeps failing at the same step stops and asks you, with what it spent.
- **Work finished** notifications, and connections that say when they break, with a Fix button. The Bot is told too, so it doesn't keep trying.

### Reach your Bots anywhere

- **Telegram.** Chat with your Bots and approve their actions from your phone. Off until you connect your own Telegram bot; only you can use it.
- **Email in.** Turn it on for a Bot, then forward an email to your Gmail address plus the Bot's name (like you+scout@gmail.com) to give it a task. Only mail you sent yourself counts, and the forwarded part is never treated as your words.
- **More than one account per app.** Connect a work and a personal Gmail, choose which Bots may use each, and approval cards say which account the Bot will act on.

### Safety you can check

- **Security tests anyone can run.** `npm run security-suite` tries 57 attacks with no AI and no key. Every one is stopped, and the results for each release are published with it.

## 0.1.4 — 2026-09-30

### Approvals

- **Approve a whole plan once.** When a Bot lays out several steps, one card covers them for that task. A step outside the plan still asks, and payments and deletions always do.
- **Trusted people.** Emails and calendar invites to just you skip the card. So do ones you ask for that go only to people you add in Settings → Auto-review → Trusted people. Your own ask-first rules still win, and a message that copies something from an email or web page still asks.
- **Approve or Deny right from the notification.**
- **Full auto now asks before sends, payments and deletes from any tool server it doesn't know,** judged by the tool's name, description and who it reaches.

### Use your Bots from other apps

- **Synapse's own MCP server.** Claude Desktop, Claude Code and Cursor can list your Bots, ask one something, hand it a task and check the result. It's off by default and uses no network port. You approve each app once, can revoke it any time, and every call is logged in Settings → System → MCP access.
- **Nothing another app sends counts as your own words.** Risky actions still ask you in Synapse, and another app can never approve anything.

### First run

- **The Bots' browser works on a brand-new Bots' computer.**
- **Setup never sits at 0%.** Start says why it's waiting, and Retry works.
- **Setup and box checks never hang on a stuck OrbStack call.** Each call has a time limit, and setup offers Retry.
- **The chat no longer freezes** while a Bot searches your Mac.
- **No more disk writes every second** while idle.
- **Stop works on coding agents,** and finished ones never stay on "Working".
- **Speech only goes to Apple's servers after you say so,** on Macs that can't recognise speech on-device.
- **Calls leave the ring to macOS** when Synapse can't tell whether Focus is on, so Focus decides. **Routines follow your time zone** when it changes.

### Network

- **Local network switch** in Settings → Computer → Network. Off by default. When it's on, Bots can reach devices on your home network, but never your Mac itself.
- **If anything changes the Bots' network guard behind the app,** Bots pause and your setting is put back.
- **Bots can't run OrbStack, Docker or other container tools on your Mac.** A script that only mentions one asks you first.

### Safety

- **The safety reviewer always reads the whole of what it judges.** Messages between Bots and from other apps are sized to fit, room reviews read the newest posts, and anything too long to read in full asks you instead.
- **A Bot's name can't pass it off as you** in a group room.
- **Huge commands can't slow down or slip past the Mac check.** Every check runs fast on any input, and a command too big to judge fully always asks you.
- **Ask is never looser than Full auto.** Anything Full auto would ask about, Ask and Auto-accept edits ask about too.
- **Uploads and download-and-run always ask,** in every mode, including uploads to cloud storage and a download that's unpacked and run in one go.
- **A send to someone Synapse can't identify always asks,** even inside an approved plan or to trusted people.
- **Writes are judged by where they really land,** so a shortcut inside a project can't reach a file outside it.
- **Auto-accept edits asks before changing git hooks, key files or credentials** in a project.

### Feedback

- **Deleted feedback is gone for good,** screenshot included, and the sender's link says the conversation was deleted.

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
