import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STRC, type SseEvent } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { DiskGuard, DiskSaver, nextLevel, withDiskReminder } from "../../computer/disk-guard";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import type { BrainWiring } from "../../brain/types";
import { SseHub } from "../../gateway/sse-hub";
import type { HiddenSpec } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const G = 1024 ** 3;
const T = 40 * G;

describe("nextLevel (CMP-15 thresholds with hysteresis)", () => {
  it.each([
    ["ok", 30 * G, "ok"], ["ok", 8 * G, "soft"], ["ok", 2 * G, "hard"], ["hard", 2.5 * G, "hard"],
    ["hard", 3.5 * G, "soft"], ["soft", 9 * G, "soft"], ["soft", 21 * G, "ok"],
  ] as const)("%s at %d bytes free → %s", (prev, free, want) => expect(nextLevel(prev, free, T)).toBe(want));
  it("uses the percentage rules on a small disk", () => {
    expect(nextLevel("ok", 0.9 * G, 20 * G)).toBe("hard");
    expect(nextLevel("ok", 2.8 * G, 20 * G)).toBe("soft");
  });
});

describe("DiskGuard", () => {
  it("publishes the level, reminds each Bot once per episode, and starts a new episode after recovery", () => {
    let free = 30 * G;
    const events: SseEvent[] = [];
    const hub = new SseHub();
    hub.subscribe((e) => events.push(e));
    const episodes: string[] = [];
    const g = new DiskGuard({ path: "/workspace", hub, ledgerFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dg-")), "disk.json"), statfs: () => ({ free, total: T }), onEpisode: (l) => episodes.push(l) });
    expect(g.poll().level).toBe("ok");
    expect(g.reminderFor("a")).toBeNull();
    free = 7 * G;
    expect(g.poll()).toMatchObject({ level: "soft", freeBytes: 7 * G });
    expect(g.reminderFor("a")).toBe(STRC.diskReminder);
    expect(g.reminderFor("a")).toBeNull();
    expect(g.reminderFor("b")).toBe(STRC.diskReminder);
    free = 30 * G;
    g.poll();
    free = 7 * G;
    g.poll();
    expect(g.reminderFor("a")).toBe(STRC.diskReminder);
    expect(episodes).toEqual(["soft", "soft"]);
    expect(events.filter((e) => e.channel === "box-disk-pressure")).toHaveLength(4);
  });

  it("poll() survives a statfs failure and returns the last-known view instead of throwing", () => {
    let broken = false;
    const g = new DiskGuard({
      path: "/workspace", hub: new SseHub(), ledgerFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dg-")), "d.json"),
      statfs: () => { if (broken) throw new Error("EPERM: statfs"); return { free: 30 * G, total: T }; },
    });
    const first = g.poll();
    expect(first.level).toBe("ok");
    broken = true;
    expect(() => g.poll()).not.toThrow();
    expect(g.poll()).toEqual(first);
    expect(g.view()).toEqual(first);
  });

  it("withDiskReminder adds the reminder as additionalContext on the next tool result", async () => {
    const g = new DiskGuard({ path: "/", hub: new SseHub(), ledgerFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dg-")), "d.json"), statfs: () => ({ free: G, total: T }) });
    g.poll();
    const base: BrainWiring = { preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({ additionalContext: "other" }), stop: async () => ({ block: false }), botTools: () => [], turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }), flags: () => DEFAULT_FLAGS };
    const w = withDiskReminder(base, { botId: "a", guard: g });
    expect((await w.postToolUse({ toolName: "Bash", input: {}, toolUseId: "1" }, "x")).additionalContext).toBe(`other\n\n${STRC.diskReminder}`);
    expect((await w.postToolUse({ toolName: "Bash", input: {}, toolUseId: "2" }, "x")).additionalContext).toBe("other");
  });
});

describe("DiskSaver (BOT-16)", () => {
  it("creates the Disk Saver Bot once with purpose disk-saver and its kickstart; Open re-audits (#20)", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
    const wakes: { botId: string; spec: HiddenSpec }[] = [];
    const guard = new DiskGuard({ path: "/", hub: new SseHub(), ledgerFile: path.join(cfg.hostPrivate, "d.json"), statfs: () => ({ free: 7 * G, total: T }) });
    const ds = new DiskSaver({ bots, enqueueHidden: (botId, spec) => wakes.push({ botId, spec }), guard });
    const a = ds.ensure();
    expect(a.created).toBe(true);
    expect(bots.summary(a.id).profile.name).toBe("Disk Saver");
    expect(bots.require(a.id).store.getKv("purpose", null)).toBe("disk-saver");
    expect(wakes[0]!.spec).toMatchObject({ source: "disk-saver", lane: "background", silenceAllowed: false });
    expect(wakes[0]!.spec.text).toMatch(/Never delete anything without the user's confirmation/);
    expect(ds.ensure()).toEqual({ id: a.id, created: false });
    expect(ds.open()).toBe(a.id);
    expect(wakes[1]!.spec.text).toMatch(/^\[disk-saver\]/);
    expect(guard.view().diskSaverBotId).toBe(a.id);
  });
});
