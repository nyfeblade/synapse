import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DisplayManager } from "../../computer/displays";
import type { DisplayControl } from "../../computer/display-control";
import { SseHub } from "../../gateway/sse-hub";
import { tmpConfig } from "../helpers";

class FakeControl implements DisplayControl {
  async start() { return "ok" as const; }
  async stop() {}
  async status() { return "running" as const; }
  async restartChrome() {}
}

const mk = (cfg: ReturnType<typeof tmpConfig>, busyDir?: string) =>
  new DisplayManager({ cfg, control: new FakeControl(), hub: new SseHub(), maxScreens: 4, now: () => 1_700_000_000_000, ...(busyDir ? { busyDir } : {}), xauthDir: "/run/bot-x" });

// The busy marker is advisory (BRW-03), but bothost writes it. It used to land on a fully predictable
// /tmp path with a plain writeFileSync, so a Bot sharing /tmp could pre-plant
// /tmp/bot-monitor-busy-<i> as a symlink and have bothost truncate whatever it pointed at.
describe("DisplayManager busy marker is not a Bot-plantable write", () => {
  it("defaults to a bothost-private directory, never /tmp", () => {
    const cfg = tmpConfig();
    const m = mk(cfg);
    expect(m.indexFor("bot-a")).toBe(2);
    m.touch("bot-a");
    expect(fs.existsSync(path.join(cfg.hostPrivate, "busy", "bot-monitor-busy-2"))).toBe(true);
    expect(fs.readFileSync(path.join(cfg.hostPrivate, "busy", "bot-monitor-busy-2"), "utf8")).toBe("1700000000000");
  });

  it("refuses to write through a pre-planted symlink at the marker name", () => {
    const cfg = tmpConfig();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "busyroot-"));
    const busyDir = path.join(root, "busy");
    fs.mkdirSync(busyDir);
    const victim = path.join(root, "claude-oauth-token");
    fs.writeFileSync(victim, "REAL-TOKEN");
    fs.symlinkSync(victim, path.join(busyDir, "bot-monitor-busy-2"));
    const m = mk(cfg, busyDir);
    expect(m.indexFor("bot-a")).toBe(2);
    m.touch("bot-a");
    expect(fs.readFileSync(victim, "utf8")).toBe("REAL-TOKEN");
  });

  it("refuses to write when the whole marker directory was swapped for a symlink", () => {
    const cfg = tmpConfig();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "busyroot-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "busyvictim-"));
    fs.symlinkSync(elsewhere, path.join(root, "busy"));
    const m = mk(cfg, path.join(root, "busy"));
    expect(m.indexFor("bot-a")).toBe(2);
    m.touch("bot-a");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("still records last activity when the marker write is refused", () => {
    const cfg = tmpConfig();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "busyroot-"));
    fs.symlinkSync(fs.mkdtempSync(path.join(os.tmpdir(), "busyvictim-")), path.join(root, "busy"));
    const m = mk(cfg, path.join(root, "busy"));
    m.indexFor("bot-a");
    m.touch("bot-a");
    expect(m.lastActivity("bot-a")).toBe(1_700_000_000_000);
  });
});
