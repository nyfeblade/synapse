import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Tray } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { tmpConfig } from "../helpers";

/**
 * Found by the bug 44 / 51 / 52 sibling sweep of every host `log.warn` / `log.error`: a settings.json
 * that will not parse is quarantined and the host starts from the defaults — correct — but the only
 * trace was `log.error("settings.json could not be parsed; starting from the defaults")`. Settings then
 * showed the defaults as if they were the user's own: their theme, time zone and Auto-review rules
 * gone, with nothing saying so or where the old file went.
 */
describe("an unreadable settings.json is reset to the defaults and the user is told (bug 44's class)", () => {
  let app: HostApp | null = null;
  afterEach(async () => { await app?.close(); app = null; });

  async function start(settingsText: string | null) {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.dataRoot, { recursive: true });
    if (settingsText !== null) fs.writeFileSync(path.join(cfg.dataRoot, "settings.json"), settingsText);
    app = await createHostApp(cfg);
    const { port } = await app.listen();
    const r = await fetch(`http://127.0.0.1:${port}/api/getTrays`, { method: "POST", headers: { authorization: `Bearer ${app.token}` }, body: "{}" });
    return ((await r.json()) as { result: { trays: Tray[] } }).result.trays;
  }

  it("says the settings were reset, and where the unreadable file was kept", async () => {
    const trays = await start("{ this is not json");
    const t = trays.find((x) => /settings/i.test(x.title));
    expect(t, "the user's settings silently became the defaults").toBeTruthy();
    expect(t!.botId).toBeNull();
    expect(t!.detail).toMatch(/default/i);
    expect(t!.detail, "the old file was kept; the user is told where").toMatch(/settings\.json/);
  });

  it("says nothing when settings.json is fine or has never been written (must not fire)", async () => {
    expect((await start(JSON.stringify({ themePreference: "dark" }))).filter((x) => /settings/i.test(x.title))).toEqual([]);
    await app?.close(); app = null;
    expect((await start(null)).filter((x) => /settings/i.test(x.title))).toEqual([]);
  });
});
