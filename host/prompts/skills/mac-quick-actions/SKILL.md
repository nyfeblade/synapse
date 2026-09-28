---
name: mac-quick-actions
description: Quick recipes for the user's Mac - open an app or file, send an iMessage/SMS, run a Shortcut, use the web. Use when asked to do one of these on "my computer", often on a call.
metadata:
  managed: true
  source: managed
---
All of these run on the user's Mac with ExternalShell (the Mac must be connected). Keep it to one
command where you can: on a call the user is waiting.

## Open an app or a file
- App: `open -a "Calendar"` (the app's name as it appears in /Applications).
- File or folder: `open "/Users/<them>/Documents/Plan.pdf"`; to show it in Finder: `open -R "<path>"`.
- A web page in their default browser: `open "https://example.com"`.

## Send an iMessage or SMS (Messages)
This sends as the user, so it ALWAYS asks them first: the card shows who gets it and the exact text,
and on a call it is read out for a yes or no. Never split the text or send more than was agreed.
1. Know the recipient. If the user gave a full name you can match, look the number up and send in ONE
   command. If there are several people by that name, or only a first name you can't place, ask which one.
2. One command, a heredoc so quotes in the text are safe; keep the text exactly as agreed:
   ```
   osascript <<'EOF'
   tell application "Contacts" to set h to value of first phone of first person whose name is "Sam Lee"
   tell application "Messages" to send "I'm running 10 minutes late" to participant h of (1st account whose service type = iMessage)
   EOF
   ```
   For SMS (a green-bubble contact) use `service type = SMS`. With a known number or email, skip the
   Contacts line: `... to participant "+15551234567" of ...`.
3. If Messages reports an error (no such person, no phone, not signed in), say so plainly; don't retry blindly.

## Run a Shortcut
- `shortcuts list` to see the names; `shortcuts run "Shortcut Name"`; with input:
  `shortcuts run "Shortcut Name" --input-path "<file>"`. Shortcuts that send, buy or post are the user's
  own automations: say what it will do before you run one they didn't name.

## The web
Use the Browser tool (the user's own Chrome, their sign-ins). Read pages with it rather than screenshots.
Submitting, sending, buying or deleting on a site asks the user first. A non-Chrome browser (Edge, Safari,
Firefox…) is driven with MacApp: open the app, then `ui.key` cmd+L, type the URL, Return.

## After
Say what you did in one short line ("Sent to Sam: I'm running 10 minutes late.").
