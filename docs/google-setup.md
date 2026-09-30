# Connect Google (Gmail, Calendar, Drive)

Synapse connects to Google with **your own** Google Cloud OAuth client. Nothing goes through a third party, and it doesn't depend on your Claude login. Your client secret and your Google tokens stay on the host; Bots never see them.

Open **Settings → Connected accounts → Google → Set up** (or Marketplace → Gmail). The sheet walks you through six steps. Each one has an **Open in browser** button for the exact Google Cloud console page, a **Copy** button for every value you type, and a check. It's free, and it takes about 5 minutes.

You can do it yourself, or let a Bot do most of it.

## Do it yourself (about 5 minutes)

1. **Create a project**
   Open in browser → name it `Synapse` → Create. Optional: paste its project ID into the sheet, and every later link opens straight in that project. Without it, Google shows its own project picker.
2. **Enable the Gmail, Calendar and Drive APIs**
   One page enables all three. Pick the project if Google asks, then Next → Enable.
3. **Consent screen: External, app name, scopes, your email**
   Branding: app name `Synapse`, your email as the support and developer contact, audience **External**. Scopes: Add or remove scopes → Manually add → paste the list below (the sheet's **All scopes** copies it in one go) → Update → Save.
4. **Publishing status: In production**
   Audience → **Publish app** → Confirm. See [Why "In production"](#why-in-production).
5. **Create the Desktop OAuth client**
   Clients → Create client → Application type **Desktop app** → name `Synapse Desktop` → Create. The dialog shows the Client ID and the Client secret.
6. **Paste the Client ID and secret, then Connect**
   Paste both into the sheet → Connect. Your browser opens Google's sign-in. Google says it hasn't verified this app: choose **Continue** (it's your own app). Then click **Allow**. The sheet shows the account as connected.

Last, turn on Google for each Bot that should use it (Bot settings → Google). It's off by default.

**Scopes to add in step 3:**

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive.file`

**Redirect URI:** a Desktop app client accepts the loopback address without registering it. If Google asks for one, use `http://127.0.0.1:47823/mcp/oauth/callback`.

## Let a Bot do most of it

In the sheet, choose **Let a Bot do it**, pick a Bot and press Start. By default it's the first Bot that may use the browser on your Mac; if none may, the sheet offers to turn it on for the Bot you pick.

The Bot works in the Synapse browser window on your Mac, where you're already signed in to Google, and does steps 1–5. Every change to your Google Cloud project shows an approval card that says what it changes, such as "Turn on the Gmail, Calendar and Drive APIs in your Google Cloud project" or "Set the app's publishing status to In production". You can stop it at any time from the window's bar or the sheet.

When the client is created, the Bot saves it to Synapse without seeing it. Synapse reads the Client ID and the Client secret off the page on the host, only from Google Cloud's own client pages, only when both are on the same page, and never from a field anything could have typed into. The Bot only ever sees `[google-client-id]` and `[secret:GOOGLE_CLIENT_SECRET]`, and it can't type either shape anywhere. Saving always asks you first, with a card that names the Client ID: check that it matches the one in your console. If Google is already connected, the card says the new client replaces it. Screenshots are off while the task runs, because the page can show the secret. The values never appear in the chat, the transcript or the logs.

Then you click **Connect** and **Allow**, as in step 6.

## What always stays with you

These rules are in Synapse's code, not only in the Bot's instructions:

- **Passwords.** A Bot never types a password. If Google asks you to sign in, the Bot stops and asks you to.
- **Google's sign-in pages.** A Bot can't click, type or press keys anywhere in Google's sign-in and consent flow: not the account chooser, not Allow. The one exception is the unverified-app warning's link. The Mac's browser refuses the rest in every mode, with or without an approval, and the Mac apps tool can't drive a browser at all. The sheet says "Click Allow in your browser".
- **The client secret.** It goes from the page to the host's encrypted store. It never passes through the chat.
- **Your approval.** Each change the Bot makes in the Google Cloud console waits for your OK.

## Why "In production"

When an app's publishing status is **Testing**, Google lets its sign-ins last only 7 days. After that, Bots lose Gmail, Calendar and Drive until you reconnect. Setting the status to **In production** removes that limit.

For your own personal use there's no review. Google shows the "hasn't verified this app" warning once, when you connect, and you choose Continue. Only you use the app, and it's your own client.

With Google Workspace you can set the audience to **Internal** instead. Internal apps don't expire either.

## Reconnect

If Google stops accepting the sign-in (for example, the app is still in Testing), Synapse shows one **Reconnect Google** notification. Click it and approve again, or choose **Let a Bot click through**. The Bot can get past the unverified-app warning; choosing the account, signing in and Allow stay with you.

**Settings → Connected accounts → Weekly Google sign-in check** checks the sign-in once a week and sends that notification when it has expired. It's on by default only while your app is in Testing. Synapse can tell because Google marks a Testing app's sign-in as expiring. You can turn it on or off either way.

## What Bots can do with it

- Read and search mail, read events, search and read Drive files: no approval needed.
- Send mail, save a draft to anyone but you, add/change/delete calendar events, upload a file to Drive: asks you first with an approval card, even when Auto-review is off.
- In **Full auto**, what you directly asked for in your own latest message runs without a card: the email you told it to send to the person you named, or the event you asked it to add. Adding an event with no guests doesn't ask at all; inviting guests counts as messaging them, so it runs without a card only when you asked to invite them. It still asks before deleting, paying, messaging or inviting anyone you didn't ask it to, acting on more than 5 people or items at once, or anything an email, web page, routine, webhook or another Bot asked for. Replacing a connected Google client always asks.
- Only Bots you turned Google on for (Bot Settings → Google) get these tools. It's off by default.

## Disconnect

Settings → Connected accounts → Google → Manage → Disconnect. Synapse revokes its access at Google and deletes its copy of the tokens. You can also remove access at myaccount.google.com → Security → Third-party access.
