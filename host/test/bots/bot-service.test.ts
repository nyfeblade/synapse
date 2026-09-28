import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AVATAR_EDITOR_SHAPES, DEFAULT_AVATAR_SHAPE, type SseEvent } from "@synapse/shared";
import { BotService, markerOf } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { HostSettingsStore } from "../../store/host-settings";
import { agentsDir, initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  let t = 1000;
  const bots = new BotService({ cfg, hub, settings, now: () => t++ });
  bots.loadAll();
  return { cfg, hub, events, settings, bots };
}

describe("BotService", () => {
  it("re-renders the frozen prompt when the roster changes: create and remove invalidate every snapshot (B2B-07)", () => {
    const { bots } = setup();
    const a = bots.create({ name: "Planner", origin: "user", kickstart: false });
    let renders = 0;
    const render = () => `v${++renders}`;
    expect(bots.promptSnapshot(a, render)).toBe("v1");
    expect(bots.promptSnapshot(a, render)).toBe("v1");
    const b = bots.create({ name: "Scout", origin: "user", kickstart: false });
    expect(bots.promptSnapshot(a, render)).toBe("v2");
    bots.remove(b);
    expect(bots.promptSnapshot(a, render)).toBe("v3");
    bots.invalidatePromptSnapshots(a);
    expect(bots.promptSnapshot(a, render)).toBe("v4");
    bots.invalidatePromptSnapshots("gone");
    expect(bots.promptSnapshot(a, render)).toBe("v4");
  });

  it("creates a Bot as files only, with the default model, a random shape avatar and a Created event (BOT-03, BOT-25, §16.1)", () => {
    const { cfg, bots, events } = setup();
    const id = bots.create({ origin: "user", kickstart: true });
    const dir = path.join(cfg.dataRoot, "agents", id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8"))).toMatchObject({ name: "New Bot", title: "", description: "", avatarKind: "shape" });
    expect(fs.existsSync(path.join(dir, "store.db"))).toBe(true);
    const s = bots.summary(id);
    expect(s.profile.model).toBeUndefined();
    expect(s.presence).toBe("idle");
    expect(bots.introductionPending(id)).toBe(true);
    expect(bots.tail(id, 10)).toEqual([expect.objectContaining({ kind: "event", id: "tba1", event: { type: "bot-created", botId: id, name: "New Bot" } })]);
    expect(events.some((e) => e.channel === "agent-upserted")).toBe(true);
  });

  it("enforces the 50-Bot cap with the spec's message (BOT-07)", () => {
    const { bots } = setup();
    for (let i = 0; i < 50; i++) bots.create({ origin: "user", kickstart: false });
    expect(() => bots.create({ origin: "user", kickstart: false })).toThrow("50 is the maximum");
  });

  it("validates updates and truncates the label to 24 chars (BOT-02, BOT-25, BOT-26)", () => {
    const { bots } = setup();
    const id = bots.create({ origin: "user", kickstart: false });
    expect(() => bots.update(id, { name: "   " })).toThrow("The name can't be blank.");
    expect(() => bots.update(id, { model: "gpt-9" as never })).toThrow(/model/);
    const s = bots.update(id, { name: "Piper", title: "Research and writing helper", model: "claude-opus-5", avatarShape: "gem", avatarColor: "#4BA495" });
    expect(s.profile).toMatchObject({ name: "Piper", title: "Research and writing hel", model: "claude-opus-5", avatarShape: "gem", avatarColor: "#4ba495" });
  });

  it("stores curious motion on a new Bot and rejects unknown material, motion or effort", () => {
    const { bots } = setup();
    const id = bots.create({ origin: "user", kickstart: false });
    expect(bots.summary(id).profile.avatarMotion).toBe("curious");
    // A new Bot is the pebble (the default form), and never a legacy-only id.
    for (let i = 0; i < 40; i++) {
      const shape = bots.summary(bots.create({ origin: "user", kickstart: false })).profile.avatarShape;
      expect(shape).toBe(DEFAULT_AVATAR_SHAPE);
      expect(AVATAR_EDITOR_SHAPES).toContain(shape);
    }
    expect(() => bots.update(id, { avatarMaterial: "chrome" as never })).toThrow(/material/);
    expect(() => bots.update(id, { avatarMotion: "bounce" as never })).toThrow(/motion/);
    expect(() => bots.update(id, { effort: "turbo" as never })).toThrow(/effort/);
    const s = bots.update(id, { avatarMaterial: "glass", avatarMotion: "kinetic", effort: "max" });
    expect(s.profile).toMatchObject({ avatarMaterial: "glass", avatarMotion: "kinetic", effort: "max" });
  });

  it("seeds the name from the first user message when still default (BOT-03)", () => {
    const { bots } = setup();
    const id = bots.create({ origin: "user", kickstart: false });
    bots.nextUserSeq(id);
    bots.seedNameIfDefault(id, "  research   the best\nstanding desks under $500 and write a comparison table for me please, thanks a lot  ");
    expect(bots.summary(id).profile.name).toBe("research the best standing desks under $500 and write a comparison table");
    bots.nextUserSeq(id);
    bots.seedNameIfDefault(id, "second message");
    expect(bots.summary(id).profile.name).not.toBe("second message");
  });

  it("tracks user seq, confirmed watermark and unconfirmed messages (EVT-10)", () => {
    const { bots } = setup();
    const id = bots.create({ origin: "user", kickstart: false });
    for (const text of ["a", "b", "c"]) {
      const n = bots.nextUserSeq(id);
      bots.appendEntry(id, { kind: "message", id: `t${n}u`, role: "user", content: text, createdAt: n });
    }
    bots.confirmUserSeq(id, 1);
    expect(bots.userMessagesAfter(id, bots.confirmedUserSeq(id)).map((m) => m.content)).toEqual(["b", "c"]);
    expect(bots.latestUserSeq(id)).toBe(3);
  });

  it("builds summaries with markers and status lines (BOT-13, BOT-21)", () => {
    const { bots } = setup();
    const a = bots.create({ origin: "user", kickstart: false });
    const b = bots.create({ origin: "user", kickstart: false });
    bots.open(a);
    bots.noteBotMessage(b, "**Done sorting.** 41 were newsletters\nsecond line");
    expect(bots.summary(b)).toMatchObject({ statusLine: "Done sorting. 41 were newsletters", marker: "unread" });
    bots.noteBotMessage(a, "hello");
    expect(bots.summary(a).marker).toBeNull();
    bots.setAwaiting(a, { tabId: "auto-review", reason: "Approval needed: Delete 3 Friday events", since: 1 });
    expect(bots.summary(a)).toMatchObject({ marker: "blocked", statusLine: "Approval needed: Delete 3 Friday events" });
    expect(markerOf({ awaiting: null, unread: false, running: true })).toBe("working");
  });

  it("pins, removes data, forgets pins and switches the active Bot (BOT-09, BOT-11)", () => {
    const { cfg, bots, settings, events } = setup();
    const a = bots.create({ origin: "user", kickstart: false });
    const b = bots.create({ origin: "user", kickstart: false });
    bots.open(a);
    bots.setPinned(a, true);
    expect(settings.view().pinnedAgentIds).toEqual([a]);
    bots.remove(a);
    expect(fs.existsSync(path.join(cfg.dataRoot, "agents", a))).toBe(false);
    expect(settings.view().pinnedAgentIds).toEqual([]);
    expect(bots.activeAgentId()).toBe(b);
    expect(events.at(-1)).toEqual({ channel: "agents", payload: { removedId: a, activeAgentId: b } });
  });

  // Task 34 fix round, finding 1 (Bug 1): a real-brain session file lives under
  // ~/.claude/projects/**, which is box:bots-owned — bothost has no write bits there (see
  // host/brain/conformance/session-file.ts). fs.rmSync's { force: true } only suppresses ENOENT,
  // not EACCES, so remove() used to throw and deleteAgent 500'd against the real box. This mirrors
  // the existing CT-14 cleanupSynthesizedSession pattern (host/brain/conformance/checks/group-c.ts):
  // EACCES on that one unlink is downgraded to best-effort, everything else still propagates.
  it("tolerates EACCES removing a real-brain session file it doesn't own (BOT-11 / Task 34 Bug 1)", () => {
    const { cfg, bots, settings } = setup();
    const a = bots.create({ origin: "user", kickstart: false });
    bots.setSessionId(a, "sess-1");
    const sessionFile = bots.sessionFilePath(a)!;
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "{}\n");
    const realRmSync = fs.rmSync.bind(fs);
    const spy = vi.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, opts?: fs.RmOptions) => {
      if (p === sessionFile) throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(p)}'`), { code: "EACCES" });
      return realRmSync(p, opts);
    }) as typeof fs.rmSync);
    try {
      expect(() => bots.remove(a)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(cfg.dataRoot, "agents", a))).toBe(false);
    // The rest of remove() still ran (not short-circuited by the caught error).
    expect(settings.view().pinnedAgentIds).toEqual([]);
    expect(bots.has(a)).toBe(false);
  });

  it("still propagates a non-EACCES error removing the session file", () => {
    const { bots } = setup();
    const a = bots.create({ origin: "user", kickstart: false });
    bots.setSessionId(a, "sess-1");
    const sessionFile = bots.sessionFilePath(a)!;
    const realRmSync = fs.rmSync.bind(fs);
    const spy = vi.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, opts?: fs.RmOptions) => {
      if (p === sessionFile) throw Object.assign(new Error("boom"), { code: "EIO" });
      return realRmSync(p, opts);
    }) as typeof fs.rmSync);
    try {
      expect(() => bots.remove(a)).toThrow("boom");
    } finally {
      spy.mockRestore();
    }
  });

  it("reloads Bots from disk", () => {
    const { cfg, hub, settings, bots } = setup();
    const id = bots.create({ origin: "user", kickstart: false, name: "Scout" });
    const again = new BotService({ cfg, hub, settings });
    again.loadAll();
    expect(again.summary(id).profile.name).toBe("Scout");
  });

  it("validates avatarShape/avatarColor on create the same way update does (fix round 1, finding 2)", () => {
    const { bots } = setup();
    expect(() => bots.create({ origin: "user", kickstart: false, avatarShape: "hexagon" as never })).toThrow(/avatar/i);
    expect(() => bots.create({ origin: "user", kickstart: false, avatarColor: "#123456" })).toThrow(/avatar/i);
    const id = bots.create({ origin: "user", kickstart: false, avatarShape: "gem", avatarColor: "#4BA495" });
    expect(bots.summary(id).profile).toMatchObject({ avatarShape: "gem", avatarColor: "#4ba495" });
  });

  it("bug 292: a profile saved with the old avatar ids loads with the Synapse ones, and old ids are still accepted on input", () => {
    const { cfg, bots, hub, settings } = setup();
    const id = bots.create({ origin: "user", kickstart: false, avatarShape: "pebble" });
    const file = path.join(agentsDir(cfg), id, "profile.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), avatarShape: "octagon", avatarColor: "#49a393" }));
    const again = new BotService({ cfg, hub, settings, now: () => 5000 });
    again.loadAll();
    expect(again.summary(id).profile).toMatchObject({ avatarShape: "gem", avatarColor: "#4ba495" });
    expect(again.update(id, { avatarShape: "rounded-square" as never, avatarColor: "#3472D9" }).profile).toMatchObject({ avatarShape: "tile", avatarColor: "#3674d8" });
    expect(again.summary(again.create({ origin: "user", kickstart: false, avatarShape: "cloud" as never })).profile.avatarShape).toBe("puff");
  });

  it("skips stray folders that fail the safe-id check under agents/ when loading, instead of throwing (controller ruling on botDir)", () => {
    const { cfg, hub, settings, bots } = setup();
    const id = bots.create({ origin: "user", kickstart: false, name: "Scout" });
    // A folder name containing a backslash fails isSafeFolderId (@synapse/shared), which is what
    // botDir() now throws GatewayError("INVALID_BOT_ID", …) on. Listing must filter it out first.
    const strayName = "stray\\bot";
    fs.mkdirSync(path.join(agentsDir(cfg), strayName), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(cfg), strayName, "profile.json"), JSON.stringify({ name: "stray" }));
    const again = new BotService({ cfg, hub, settings });
    expect(() => again.loadAll()).not.toThrow();
    expect(again.ids().sort()).toEqual([id]);
  });

  // Gate M-2: on the real box, deleteAgent must really delete the session via the root-owned helper.
  it("removes the real-brain session file through the injected delete helper (M-2, BOT-11)", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const deleted: string[] = [];
    const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")), deleteSession: (f) => { deleted.push(f); } });
    bots.loadAll();
    const a = bots.create({ origin: "user", kickstart: false });
    bots.setSessionId(a, "0393b532-c3c8-448c-b375-f9851dc52ed9");
    const file = bots.sessionFilePath(a)!;
    bots.remove(a);
    expect(deleted).toEqual([file]);
    expect(bots.has(a)).toBe(false);
  });

  // Merge seam (Phase 1 M-2 x Phase 2 rollover): a rolled-over Bot has older root-owned session
  // files too; deleting the Bot removes every one of them, not only the current session.
  it("also removes the rolled-over session files when a Bot is deleted", () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const deleted: string[] = [];
    const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")), deleteSession: (f) => { deleted.push(f); } });
    bots.loadAll();
    const a = bots.create({ origin: "user", kickstart: false });
    bots.setSessionId(a, "0393b532-c3c8-448c-b375-f9851dc52ed9");
    const file = bots.sessionFilePath(a)!;
    const old1 = path.join(path.dirname(file), "old-1.jsonl");
    const old2 = path.join(path.dirname(file), "old-2.jsonl");
    bots.setBrainKv(a, "rolledSessionFiles", [{ id: "old-1", file: old1, rolledAt: 1 }, { id: "old-2", file: old2, rolledAt: 0 }]);
    bots.setBrainKv(a, "previousSessionIds", [{ id: "old-1", file: old1, rolledAt: 1 }]);
    bots.remove(a);
    expect(deleted.sort()).toEqual([file, old1, old2].sort());
  });

  it("queues a token-cheap Bot-list reminder (changed names and ids only) for every other Bot on create, rename and remove", () => {
    const { bots } = setup();
    const a = bots.create({ name: "Planner", description: "long description that must not be repeated", origin: "user", kickstart: false });
    expect(bots.takeRosterUpdate(a)).toBeNull();
    const b = bots.create({ name: "Scout", description: "also long", origin: "user", kickstart: false });
    bots.update(b, { name: "Ranger" });
    const c = bots.create({ name: "Temp", origin: "user", kickstart: false });
    bots.remove(c);
    bots.update(b, { description: "changed" }); // not a Bot-list change
    expect(bots.takeRosterUpdate(a)).toBe(`Your Bot list changed: added Ranger (id: ${b}).`);
    expect(bots.takeRosterUpdate(a)).toBeNull();
    // b saw c come and go (nothing to say) and nothing about itself
    expect(bots.takeRosterUpdate(b)).toBeNull();
    bots.update(a, { name: "Lead" });
    const d = bots.create({ name: "Scribe", origin: "user", kickstart: false });
    bots.remove(a);
    expect(bots.takeRosterUpdate(b)).toBe(`Your Bot list changed: added Scribe (id: ${d}); removed Lead (id: ${a}).`);
    expect(bots.takeRosterUpdate(d)).toBe(`Your Bot list changed: removed Lead (id: ${a}).`); // d existed when a left
    bots.update(d, { name: "Writer" });
    expect(bots.takeRosterUpdate(b)).toBe(`Your Bot list changed: renamed Writer (id: ${d}).`);
  });
});
