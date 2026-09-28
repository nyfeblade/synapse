import { describe, expect, it } from "vitest";
import { MAC_DISK_CHECK_MS, MacDiskWatch, macDiskLevel, type MacDiskView } from "../../src/main/mac-disk";
import { STRO } from "@synapse/shared";

const GB = 1e9; // what Finder and About This Mac call a GB

function rig(o: { free?: number; box?: number | null; fail?: boolean } = {}) {
  let free = o.free ?? 100 * GB;
  let fail = o.fail ?? false;
  const notes: { title: string; body: string }[] = [];
  const views: MacDiskView[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const w = new MacDiskWatch({
    path: "/", now: () => 1000,
    statfs: () => { if (fail) throw new Error("EIO"); return { free, total: 500 * GB }; },
    notify: (title, body) => notes.push({ title, body }),
    emit: (v) => views.push(v),
    boxFree: async () => o.box ?? null,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  });
  return { w, notes, views, timers, setFree: (b: number) => { free = b; }, setFail: (b: boolean) => { fail = b; } };
}

describe("low disk on the Mac (bug-log 128)", () => {
  it("levels: under 15 GB is low, under 5 GB is critical", () => {
    expect(macDiskLevel(20 * GB)).toBe("ok");
    expect(macDiskLevel(15 * GB)).toBe("ok");
    expect(macDiskLevel(14.9 * GB)).toBe("low");
    expect(macDiskLevel(5 * GB)).toBe("low");
    expect(macDiskLevel(4.9 * GB)).toBe("critical");
    expect(macDiskLevel(0)).toBe("critical");
  });

  it("says it in the user's words, with the free space in Finder's GB", () => {
    expect(STRO.macDiskLow(12_345_000_000)).toBe("Your Mac is almost out of space (12.3 GB free). Synapse's backups and Bots may stop working.");
  });

  it("checks on launch and every 10 minutes", async () => {
    const r = rig({ free: 12 * GB });
    r.w.start();
    await r.w.idle();
    expect(r.views).toHaveLength(1);
    expect(r.timers).toHaveLength(1);
    expect(r.timers[0]!.ms).toBe(MAC_DISK_CHECK_MS);
    expect(MAC_DISK_CHECK_MS).toBe(10 * 60_000);
    r.timers[0]!.fn();
    await r.w.idle();
    expect(r.views).toHaveLength(2);
  });

  it("low: a banner only (the view says low); critical: a notification too, once per episode", async () => {
    const r = rig({ free: 12 * GB, box: 40 * GB });
    expect(await r.w.check()).toMatchObject({ level: "low", freeBytes: 12 * GB, boxFreeBytes: 40 * GB });
    expect(r.notes).toHaveLength(0);
    r.setFree(3 * GB);
    expect((await r.w.check()).level).toBe("critical");
    expect(r.notes).toEqual([{ title: STRO.macDiskTitle, body: STRO.macDiskLow(3 * GB) }]);
    await r.w.check();
    expect(r.notes).toHaveLength(1); // not every 10 minutes
    r.setFree(30 * GB);
    expect((await r.w.check()).level).toBe("ok");
    r.setFree(2 * GB);
    await r.w.check();
    expect(r.notes).toHaveLength(2); // a new episode notifies again
    expect(r.views.at(-1)).toMatchObject({ level: "critical" });
  });

  it("a failed statfs keeps the app running and shows no banner", async () => {
    const r = rig({ fail: true });
    await expect(r.w.check()).resolves.toMatchObject({ level: "ok", freeBytes: null });
    expect(r.notes).toHaveLength(0);
  });
});
