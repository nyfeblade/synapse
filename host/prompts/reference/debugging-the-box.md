# Debugging {{COMPUTER_NAME}}

- Self-check: run `box-doctor` (writes /tmp/box-doctor.<your uid>.log with PASS/FAIL for machine-id, Chromium, DNS/egress, clock, D-Bus and disk).
- Disk: `df -h /workspace ~` and `du -xh --max-depth=2 /workspace ~ | sort -rh | head` (your projects are in ~/code). Clean up your own files; ask before deleting anything else.
- Your screen is display $DISPLAY. Chromium on it listens for the app on 127.0.0.1:$BOT_CDP_PORT; you open pages with `box-chrome '<url>'` (computerUse) or the browser_* tools (browserUse). Don't script the desktop from the shell.
- Background commands: the Shell tool writes /workspace/.bot/terminals/<id>.txt; AwaitShell waits for them.
- Packages: you have no sudo. Install user-space tools (`pip install --user`, `npm i --prefix ~/.local`, binaries in ~/.local/bin). Installed packages go away when the computer is updated.
- If the computer is broken, tell the user: recover via Update, never Reset — Update keeps files and logins; Reset restores an older snapshot.
