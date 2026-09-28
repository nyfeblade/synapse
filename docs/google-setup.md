# Connect Google (Gmail, Calendar, Drive)

Bots connects to Google with **your own** Google Cloud OAuth client. Nothing goes through a third party, and it doesn't depend on your Claude login. Your client secret and your Google tokens stay on the host; Bots never see them.

These steps are for a personal Gmail account. They take about 10 minutes and cost nothing.

1. Go to console.cloud.google.com and create a project (free).
2. APIs & Services → Library: enable Gmail API, Google Calendar API, Google Drive API.
3. OAuth consent screen: User type External (or Internal if you have Google Workspace; then no weekly re-sign-in). App name "Bots", your email as support/developer contact. Add the scopes listed below. Add yourself under Test users. Leave it in Testing.
4. Credentials → Create credentials → OAuth client ID → Application type "Desktop app" → Create → copy the Client ID and Client secret.
5. In Bots: Marketplace → Gmail (or Settings → Connected accounts → Google) → paste both → Connect → approve in the browser. Google will warn that the app isn't verified: choose Continue (it's your own app).
6. In each Bot's settings, turn on Google for the Bots that should use it.

**Scopes to add in step 3:**

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive.file`

**Redirect URI:** a Desktop app client accepts the loopback address without registering it. If Google asks for one, use `http://127.0.0.1:47823/mcp/oauth/callback`.

> **Note:** apps left in Testing need a re-sign-in about every 7 days. When that happens, Bots shows a "Reconnect Google" notification; click it and approve again. With Google Workspace and User type Internal, this doesn't happen.

## What Bots can do with it

- Read and search mail, read events, search and read Drive files: no approval needed.
- Send mail, save a draft to anyone but you, add/change/delete calendar events, upload a file to Drive: **always** asks you first with an approval card, even when Auto-review is off.
- Only Bots you turned Google on for (Bot Settings → Google) get these tools. It's off by default.

## Disconnect

Settings → Connected accounts → Google → Manage → Disconnect. Bots revokes its access at Google and deletes its copy of the tokens. You can also remove access at myaccount.google.com → Security → Third-party access.
