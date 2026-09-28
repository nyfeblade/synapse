import { afterEach, describe, expect, it } from "vitest";
import type { BotSummary, DiskPressureView } from "@synapse/shared";
import { createHostApp, type HostApp } from "../../app";
import { tmpConfig } from "../helpers";

/**
 * A whole-app test must never read the Mac's real free disk space.
 *
 * DiskGuard.poll() runs from Phase 3's boot(), and under pressure its onEpisode hook calls
 * DiskSaver.ensure(), which CREATES a Bot. That is correct in production (CMP-15 → BOT-16), but in
 * the suite it meant every host-app test silently grew an extra "Disk Saver" Bot whenever the
 * developer's own disk happened to sit under LIMITSC.diskSoftPct (15%) — so
 * host/test/app-journey.test.ts's "after deleting the Bot I made, nothing is listed" failed with a
 * Bot the test never created, and the same commit passed or failed depending on how full the Mac
 * was at that moment. The free-space probe is injected from the config instead, so what the suite
 * sees is a property of the test, not of the machine it runs on.
 */
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function start(extra: Record<string, string> = {}) {
  app = await createHostApp(tmpConfig(extra));
  const { port } = await app.listen();
  return async <T>(cmd: string, args: unknown): Promise<T> => {
    const r = await fetch(`http://127.0.0.1:${port}/api/${cmd}`, { method: "POST", headers: { authorization: `Bearer ${app!.token}` }, body: JSON.stringify(args) });
    const j = (await r.json()) as { ok: boolean; result?: unknown; error?: { message: string } };
    if (!j.ok) throw new Error(j.error!.message);
    return j.result as T;
  };
}

describe("the suite's free-space probe is injected, not statfs on the real machine", () => {
  it("reports the configured percentage, whatever the real disk is doing", async () => {
    const api = await start({ DISK_FREE_PCT: "42" });
    const d = await api<DiskPressureView>("getDiskPressure", {});
    expect(d.freePct).toBe(42);
    expect(d.level).toBe("ok");
  }, 30_000);

  it("boots a host app with no Bots at all, so a low disk on the dev machine can't add one", async () => {
    const api = await start();
    expect((await api<{ agents: BotSummary[] }>("listAgents", {})).agents).toEqual([]);
    expect((await api<DiskPressureView>("getDiskPressure", {})).level).toBe("ok");
  }, 30_000);

  it("still reaches soft pressure and makes the Disk Saver Bot when the configured disk is low", async () => {
    const api = await start({ DISK_FREE_PCT: "9" });
    const d = await api<DiskPressureView>("getDiskPressure", {});
    expect(d.freePct).toBe(9);
    expect(d.level).toBe("soft");
    expect((await api<{ agents: BotSummary[] }>("listAgents", {})).agents.map((a) => a.profile.name)).toEqual(["Disk Saver"]);
  }, 30_000);
});
