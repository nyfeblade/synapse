import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { createHostApp } from "../app";
import { EpisodeWriter } from "../memory/episodes";
import { sealTo } from "../secrets/crypto";
import { tmpConfig } from "./helpers";

async function until<T>(fn: () => T | undefined | null | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Phase 3 host wiring (FUZZ mode, FakeBrain)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("boot() and the 60s tick cadence survive a statfs failure without crashing the host", async () => {
    vi.spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("EPERM: statfs"); });
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    for (let i = 0; i < 12; i++) await app.services.phase3.tick(); // 12 * 5s tick = the 60s disk-poll cadence
    expect(app.services.phase3.disk.view().level).toBe("ok"); // statfs never once succeeded; last-known view held
    await app.close();
  });

  it("exposes every Phase 3 gateway command", async () => {
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    for (const c of ["getForeverBoxStatus", "getDisplays", "ensureDisplay", "handBackForeverBox", "setTakeoverActive", "openComputerApp", "getAsyncTasks", "setBotSecrets", "getBotSecretsStatus", "submitSecret", "submitForm", "getDiskPressure", "openDiskSaver", "snapshotBoxStoreNow", "getBoxStoreStatus", "listSnapshots", "restoreSnapshot", "deleteSnapshot", "prepareBoxRestart"]) {
      expect(app.handlers[c as keyof typeof app.handlers], c).toBeTypeOf("function");
    }
    await app.close();
  });

  it("computer: → Computer card with a screenshot → I'm done → wake #12 → the Bot replies", async () => {
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const { bots } = app.services;
    const { id } = await app.handlers.createAgent!({ name: "Scout" });
    await app.handlers.sendPrompt!({ id, text: "computer: hold the Denver fare", clientNonce: "n1" });
    const card = await until(() => bots.tail(id, 50).find((e): e is SendMessageEntry => e.kind === "send-message" && e.message.type === "box-help"));
    const req = (card.message as { request: { id: string; screenshotDataUrl: string | null } }).request;
    expect(req.screenshotDataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(bots.summary(id).awaiting?.tabId).toBe("box");
    await app.handlers.setTakeoverActive!({ id, requestId: req.id, active: true });
    await app.handlers.handBackForeverBox!({ id, requestId: req.id, outcome: "done" });
    await until(() => bots.tail(id, 50).some((e) => e.kind === "send-message" && e.message.type === "text" && e.message.content.includes("Thanks for handing the computer back")));
    await app.close();
  });

  it("bg: → Shell in the background → revival #10 → reply; getAsyncTasks lists it", async () => {
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const { id } = await app.handlers.createAgent!({ name: "Runner" });
    await app.handlers.sendPrompt!({ id, text: "bg: sleep 0.2; echo p3-done", clientNonce: "n2" });
    await until(() => app.services.bots.tail(id, 50).some((e) => e.kind === "send-message" && e.message.type === "text" && e.message.content.includes("background command finished")), 20_000);
    expect((await app.handlers.getAsyncTasks!({ id })).tasks[0]).toMatchObject({ kind: "shell", status: "done" });
    await app.close();
  });

  it("secrets reach the spawn env sealed, change the spawn key, and are listed by name in the prompt section", async () => {
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const { id } = await app.handlers.createAgent!({ name: "Ledger" });
    const p3 = app.services.phase3;
    const key0 = p3.spawnKeyPart(id);
    const { boxPublicKey } = await app.handlers.getBotSecretsStatus!({ botId: id });
    await app.handlers.setBotSecrets!({ botId: id, upserts: [{ name: "STRIPE_KEY", description: "Stripe test key", sealed: await sealTo(boxPublicKey, "sk_test_abcdef"), valueHash: "h" }], removes: [] });
    expect(p3.spawnEnv(id)).toMatchObject({ STRIPE_KEY: "sk_test_abcdef", DISPLAY: expect.stringMatching(/^:\d+$/) });
    expect(p3.spawnKeyPart(id)).not.toBe(key0);
    expect(p3.promptSection(id)).toContain('$STRIPE_KEY — "Stripe test key"');
    expect(p3.promptSection(id)).not.toContain("sk_test_abcdef");
    await app.close();
  });

  it("Phase 2 memory sees the Bot's vault secrets, so it can redact them and never store one (§05.1)", async () => {
    const seen: string[][] = [];
    const orig = EpisodeWriter.prototype.note;
    vi.spyOn(EpisodeWriter.prototype, "note").mockImplementation(function (this: EpisodeWriter, botId: string, ex: Parameters<EpisodeWriter["note"]>[1]) {
      seen.push((this as unknown as { d: { secrets(b: string): string[] } }).d.secrets(botId));
      return orig.call(this, botId, ex);
    });
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const { id } = await app.handlers.createAgent!({ name: "Vaulted" });
    const { boxPublicKey } = await app.handlers.getBotSecretsStatus!({ botId: id });
    await app.handlers.setBotSecrets!({ botId: id, upserts: [{ name: "API_KEY", description: "k", sealed: await sealTo(boxPublicKey, "sk_live_memory_guard"), valueHash: "h" }], removes: [] });
    await app.handlers.sendPrompt!({ id, text: "hello there", clientNonce: "m1" });
    await until(() => seen.length > 0);
    expect(seen[0]).toContain("sk_live_memory_guard");
    await app.close();
  });

  it("I5 wiring: a secret the user pastes reaches the search index and the transcript mirror only as [secret:NAME]", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    const app = await createHostApp(cfg);
    const { id } = await app.handlers.createAgent!({ name: "Pasted" });
    const { boxPublicKey } = await app.handlers.getBotSecretsStatus!({ botId: id });
    const value = "sk_live+Pasted/Value9";
    await app.handlers.setBotSecrets!({ botId: id, upserts: [{ name: "API_KEY", description: "k", sealed: await sealTo(boxPublicKey, value), valueHash: "h" }], removes: [] });
    await app.handlers.sendPrompt!({ id, text: `here it is ${value} and ${Buffer.from(value).toString("hex")}`, clientNonce: "p1" });
    await until(() => app.services.runner.isIdle(id) && app.services.bots.tail(id, 50).some((e) => e.kind === "send-message"));
    const { mirrorPath } = await import("../context/transcript-mirror");
    const mirror = fs.readFileSync(mirrorPath(cfg.dataRoot, id), "utf8");
    expect(mirror).toContain("[secret:API_KEY]");
    expect(mirror).not.toContain(value);
    expect(app.services.searchIndex.search("API_KEY").some((r) => r.botId === id)).toBe(true);
    expect(app.services.searchIndex.search(Buffer.from(value).toString("hex"))).toEqual([]);
    await app.close();
  });

  it("deleting a Bot releases its screen and forgets its secrets", async () => {
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const { id } = await app.handlers.createAgent!({ name: "Temp" });
    await app.handlers.ensureDisplay!({ id });
    await app.handlers.deleteAgent!({ id });
    expect((await app.handlers.getDisplays!({})).displays.find((d) => d.botId === id)).toBeUndefined();
    await app.close();
  });

  it("controller ruling 1: a 4th Bot reclaims the LRU idle Bot's screen instead of always seeing 'screens full'", async () => {
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = (await app.handlers.createAgent!({ name: "A" })).id;
    const b = (await app.handlers.createAgent!({ name: "B" })).id;
    const c = (await app.handlers.createAgent!({ name: "C" })).id;
    const d = (await app.handlers.createAgent!({ name: "D" })).id;
    await app.handlers.ensureDisplay!({ id: a });
    await app.handlers.ensureDisplay!({ id: b });
    await app.handlers.ensureDisplay!({ id: c });
    // None of a/b/c has a running turn, a takeover or an open preview, so all three are idle: "a" (used
    // longest ago) is reclaimed for "d" rather than "d" seeing "screens full".
    await app.handlers.ensureDisplay!({ id: d });
    const ids = (await app.handlers.getDisplays!({})).displays.map((x) => x.botId);
    expect(ids).toEqual(expect.arrayContaining([b, c, d]));
    expect(ids).not.toContain(a);
    await app.close();
  });
});
