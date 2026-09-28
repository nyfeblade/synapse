import { describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { HostSettingsStore } from "../../store/host-settings";
import { applyWebhookLanRebind, webhookLanWatcher } from "../../triggers/webhook-rebind";

describe("webhook LAN re-bind is honest (bug 52)", () => {
  it("keeps the new setting when the listener actually moves", async () => {
    let lan = false;
    const ok = await applyWebhookLanRebind({
      previousLan: false,
      rebind: async () => { lan = true; },
      revert: (v) => { lan = v; },
    });
    expect(ok).toBe(true);
    expect(lan).toBe(true);
  });

  it("rolls the setting back when the re-bind fails, so the switch cannot show ON for 127.0.0.1", async () => {
    let lan = true;
    const notes: unknown[] = [];
    const ok = await applyWebhookLanRebind({
      previousLan: false,
      rebind: async () => { throw new Error("EADDRINUSE"); },
      revert: (v) => { lan = v; },
      notify: (e) => notes.push(e),
    });
    expect(ok).toBe(false);
    expect(lan).toBe(false);
    expect(String(notes[0])).toContain("EADDRINUSE");
  });
});

describe("turning on 'Reachable on your local network' when that address will not bind (bug 52, a real listener)", () => {
  // The instance: phase4 closes the listener, then binds the address the new setting names. When that
  // bind fails the setting is put back — but the listener was already closed, so the switch reads OFF
  // ("accepted from this computer only") while nothing at all is listening, and the row says nothing.
  async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lan-rebind-"));
    const settings = new HostSettingsStore(path.join(dir, "settings.json"));
    const server = http.createServer((_q, r) => { r.end("ok"); });
    const s = { settings, server, port: 0, lanHost: "192.0.2.1" }; // TEST-NET-1: never local, so the bind fails as a real one can
    const listen = () => new Promise<number>((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      server.once("error", onError);
      server.listen(s.port, settings.get().webhookLan ? s.lanHost : "127.0.0.1", () => {
        server.off("error", onError);
        s.port = (server.address() as AddressInfo).port;
        resolve(s.port);
      });
    });
    const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await listen();
    const watch = webhookLanWatcher({
      lan: () => settings.get().webhookLan, listen, close,
      revert: (v) => { settings.update({ webhookLan: v }); },
      setError: (m) => settings.setWebhookLanError(m),
    });
    const get = () => fetch(`http://127.0.0.1:${s.port}/`).then((x) => x.text(), (e) => `unreachable: ${String(e)}`);
    return { ...s, s, watch, get, close };
  }

  it("keeps accepting webhooks from this computer, and the row says why the switch went back off", async () => {
    const t = await setup();
    try {
      t.settings.update({ webhookLan: true });
      await t.watch.changed();
      const view = t.settings.view();
      expect(view.webhookLan, "the switch must not claim a binding the host does not have").toBe(false);
      expect(await t.get(), "the failed re-bind left NO listener: every webhook, local ones included, is refused").toBe("ok");
      expect(view.webhookLanError, "the switch flipped back with no word of why").toMatch(/local network/i);
      expect(view.webhookLanError).toMatch(/EADDRNOTAVAIL/);
    } finally {
      if (t.server.listening) await t.close();
    }
  });

  it("trying again once the address binds turns it on and clears the message (must not stick)", async () => {
    const t = await setup();
    try {
      t.settings.update({ webhookLan: true });
      await t.watch.changed();
      expect(t.settings.view().webhookLanError).toBeTruthy();
      t.s.lanHost = "127.0.0.1"; // whatever was in the way is gone
      t.settings.update({ webhookLan: true });
      await t.watch.changed();
      expect(t.settings.view()).toMatchObject({ webhookLan: true, webhookLanError: null });
      expect(await t.get()).toBe("ok");
    } finally {
      if (t.server.listening) await t.close();
    }
  });

  it("a switch that binds is left ON, with no message (must not fire)", async () => {
    const settings = new HostSettingsStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lan-ok-")), "settings.json"));
    let binds = 0;
    const watch = webhookLanWatcher({
      lan: () => settings.get().webhookLan, listen: async () => { binds++; }, close: async () => {},
      revert: (v) => { settings.update({ webhookLan: v }); }, setError: (m) => settings.setWebhookLanError(m),
    });
    settings.update({ webhookLan: true });
    await watch.changed();
    expect(settings.view()).toMatchObject({ webhookLan: true, webhookLanError: null });
    expect(binds).toBe(1);
  });
});
