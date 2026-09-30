# Connect apps with Composio

Composio connects Gmail, Google Calendar, Google Drive, Slack, GitHub, Notion and Linear in one click each. You don't need a Google Cloud project; each app signs in through Composio's own verified app. You create **your own** Composio key once. Synapse never ships, shares or falls back to a built-in key.

## 1. Create your key (once)

Settings → General → Connected accounts → Composio → **Set up**:

1. **Open Composio.** This opens the Composio dashboard (platform.composio.dev) in your browser.
2. **Create a key.** Sign in or create a free account, then go to Settings → API Keys, create a new key and copy it.
3. **Paste the key.** Press **Paste key**. Electron's main process reads the clipboard only on that click and hands the key to the host. The app window never holds it.
4. **Check the key.** The host checks the key with Composio's API before saving it.
   - **Key rejected:** Composio didn't accept the key. Copy it again from the dashboard.
   - **Can't reach Composio:** you're offline or Composio is down. Try again later.

The key is sealed in the host's secret store (`hostPrivate/composio/account.json`, AES-256-GCM with the vault subkey `bots/composio/v1`), the same store as the Google account and MCP credentials. It is never kept in the macOS Keychain, and it never appears in transcripts, logs, events or anything a Bot can read.

## 2. Connect Gmail in one click

Marketplace → Gmail → **One click with Composio**. Gmail, Google Calendar and Google Drive appear once each, with two ways to connect: **Connect directly** (your own Google app, the private default; see `google-setup.md`) and **One click with Composio** (marked "Data goes through Composio"). Slack, GitHub, Notion and Linear are under **Apps through Composio**, each with a single **Connect**.

- The first Connect shows one line and asks you to accept it: *"Apps connected through Composio send their data through Composio."* You're asked once.
- Composio's sign-in page opens in your browser. Approve it there.
- The row shows **Waiting for sign-in…** and then **Connected**. If you close the page, press **Reopen**. If sign-in fails or times out after 10 minutes, press **Try again**.

Behind the button, the host:

1. Finds your project's Composio-managed auth config for the app. If there isn't one, it creates one (`POST /api/v3.1/auth_configs`, `use_composio_managed_auth`).
2. Creates a hosted sign-in link (`POST /api/v3.1/connected_accounts/link`).
3. Checks the account every few seconds (`GET /api/v3.1/connected_accounts/{id}`) until it's `ACTIVE`.

## 3. Choose which Bots can use it

A connected app starts **off for every Bot**. After you connect it, its Bot list opens in the Composio sheet with every switch off. Turn it on for the Bots that should use it. You can also use each Bot's settings, which show one switch per connected app.

The host checks the switch again on every call. A Bot you turn off loses the app at its next action, even mid-conversation.

## What always asks

| Kind of tool | Example | What happens |
|---|---|---|
| Reads | `GMAIL_FETCH_EMAILS`, `SLACK_FETCH_CONVERSATION_HISTORY`, `GITHUB_GET_A_REPOSITORY` | Runs without a card |
| Sends or changes | `GMAIL_SEND_EMAIL`, `GOOGLECALENDAR_CREATE_EVENT`, `SLACK_SEND_MESSAGE`, `GITHUB_CREATE_AN_ISSUE` | An approval card, even with Auto-review off. In Full auto, see below |

**Full auto.** A send you directly asked for in your own latest message runs without a card, but only through `GMAIL_SEND_EMAIL`, `GMAIL_REPLY_TO_THREAD`, `SLACK_SEND_MESSAGE`, `SLACK_CHAT_POST_MESSAGE` or `GOOGLECALENDAR_CREATE_EVENT` (for example an email to the person you named). Every other change still asks. It still asks before deleting, paying, messaging or inviting anyone you didn't ask it to, acting on more than 5 people or items at once, or anything an email, web page, routine, webhook or another Bot asked for. The check is in two steps: fixed rules first, then Auto-review compares the action with your message and asks when it isn't a clear match.

A tool counts as a quiet read only if it is on Synapse's fixed read list for that app (for example `GMAIL_FETCH_EMAILS`, `GOOGLECALENDAR_FIND_EVENT`). Every other tool asks, including ones Composio adds later. A Bot can only run tools that are in the app's own tool list.

## Privacy

- Apps connected through Composio send their data through Composio.
- The connection goes from your host straight to Composio's API (`backend.composio.dev`) with your key. There is no Synapse server in between. Every request goes through the host's guarded fetch, which can't reach your Mac or your LAN.
- **Disconnect** removes the connected account from Composio. **Remove key** forgets the key and every connection made with it.

## An existing custom "Composio" MCP server

Earlier versions let you add Composio through **Add custom MCP server**, with the Connect URL and an `x-consumer-api-key` header. That form no longer offers it: naming a server Composio shows **Composio has its own setup** instead. A server you added before keeps working, but Synapse treats every tool on a Composio host like the built-in connector: only the fixed read list is quiet, and every send or change asks. The built-in connector uses the reserved server id `composio_apps`.
