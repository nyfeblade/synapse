import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GoogleConnState, GoogleReconnectCheckView, GoogleStatusView, Tray } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { GoogleReconnectCheck } from "../../google/reconnect-check";
import { tmpConfig } from "../helpers";

/** 2026-09-28 is a Monday; the check's slot is Mondays 10:00 (UTC here). */
const MON_10 = Date.UTC(2026, 8, 28, 10, 0);
const HOUR = 3_600_000;

describe("the weekly Google sign-in check (unit)", () => {
  let dir: string;
  let now: number;
  let state: GoogleConnState;
  let testing: boolean | null;
  let expireOnProbe: boolean;
  let probes: number;
  let notes: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "grc-")); now = MON_10 - 6 * 24 * HOUR; state = "connected"; testing = true; expireOnProbe = false; probes = 0; notes = 0; });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const make = () => new GoogleReconnectCheck({
    hostPrivate: dir, now: () => now, tz: () => "UTC",
    status: () => ({ state, testing, clientId: "x", email: null, services: [], redirectUri: "", error: null }) as GoogleStatusView,
    probe: async () => { probes++; if (expireOnProbe) state = "needs-reconnect"; },
    notify: () => { notes++; }, setTimer: () => null, clearTimer: () => {},
  });

  it("notifies only when the sign-in needs reconnecting, and only once per expiry", async () => {
    const c = make();
    await c.runOnce();
    expect(probes).toBe(1);
    expect(notes).toBe(0); // fine: nothing sent
    expireOnProbe = true;
    await c.runOnce();
    expect(notes).toBe(1);
    await c.runOnce();
    expect(c.notifyIfNeeded()).toBe(false); // a Bot's failed call right after doesn't send a second one
    expect(notes).toBe(1);
    // Reconnected, then expired again: a new notification.
    state = "connected"; expireOnProbe = false;
    c.onStatus({ state } as GoogleStatusView);
    state = "needs-reconnect";
    expect(c.notifyIfNeeded()).toBe(true);
    expect(notes).toBe(2);
  });

  it("is on by default only while the app is in Testing, and the user's choice wins and is kept", () => {
    expect(make().view()).toMatchObject({ enabled: true, explicit: false, testing: true });
    testing = false;
    expect(make().view()).toMatchObject({ enabled: false, explicit: false });
    testing = null; // no sign-in yet, or nothing says: off
    expect(make().view().enabled).toBe(false);
    make().set(true);
    expect(make().view()).toMatchObject({ enabled: true, explicit: true } satisfies Partial<GoogleReconnectCheckView>);
    testing = true;
    make().set(false);
    expect(make().view()).toMatchObject({ enabled: false, explicit: true });
  });

  it("runs the owed Monday slot once (a sleeping Mac catches up once), and never while off", async () => {
    const c = make();
    now = MON_10 - HOUR;
    await c.tick();
    expect(probes).toBe(0);
    now = MON_10 + 5 * HOUR; // slept through 10:00
    await c.tick();
    await c.tick();
    expect(probes).toBe(1);
    now = MON_10 + 7 * 24 * HOUR + 1;
    testing = false; // production app, default: off
    await c.tick();
    expect(probes).toBe(1);
  });
});

describe("the reconnect check through the host (gateway, FUZZ fake Google)", () => {
  let app: HostApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });
  const fuzz0 = process.env.FUZZ;
  beforeAll(() => { process.env.FUZZ = "1"; });
  afterAll(() => { if (fuzz0 === undefined) delete process.env.FUZZ; else process.env.FUZZ = fuzz0; });

  it("a Testing sign-in turns the check on; it notifies once, with Reconnect and Let a Bot click through, only after expiry", async () => {
    app = await createHostApp(tmpConfig());
    const { port } = await app.listen();
    const api = async <T>(cmd: string, args: unknown = {}): Promise<T> => {
      const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
      const j = (await r.json()) as { ok: boolean; result?: unknown; error: { code: string; message: string } };
      if (!j.ok) throw new Error(`${j.error.code}: ${j.error.message}`);
      return j.result as T;
    };
    const g = app.services.phase5.google;
    expect(await api<GoogleReconnectCheckView>("getGoogleReconnectCheck")).toMatchObject({ enabled: false, testing: null });
    await api("setGoogleClient", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-e2e-secret", inProduction: false });
    const { authorizationUrl } = await api<{ authorizationUrl: string }>("startGoogleAuth");
    await api("completeMcpOAuth", { state: new URL(authorizationUrl).searchParams.get("state")!, code: "fuzz" });
    expect(await api<GoogleReconnectCheckView>("getGoogleReconnectCheck")).toMatchObject({ enabled: true, explicit: false, testing: true });

    const reconnectTrays = async () => (await api<{ trays: Tray[] }>("getTrays")).trays.filter((x) => x.dedupeKey === "google-reconnect");
    await g.reconnect.runOnce();
    expect(await reconnectTrays()).toHaveLength(0);
    g.fake!.state.refreshInvalid = true;
    await g.reconnect.runOnce();
    const t = await reconnectTrays();
    expect(t).toHaveLength(1);
    expect(t[0]!.buttons.map((b) => b.action)).toEqual(["reconnect-google", "reconnect-google-bot"]);
    expect((await api<GoogleStatusView>("getGoogleStatus")).state).toBe("needs-reconnect");

    expect(await api<GoogleReconnectCheckView>("setGoogleReconnectCheck", { enabled: false })).toMatchObject({ enabled: false, explicit: true });
  });
});
