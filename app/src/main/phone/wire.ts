import https from "node:https";
import path from "node:path";
import type { NativeHandler } from "../native";
import { Pairing } from "./auth";
import { phoneAssets } from "./assets";
import { PhoneCalls } from "./calls";
import { sendPush, vapidSubject, type Fetch, type PushMessage } from "./push";
import { qrSvg } from "./qr";
import { PhoneServer, type Asset, type PhoneBot } from "./server";
import { PhoneStore, type Sealer } from "./store";
import { isOurTarget, makeTailscale, MAX_SOCKET_PATH, MIN_TAILSCALE_VERSION, phoneUrl, targetString, versionAtLeast, type Tailscale, type TailnetSelf } from "./tailscale";

/** What Settings → Voice → Phone access shows. */
export interface PhoneStatusView {
  /** On AND verified: serve's mapping reaches this listener. */
  enabled: boolean;
  tailscale: { installed: boolean; running: boolean; state: string };
  url: string | null;
  qr: { size: number; path: string } | null;
  devices: { id: string; name: string; createdAt: number; lastSeenAt: number }[];
  pairing: boolean;
  /** Serve / HTTPS isn't enabled for the tailnet yet: this link (the tailnet admin page) does it. */
  enableUrl: string | null;
  error: string | null;
  inCall: boolean;
}

/** Answers `https://<name>/api/probe` through serve: the listener's nonce, or null (unreachable). */
export type Probe = (url: string) => Promise<string | null>;

export const defaultProbe: Probe = (url) => new Promise((resolve) => {
  // A fresh connection every time (no keep-alive pool): the answer must come from the listener now.
  const r = https.get(url, { timeout: 5_000, agent: false }, (res) => {
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => { try { resolve(res.statusCode === 200 ? String((JSON.parse(b) as { probe?: unknown }).probe ?? "") || null : null); } catch { resolve(null); } });
  });
  r.on("timeout", () => r.destroy());
  r.on("error", () => resolve(null));
});

export interface PhoneWireDeps {
  userData: string;
  /** Where the built phone client is (dist/phone). */
  clientDir: string;
  reg(name: string, fn: NativeHandler): void;
  emit(channel: string, payload: unknown): void;
  feed(pcm: Buffer): boolean;
  muteHelper(muted: boolean): void;
  log(line: string): void;
  tailscale?: Tailscale;
  store?: PhoneStore;
  /** The app's sealer, for the VAPID private key. Absent = no call alerts. */
  seal?: Sealer;
  asset?: (p: string) => Asset | null;
  fetch?: Fetch;
  probe?: Probe;
  /** Tests only. */
  allowLoopbackPush?: boolean;
  /** The Unix socket to listen on (default: <userData>/phone/phone.sock). There is no TCP fallback. */
  socketPath?: string | null;
  /** How often a failed "off" is tried again. */
  retryOffMs?: number;
}

const IDENTITY_REFRESH_MS = 60_000;
/** A missing Tailscale CLI stops the off-retries after this many tries (the error shows; the next launch tries again). */
export const MAX_OFF_TRIES_WITHOUT_CLI = 5;

/**
 * Bug 198: Phone access — call your Bots from your phone over your own tailnet. Wires the phone
 * server, the Tailscale mapping, pairing, the call bridge and push notifications to the app.
 *
 * serve points ONLY at a 0600 Unix socket in a 0700 folder of the app's own — never a TCP port, so
 * no other program can take over what `https://<mac>.ts.net` reaches. If this Tailscale can't serve
 * or reach that socket, Phone access stays off and says so; it never downgrades. The mapping's life
 * follows the app's: made at every launch and live only once serve status shows exactly our socket
 * AND a probe through serve returns this listener's nonce; removed at quit. Every path that doesn't
 * go live removes a mapping Synapse left (only if :443's root is still exactly ours); a removal that
 * fails is remembered across restarts and retried. The user's own serve config on :443 makes Phone
 * access refuse to turn on, and is never touched.
 */
export function registerPhone(d: PhoneWireDeps) {
  const store = d.store ?? PhoneStore.in(d.userData, d.seal);
  const ts = d.tailscale ?? makeTailscale();
  const probe = d.probe ?? defaultProbe;
  const pairing = new Pairing();
  let self: TailnetSelf & { installed: boolean } = { installed: false, running: false, dnsName: null, login: null, state: "unknown", version: null };
  let bots: PhoneBot[] = [];
  let enableUrl: string | null = null;
  let error: string | null = null;
  /** The mapping is on and verified to reach this listener. */
  let live = false;
  let refresher: NodeJS.Timeout | null = null;
  const changed = () => d.emit("phone-access", { type: "changed" });
  const socketPath = d.socketPath === undefined ? path.join(d.userData, "phone", "phone.sock") : d.socketPath;
  const socketOk = !!socketPath && Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH;

  const calls = new PhoneCalls({
    toRenderer: (e) => d.emit("phone", e),
    feed: d.feed,
    muteHelper: d.muteHelper,
    log: d.log,
  });

  const server = new PhoneServer({
    store, pairing,
    identity: () => ({ login: self.login, dnsName: self.dnsName }),
    bots: () => bots,
    asset: d.asset ?? phoneAssets(d.clientDir),
    calls: {
      call: (l, b) => { calls.call(l, b); changed(); },
      mic: (l, p) => calls.mic(l, p),
      mute: (l, m) => calls.mute(l, m),
      hangup: (l) => { calls.hangup(l); changed(); },
      closed: (l) => { calls.closed(l); changed(); },
    },
    log: d.log,
    allowLoopbackPush: d.allowLoopbackPush,
  });

  async function refreshIdentity(): Promise<void> {
    self = await ts.status().catch(() => ({ installed: false, running: false, dnsName: null, login: null, state: "unknown", version: null }));
  }

  const ourTarget = (): string | null => (socketOk ? targetString({ socket: socketPath! }) : null);

  /** A bring-up is running: an old removal retry must not touch the mapping it is making. */
  let bringingUp = false;

  /**
   * Remove Synapse's mapping — only if serve's :443 root is still EXACTLY the target Synapse mapped.
   * "done": nothing of ours is left; "retry": couldn't tell / off failed; "no-cli": no Tailscale CLI;
   * "shared": ours shares :443 with the user's own handlers, so it is left (and still tracked);
   * "skipped": a retry found Phone access live or coming up — the mapping is the live one now.
   */
  async function unmap(o: { retry?: boolean } = {}): Promise<"done" | "retry" | "no-cli" | "shared" | "skipped"> {
    if (o.retry && (live || bringingUp)) return "skipped";
    const mapped = store.read().mapped;
    if (!mapped) { if (store.read().offPending) store.write({ offPending: false }); return "done"; }
    if (!ts.cli()) return "no-cli";
    if (!self.dnsName) await refreshIdentity();
    if (!self.dnsName) return "retry";
    const st = await ts.serveStatus(self.dnsName);
    if (!st) return "retry";
    // A retry waits on the CLI at every step: a bring-up may have gone live meanwhile, and its mapping
    // must stay tracked. Checked again right before every write that forgets a mapping.
    const stale = () => o.retry === true && (live || bringingUp);
    if (stale()) return "skipped";
    if (!isOurTarget(st.root, mapped)) { store.write({ mapped: null, offPending: false }); return "done"; }
    if (st.foreign) {
      // `serve --https=443 off` takes the WHOLE port — the user's own handlers too — and this CLI has
      // no documented way to remove only "/" (its help lists no `off` for --set-path). So ours is left
      // in place, still tracked, and Settings asks the user to remove one or the other.
      d.log("phone: the mapping shares :443 with your own serve config; left in place until you remove one");
      store.write({ offPending: true });
      return "shared";
    }
    if (stale()) return "skipped";
    const r = await ts.serveOff();
    if (stale()) return "skipped";
    if (!r.ok) return "retry";
    store.write({ mapped: null, offPending: false });
    return "done";
  }

  // ---- one retry chain for a removal that failed (it survives restarts via store.offPending) ----
  let retryTimer: NodeJS.Timeout | null = null;
  let retrying = false;
  let noCliTries = 0;
  function startRetry(): void {
    if (retryTimer || retrying) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retrying = true;
      void unmap({ retry: true }).catch(() => "retry" as const).then((r) => {
        retrying = false;
        if (r === "skipped") return;
        if (r === "shared") { error = "shared-443"; changed(); return; }
        if (r === "done") {
          noCliTries = 0;
          if (error === "off-failed") error = null;
          d.log("phone: leftover mapping removed");
          changed();
          return;
        }
        if (r === "no-cli" && ++noCliTries >= MAX_OFF_TRIES_WITHOUT_CLI) {
          error = "missing";
          d.log("phone: no Tailscale CLI to remove the mapping with; stopped retrying until the next launch");
          changed();
          return;
        }
        startRetry();
      });
    }, d.retryOffMs ?? 30_000);
    retryTimer.unref?.();
  }

  /**
   * Nothing of ours may stay mapped when not live: remove it now, or remember and keep trying.
   * "shared" (the user's own handlers on :443 too) waits for the user instead — no retry loop.
   */
  async function cleanup(): Promise<"done" | "pending" | "shared"> {
    const r = await unmap().catch(() => "retry" as const);
    if (r === "done" || r === "skipped") return "done";
    if (r === "shared") return "shared";
    store.write({ offPending: true });
    startRetry();
    return "pending";
  }

  /** Every way of not going live ends here: the error, no listener, and no mapping of ours left. */
  async function fail(code: string | null): Promise<false> {
    error = code;
    live = false;
    await server.stop();
    if ((await cleanup()) === "shared") error = "shared-443";
    return false;
  }

  function stopRetry(): void {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  /** Everything "on" needs, at enable and at every launch. True = live. */
  async function bringUp(): Promise<boolean> {
    bringingUp = true;
    stopRetry();
    try { return await bringUpInner(); } finally { bringingUp = false; }
  }

  async function bringUpInner(): Promise<boolean> {
    error = null;
    enableUrl = null;
    live = false;
    await refreshIdentity();
    if (!self.installed) return fail("missing");
    if (!self.running) return fail("stopped");
    if (!self.dnsName || !self.login) return fail("no-name");
    if (!versionAtLeast(self.version, MIN_TAILSCALE_VERSION)) return fail("old");
    const st = await ts.serveStatus(self.dnsName);
    if (!st) return fail("serve-status");
    if (st.funnel) return fail("funnel");
    const mine = (root: string | null) => isOurTarget(root, store.read().mapped) || isOurTarget(root, ourTarget());
    if (st.foreign || (st.root !== null && !mine(st.root))) return fail("port-in-use");
    if (!(await ts.supportsUnix().catch(() => false))) return fail("no-unix");
    if (!socketOk) return fail("socket-path");
    if (server.listening) await server.stop();
    try { await server.startSocket(socketPath!); } catch (e) { return fail((e as { code?: string }).code === "UNSAFE_DIR" ? "unsafe-dir" : "socket"); }
    const target = ourTarget()!;
    const r = await ts.serveOn({ socket: socketPath! });
    if (!r.ok) {
      if (r.needsEnable) enableUrl = r.needsEnable;
      // serve may have taken the port anyway: note it as ours, so the cleanup checks and removes it.
      store.write({ mapped: target });
      return fail(r.needsEnable ? null : r.message ?? "serve-failed");
    }
    store.write({ mapped: target });
    const after = await ts.serveStatus(self.dnsName);
    if (!after || !isOurTarget(after.root, target)) return fail("not-mapped");
    const got = await probe(`https://${self.dnsName}/api/probe`);
    if (got === null) return fail("unreachable");
    if (got !== server.probeNonce) return fail("not-ours");
    live = true;
    stopRetry();
    if (store.read().offPending) store.write({ offPending: false });
    refresher ??= setInterval(() => void refreshIdentity(), IDENTITY_REFRESH_MS);
    refresher.unref?.();
    d.log(`phone: on at ${phoneUrl(self.dnsName)} (unix socket)`);
    return true;
  }

  function status(): PhoneStatusView {
    const s = store.read();
    const url = s.enabled && live ? phoneUrl(self.dnsName) : null;
    return {
      enabled: s.enabled && live,
      tailscale: { installed: self.installed, running: self.running, state: self.state },
      url,
      qr: url ? qrSvg(url) : null,
      devices: s.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt })),
      pairing: pairing.active(),
      enableUrl,
      error,
      inCall: calls.current() !== null,
    };
  }

  async function enable(): Promise<PhoneStatusView> {
    const ok = await bringUp();
    store.write({ enabled: ok });
    changed();
    return status();
  }

  async function disable(): Promise<PhoneStatusView> {
    error = null;
    enableUrl = null;
    live = false;
    calls.endAll("off");
    pairing.cancel();
    await server.stop();
    const c = await cleanup();
    if (c === "pending") error = "off-failed";
    if (c === "shared") error = "shared-443";
    store.write({ enabled: false });
    if (refresher) { clearInterval(refresher); refresher = null; }
    d.log(error === "shared-443" ? "phone: off (the mapping shares :443 with your own serve config; left in place until you remove one)" : error ? "phone: off (the mapping couldn't be removed yet; retrying)" : "phone: off");
    changed();
    return status();
  }

  /**
   * At launch: Phone access that was on is mapped again and verified. Off, but a mapping of ours
   * was left (a crash, a failed removal): it is removed now, and retried until it is.
   */
  async function resume(): Promise<void> {
    const s = store.read();
    if (!s.enabled) {
      await refreshIdentity();
      if (s.mapped || s.offPending) {
        const c = await cleanup();
        if (c !== "done") error = c === "shared" ? "shared-443" : "off-failed";
        changed();
      }
      return;
    }
    const ok = await bringUp();
    if (!ok) d.log(`phone: couldn't come back on at launch (${error ?? enableUrl ?? "?"})`);
    changed();
  }

  /** At quit (synchronous, bounded): our mapping goes with us — only if :443's root is still exactly ours. */
  function quit(): void {
    calls.endAll("quit");
    live = false;
    const mapped = store.read().mapped;
    if (!mapped) return;
    const r = self.dnsName ? ts.serveOffSyncIfOurs(self.dnsName, mapped) : "failed";
    if (r === "failed") { store.write({ offPending: true }); d.log("phone: couldn't remove the mapping at quit; the next launch will"); }
    // The user's own handlers share :443: off would wipe them. Left in place, still tracked.
    else if (r === "shared") { store.write({ offPending: true }); d.log("phone: the mapping shares :443 with your own serve config; left in place at quit"); }
    else store.write({ mapped: null, offPending: false });
  }

  /** A Bot is calling: tell every paired phone (Web Push), unless a phone call is already on. */
  async function ring(botId: string, title: string, body: string): Promise<number> {
    const s = store.read();
    if (!s.enabled || !live || !s.subs.length || calls.current()) return 0;
    const msg: PushMessage = { title: title.slice(0, 80), body: body.slice(0, 160), botId, tag: `call-${botId}` };
    let vapid: { publicKey: string; privateKey: string };
    try { vapid = store.vapid(); } catch (e) { d.log(`phone: no call alerts: ${e instanceof Error ? e.message : String(e)}`); return 0; }
    let sent = 0;
    for (const sub of s.subs) {
      try {
        const r = await sendPush(sub, msg, { vapid, subject: vapidSubject(self.login, self.dnsName), fetch: d.fetch });
        if (r.gone) store.removeSub(sub.endpoint, sub.deviceId);
        if (r.ok) sent++;
        else d.log(`phone: push to ${new URL(sub.endpoint).host} answered ${r.status}`);
      } catch (e) {
        d.log(`phone: push failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return sent;
  }

  d.reg("phone.status", async () => { if (!self.installed || !self.dnsName) await refreshIdentity(); return status(); });
  d.reg("phone.enable", () => enable());
  d.reg("phone.disable", () => disable());
  d.reg("phone.pair.start", () => {
    if (!store.read().enabled || !live) throw new Error("Turn on Phone access first.");
    const p = pairing.start();
    changed();
    return p;
  });
  d.reg("phone.pair.cancel", () => { pairing.cancel(); changed(); return {}; });
  d.reg("phone.devices.revoke", (a: { id?: unknown }) => {
    if (typeof a?.id !== "string") throw new Error("Bad device.");
    if (calls.current()?.deviceId === a.id) calls.endAll("revoked");
    server.closeDevice(a.id);
    const ok = store.revoke(a.id);
    changed();
    return { ok };
  });
  d.reg("phone.bots", (a: { bots?: unknown }) => {
    const list = Array.isArray(a?.bots) ? a.bots : [];
    bots = list.filter((b): b is PhoneBot => !!b && typeof (b as PhoneBot).id === "string" && typeof (b as PhoneBot).name === "string")
      .slice(0, 100)
      .map((b) => ({ id: b.id.slice(0, 80), name: b.name.slice(0, 60), color: typeof b.color === "string" && /^#[0-9a-f]{3,8}$/i.test(b.color) ? b.color : "#FFFFFF", shape: typeof b.shape === "string" ? b.shape.slice(0, 20) : "pebble" }));
    return {};
  });
  d.reg("phone.callEnded", (a: { botId?: unknown; seq?: unknown }) => {
    calls.endedOnMac(typeof a?.botId === "string" ? a.botId : undefined, typeof a?.seq === "number" ? a.seq : undefined);
    changed();
    return {};
  });

  return {
    calls,
    server,
    store,
    pairing,
    resume,
    enable,
    disable,
    quit,
    ring,
    status,
    refreshIdentity,
    isLive: () => live,
    async dispose() { if (refresher) clearInterval(refresher); if (retryTimer) clearTimeout(retryTimer); calls.endAll("quit"); await server.stop(); },
  };
}

export type PhoneWire = ReturnType<typeof registerPhone>;
