import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { GatewayError } from "../../gateway/errors";
import { DEFAULT_HOST_SETTINGS, HostSettingsStore } from "../../store/host-settings";
import { tmpConfig } from "../helpers";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

/** The user-reported failure: "I can't even turn it into light mode." These pin the whole
 * settings round trip — through the real gateway command, onto disk, and back after a restart —
 * and the two ways it can break without anyone being told. */
describe("host settings persist (real gateway path)", () => {
  it("writes a host-level setting to <dataRoot>/settings.json and recovers it after a restart", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const first = await app.listen();
    const post = (port: number, cmd: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ ok: boolean; result: { themePreference: string } }>);

    expect(await post(first.port, "setHostSettings", { themePreference: "light" })).toMatchObject({ ok: true, result: { themePreference: "light" } });

    const file = path.join(cfg.dataRoot, "settings.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).themePreference).toBe("light");

    await app.close();
    app = await createHostApp(cfg);
    const again = await app.listen();
    expect(await post(again.port, "getHostSettings", {})).toMatchObject({ ok: true, result: { themePreference: "light" } });
    expect(new HostSettingsStore(file).view().themePreference).toBe("light");
  });

  it("reports a save it could not write, and never keeps the unsaved value in memory", () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bots-settings-ro-"));
    const file = path.join(dir, "settings.json");
    const store = new HostSettingsStore(file);
    store.update({ themePreference: "light" });
    fs.chmodSync(dir, 0o500); // read-only directory: the atomic write can no longer create its tmp file
    try {
      let thrown: unknown = null;
      try { store.update({ themePreference: "dark" }); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(GatewayError);
      expect((thrown as GatewayError).code).toBe("SETTINGS_NOT_SAVED");
      expect((thrown as GatewayError).message).toMatch(/could not be saved/i);
      expect((thrown as GatewayError).message).toContain(file);
      // the caller was told nothing was saved, so the in-memory view must still agree with the disk
      expect(store.view().themePreference).toBe("light");
      expect(JSON.parse(fs.readFileSync(file, "utf8")).themePreference).toBe("light");
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it("starts from the defaults when settings.json is corrupt, keeping the damaged file aside", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-settings-bad-"));
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, '{"themePreference": "light", "advanc'); // truncated by a crash / full disk

    const store = new HostSettingsStore(file);
    expect(store.view().themePreference).toBe(DEFAULT_HOST_SETTINGS.themePreference);
    // the damaged file is preserved, not overwritten in place, so nothing is lost silently
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.corrupt"))).toHaveLength(1);
    // and the store is usable again afterwards
    expect(store.update({ themePreference: "dark" }).themePreference).toBe("dark");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).themePreference).toBe("dark");
  });
});
