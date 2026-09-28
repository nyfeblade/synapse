# Phone access

Call your Bots from your phone. It works on any phone with a modern browser (iPhone Safari, Android Chrome) and uses Tailscale's free plan. Nothing is put on the public internet: only devices signed in to *your* tailnet, as *you*, can reach it.

## One-time setup

1. **On the Mac:** Tailscale is installed and signed in (it already is on this Mac).
2. **In Synapse:** Settings → Voice → **Phone access** → turn it on.
   - The first time, Synapse may show **Turn on HTTPS in Tailscale** with an **Open** button. Click it and approve in the Tailscale admin page (this turns on HTTPS certificates / Serve for your tailnet, once). Then turn Phone access on again.
3. **On the phone:** install the Tailscale app and sign in with the **same account** as the Mac.
4. **On the phone:** open the address Settings shows (`https://<your-mac>.<tailnet>.ts.net/`), or scan the QR code.
5. In Settings click **Pair a phone** and type the six-digit code on the phone. The phone stays paired until you revoke it in Settings.
6. **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen). On an iPhone this is needed for call alerts. Then tap **Call alerts → Turn on** in the app.

## Using it

- Tap a Bot to call it. Synapse on the Mac runs the call (same voice, barge-in, turn-taking) — the phone is the microphone and speaker; the Mac stays silent.
- When a Bot calls you while you're away from the Mac, the phone gets a notification; tap it and **Answer**.
- Synapse must be running on the Mac (and the Mac awake) for the phone to reach it.

## How it's protected

- The phone server listens only on a private Unix socket in Synapse's own folder — never a network port; `tailscale serve` puts it on your tailnet with a real HTTPS certificate. Never Funnel.
- If Tailscale can't reach that socket, Phone access stays off and Settings says "Tailscale couldn't reach Synapse's private socket" with a **Retry** button. It never falls back to anything less private.
- The mapping exists only while Synapse runs: it is removed at quit and made again — and checked to reach Synapse itself — at every launch. A mapping left behind by a crash is removed at the next launch (and retried until it is), and only if it is still exactly Synapse's.
- Every request must come through Tailscale *and* be from the Mac's own Tailscale user; anything else gets 403. Tailscale 1.56 or newer is required.
- A paired phone holds an httpOnly, Secure, SameSite=Strict cookie. Nothing secret is ever in a URL.
- If HTTPS port 443 already serves something of your own in Tailscale, Phone access won't turn on (it never touches your own Serve config); turning it off removes only Synapse's mapping.

Evidence of the automated end-to-end checks: `test-reports/tailscale-phone/`.
