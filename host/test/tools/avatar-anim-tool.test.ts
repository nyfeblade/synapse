import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANIM_LIMITS, AVATAR_ANIM_HELP, type AvatarClip } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { AckLedger } from "../../runner/ack-ledger";
import { CreationLedger } from "../../runner/creation-ledger";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { createBotTools } from "../../tools/bot-tools";
import { botDir } from "../../store/layout";
import { tmpConfig } from "../helpers";

const clip: AvatarClip = { name: "happy-spin", on: "task_done", duration_ms: 1200, keys: [{ at: 0.3, y: -15, eyes: "happy", ease: "pop" }, { at: 0.7, turn: 1 }] };

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub, settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const tools = createBotTools({
    botId: id, slot: () => null, bots, now: () => 1000,
    acks: new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json")),
    creations: new CreationLedger(path.join(cfg.hostPrivate, "bot-creations.json")),
    createBot: () => "",
  });
  const upd = tools.find((t) => t.name === "update_state")!;
  const call = (a: Record<string, unknown>) => upd.handler({ target: "avatar", ...a }) as Promise<{ text: string; isError?: boolean }>;
  return { cfg, hub, settings, bots, id, call };
}

describe('update_state target "avatar": Bot-authored animations', () => {
  it("help returns the DSL reference (loaded only when asked for)", async () => {
    const { call } = setup();
    const r = await call({ action: "help" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe(AVATAR_ANIM_HELP);
  });

  it("set validates, stores the clip on the Bot's profile, and survives a reload", async () => {
    const { cfg, hub, settings, bots, id, call } = setup();
    const r = await call({ action: "set", body: JSON.stringify(clip) });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/happy-spin/);
    expect(bots.summary(id).profile.avatarAnimations).toEqual([clip]);
    const again = new BotService({ cfg, hub, settings });
    again.loadAll();
    expect(again.summary(id).profile.avatarAnimations).toEqual([clip]);
  });

  it("an invalid clip is refused with every error, and nothing is stored", async () => {
    const { bots, id, call } = setup();
    const r = await call({ action: "set", body: JSON.stringify({ ...clip, keys: [{ at: 0.5, tilt: 400, js: "x" }] }) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/keys\[0\]\.tilt/);
    expect(r.text).toMatch(/keys\[0\]\.js/);
    expect(bots.summary(id).profile.avatarAnimations ?? []).toEqual([]);
    expect((await call({ action: "set", body: "not json" })).isError).toBe(true);
    expect((await call({ action: "set" })).isError).toBe(true);
  });

  it("list, delete and reset", async () => {
    const { bots, id, call } = setup();
    await call({ action: "set", body: JSON.stringify(clip) });
    await call({ action: "set", body: JSON.stringify({ ...clip, name: "wave", on: "manual" }) });
    const l = await call({ action: "list" });
    expect(l.text).toMatch(/happy-spin.*task_done/);
    expect(l.text).toMatch(/wave.*manual/);
    expect((await call({ action: "delete", name: "nope" })).isError).toBe(true);
    await call({ action: "delete", name: "wave" });
    expect(bots.summary(id).profile.avatarAnimations!.map((c) => c.name)).toEqual(["happy-spin"]);
    await call({ action: "reset" });
    expect(bots.summary(id).profile.avatarAnimations ?? []).toEqual([]);
    expect((await call({ action: "list" })).text).toMatch(/no animations/i);
  });

  it("play cues a stored clip with a rising sequence number; an unknown name is an error", async () => {
    const { bots, id, call } = setup();
    await call({ action: "set", body: JSON.stringify({ ...clip, name: "wave", on: "manual" }) });
    await call({ action: "play", name: "wave" });
    const c1 = bots.summary(id).profile.avatarCue!;
    await call({ action: "play", name: "wave" });
    const c2 = bots.summary(id).profile.avatarCue!;
    expect(c1.name).toBe("wave");
    expect(c2.seq).toBeGreaterThan(c1.seq);
    expect((await call({ action: "play", name: "ghost" })).isError).toBe(true);
  });

  it("the per-Bot cap holds", async () => {
    const { call } = setup();
    for (let i = 0; i < ANIM_LIMITS.maxClips; i++) expect((await call({ action: "set", body: JSON.stringify({ ...clip, name: `m${i}`, on: "manual" }) })).isError).toBeFalsy();
    const r = await call({ action: "set", body: JSON.stringify({ ...clip, name: "extra", on: "manual" }) });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/at most/);
  });

  it("a tampered profile.json never reaches the renderer: invalid clips are dropped on load", async () => {
    const { cfg, hub, settings, id, call } = setup();
    await call({ action: "set", body: JSON.stringify(clip) });
    const f = path.join(botDir(cfg, id), "profile.json");
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    p.avatarAnimations.push({ name: "evil", on: "click", duration_ms: 1e9, keys: [{ at: 0.5, onload: "x" }] });
    p.avatarAnimations.push("junk");
    fs.writeFileSync(f, JSON.stringify(p));
    const again = new BotService({ cfg, hub, settings });
    again.loadAll();
    expect(again.summary(id).profile.avatarAnimations).toEqual([clip]);
  });

  it("an unknown action lists the ones that exist", async () => {
    const { call } = setup();
    const r = await call({ action: "dance" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/help/);
  });
});
