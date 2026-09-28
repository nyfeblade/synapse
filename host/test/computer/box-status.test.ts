import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SseEvent } from "@synapse/shared";
import { BoxStatus, WallpaperScheduler, toneAt, writeReferenceDocs } from "../../computer/box-status";
import type { DisplayManager } from "../../computer/displays";
import type { Exec } from "../../computer/x-exec";
import { SseHub } from "../../gateway/sse-hub";

const at = (iso: string) => Date.parse(iso);

describe("toneAt (CMP-10)", () => {
  it.each([
    ["2026-09-19T11:30:00Z", "America/New_York", "dawn"],    // 07:30
    ["2026-09-19T17:00:00Z", "America/New_York", "day"],     // 13:00
    ["2026-09-19T21:30:00Z", "America/New_York", "dusk"],    // 17:30
    ["2026-09-20T00:30:00Z", "America/New_York", "evening"], // 20:30
    ["2026-09-20T06:00:00Z", "America/New_York", "night"],   // 02:00
  ])("%s in %s → %s", (iso, tz, tone) => expect(toneAt(at(iso), tz)).toBe(tone));
});

describe("WallpaperScheduler", () => {
  it("paints each running display when the tone changes, with the display's X env", async () => {
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const exec: Exec = async (_f, args, o) => { calls.push({ args, env: o?.env }); return { code: 0, stdout: Buffer.alloc(0), stderr: "" }; };
    const displays = { list: () => [{ index: 2, running: true }, { index: 3, running: false }], xenv: (i: number) => ({ display: `:${i}`, xauthority: `/run/bot-x/${i}.xauth` }) } as unknown as DisplayManager;
    let t = at("2026-09-19T17:00:00Z");
    const w = new WallpaperScheduler({ exec, displays, timeZone: () => "America/New_York", now: () => t });
    await w.tick();
    await w.tick();
    t = at("2026-09-19T21:30:00Z");
    await w.tick();
    expect(calls.map((c) => c.args.join(" "))).toEqual(["paint :2 day", "paint :2 dusk"]);
    expect(calls[0]!.env).toEqual({ DISPLAY: ":2", XAUTHORITY: "/run/bot-x/2.xauth" });
  });
});

describe("BoxStatus", () => {
  it("reports the image version, doctor failures and busy Bots, and publishes phase changes", async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bs-")), "image-version");
    fs.writeFileSync(f, "abcdef0123456789\n");
    const hub = new SseHub();
    const events: SseEvent[] = [];
    hub.subscribe((e) => events.push(e));
    const exec: Exec = async () => ({ code: 0, stdout: Buffer.from("PASS machine-id\nFAIL dns\nPASS chromium\n"), stderr: "" });
    const s = new BoxStatus({ hub, exec, imageVersionFile: f, snapshots: () => ({ latestAt: 5, running: false }), busyBotIds: () => ["bot-a"], now: () => 77 });
    await s.runDoctor();
    expect(s.view()).toMatchObject({ phase: "ready", imageVersion: "abcdef0123456789", backupReady: true, lastSnapshotAt: 5, busyBotIds: ["bot-a"], doctor: { ranAt: 77, failed: ["dns"] } });
    s.setPhase("updating", "backing_up");
    expect(events.at(-1)).toMatchObject({ channel: "forever-box", payload: { phase: "updating", step: "backing_up" } });
  });

  it("refresh() publishes when a first backup appears or busy Bots change, and stays quiet otherwise (Task 30 fuzz)", () => {
    const hub = new SseHub();
    const events: SseEvent[] = [];
    hub.subscribe((e) => events.push(e));
    let latestAt: number | null = null;
    let busy: string[] = ["bot-a"];
    const exec: Exec = async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: "" });
    const s = new BoxStatus({ hub, exec, snapshots: () => ({ latestAt, running: false }), busyBotIds: () => busy });
    s.refresh();
    const n = events.length;
    s.refresh();
    expect(events.length).toBe(n);
    latestAt = 10;
    s.refresh();
    expect(events.at(-1)).toMatchObject({ channel: "forever-box", payload: { backupReady: true, lastSnapshotAt: 10 } });
    busy = [];
    s.refresh();
    expect(events.at(-1)).toMatchObject({ channel: "forever-box", payload: { busyBotIds: [] } });
  });

  it("writes the two reference docs with the product name", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ref-"));
    writeReferenceDocs(d);
    expect(fs.readFileSync(path.join(d, "debugging-the-box.md"), "utf8")).toMatch(/box-doctor/);
    expect(fs.readFileSync(path.join(d, "debugging-the-box.md"), "utf8")).toMatch(/recover via Update, never Reset/i);
    expect(fs.readFileSync(path.join(d, "app-ui.md"), "utf8")).toMatch(/Bots/);
  });

  it("a reference dir the host can't write doesn't crash the boot (T29 box finding)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ref-"));
    fs.chmodSync(d, 0o555);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(writeReferenceDocs(d)).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^reference docs not written/));
    } finally {
      fs.chmodSync(d, 0o755);
      log.mockRestore();
    }
    expect(writeReferenceDocs(d)).toBe(true);
  });
});
