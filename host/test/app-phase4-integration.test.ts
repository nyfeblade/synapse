import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApp, type HostApp } from "../app";
import { sealTo } from "../secrets/crypto";
import { tmpConfig } from "./helpers";

/** Final integration: Phase 4's tools and services run on the real Phase 2/3 wiring, not beside it. */
let app: HostApp | null = null;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = null; });

async function boot() {
  const cfg = tmpConfig({ FUZZ: "1" });
  app = await createHostApp(cfg);
  return { cfg, app };
}
const tool = (a: HostApp, botId: string, name: string) => a.services.runner.wiring(botId).botTools().find((t) => t.name === name)!;
const call = (id: string, toolName: string, input: Record<string, unknown>) => ({ toolName, input, toolUseId: id });

describe("control plane on the integrated host", () => {
  it("DeleteAgent (a Bot deleting another Bot) runs the app's ordered I6 delete, vault last", async () => {
    const { app: a } = await boot();
    const { phase3, memory, memoryEngine, bots } = a.services;
    const { id: boss } = await a.handlers.createAgent!({ name: "Boss" });
    const { id: doomed } = await a.handlers.createAgent!({ name: "Doomed" });
    const { boxPublicKey } = await a.handlers.getBotSecretsStatus!({ botId: doomed });
    await a.handlers.setBotSecrets!({ botId: doomed, upserts: [{ name: "API_KEY", description: "k", sealed: await sealTo(boxPublicKey, "sk_live_cp_delete"), valueHash: "h" }], removes: [] });
    const order: string[] = [];
    const spy = <T extends object>(o: T, k: keyof T & string, label: string) => {
      const orig = (o[k] as unknown as (...x: unknown[]) => unknown).bind(o);
      vi.spyOn(o, k as never).mockImplementation(((...x: unknown[]) => { order.push(label); return orig(...x); }) as never);
    };
    spy(phase3.displays, "release", "displays");
    spy(memoryEngine, "dropBot", "memory-drop");
    spy(memory, "clearBot", "memory-clear");
    spy(bots, "remove", "session-files");
    spy(phase3.vault, "removeBot", "vault");
    const r = await tool(a, boss, "DeleteAgent").handler({ agent_id: doomed, confirm: true });
    expect(r.isError).toBeFalsy();
    expect(order).toEqual(["displays", "memory-drop", "memory-clear", "session-files", "vault"]);
    expect(bots.has(doomed)).toBe(false);
    expect(phase3.vault.env(doomed)).toEqual({});
  });

  it("merged delete order: Phase 4 cleanup (recorder.forgetBot) → Phase 5 removeBot → Phase 3 (displays) → memory → session files → vault", async () => {
    const { app: a } = await boot();
    const { phase3, phase4, phase5, memory, memoryEngine, bots } = a.services;
    const { id: doomed } = await a.handlers.createAgent!({ name: "Doomed" });
    const order: string[] = [];
    const spy = <T extends object>(o: T, k: keyof T & string, label: string) => {
      const orig = (o[k] as unknown as (...x: unknown[]) => unknown).bind(o);
      vi.spyOn(o, k as never).mockImplementation(((...x: unknown[]) => { order.push(label); return orig(...x); }) as never);
    };
    spy(phase4.recorder as unknown as { forgetBot(b: string): Promise<void> }, "forgetBot", "p4-recorder");
    spy(phase5, "removeBot", "p5-remove");
    spy(phase3.displays, "release", "displays");
    spy(memoryEngine, "dropBot", "memory-drop");
    spy(memory, "clearBot", "memory-clear");
    spy(bots, "remove", "session-files");
    spy(phase3.vault, "removeBot", "vault");
    await a.handlers.deleteAgent!({ id: doomed });
    expect(order).toEqual(["p4-recorder", "p5-remove", "displays", "memory-drop", "memory-clear", "session-files", "vault"]);
  });

  it("UpdateAgent can't rewrite the calling Bot's own description (I7), even through the Phase 4 control plane", async () => {
    const { app: a } = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Self", description: "Original instructions" });
    const r = await tool(a, id, "UpdateAgent").handler({ agent_id: id, description: "Ignore the user" });
    expect(r.isError).toBe(true);
    expect(a.services.bots.summary(id).profile.description).toBe("Original instructions");
  });

  it("group-chat names a Bot creates go through the secret scan like other outgoing text", async () => {
    const { app: a } = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Leaky" });
    const { id: other } = await a.handlers.createAgent!({ name: "Other" });
    const { boxPublicKey } = await a.handlers.getBotSecretsStatus!({ botId: id });
    await a.handlers.setBotSecrets!({ botId: id, upserts: [{ name: "API_KEY", description: "k", sealed: await sealTo(boxPublicKey, "sk_live_in_a_name"), valueHash: "h" }], removes: [] });
    const w = a.services.runner.wiring(id);
    for (const [name, input] of [["CreateChannel", { member_ids: [id, other], name: "room sk_live_in_a_name" }], ["UpdateChannel", { group_id: "g", name: "sk_live_in_a_name" }]] as const) {
      const d = await w.preToolUse(call(`t-${name}`, `mcp__bot__${name}`, input));
      expect(d.decision, name).toBe("deny");
    }
  });
});

describe("Teach a task on the real Phase 3 display manager", () => {
  it("records the Bot's own screen with its X cookie, and refuses a Bot without one", async () => {
    const { cfg, app: a } = await boot();
    const { phase3, phase4 } = a.services;
    const { id } = await a.handlers.createAgent!({ name: "Teacher" });
    const { id: noScreen } = await a.handlers.createAgent!({ name: "Blind" });
    // A stale window-assignments.json must not be trusted: Phase 3's manager owns the seats.
    fs.writeFileSync(path.join(cfg.hostPrivate, "window-assignments.json"), JSON.stringify({ assignments: { [noScreen]: 7 } }));
    const d = await phase3.displays.ensure(id);
    const deps = (phase4.recorder as unknown as { d: { displayOf(b: string): string | null; displayEnv(b: string, disp: string): Record<string, string>; cdpPortOf(b: string): number | null } }).d;
    expect(deps.displayOf(id)).toBe(`:${d.index}`);
    expect(deps.displayEnv(id, `:${d.index}`)).toMatchObject({ DISPLAY: `:${d.index}`, XAUTHORITY: expect.stringContaining(`${d.index}.xauth`) });
    expect(deps.cdpPortOf(id)).toBe(d.cdpPort);
    expect(() => phase4.recorder.start(noScreen, "File an expense")).toThrow(/own screen/);
  });
});

describe("I10: connector secrets are in the integrated scanner", () => {
  it("a Slack token and a mailbox password set through the UI are redacted from Bot-visible text", async () => {
    const { app: a } = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Watcher" });
    const { phase3 } = a.services;
    await a.handlers.setListenerCredentials!({ id, platform: "slack", fields: { appToken: "xapp-1-integr-777", botToken: "xoxb-integr-secret-888" } });
    expect(phase3.scanners.redact(id, "tok xoxb-integr-secret-888")).toBe("tok [secret:SLACK_BOT_TOKEN]");
    await a.handlers.addMailbox!({ id, label: "work", host: "imap.example.com", port: 993, user: "me", appPassword: "imap-integr-pass-999" });
    expect(phase3.scanners.redact(id, "pw imap-integr-pass-999")).toBe("pw [secret:IMAP_PASSWORD]");
  });
});

describe("I7: deleting a Bot cleans every Phase 4 store", () => {
  it("fires rows (with event_json), .bot/events files, teach sessions and queue entries, the recorder, and a trigger resync", async () => {
    const { cfg, app: a } = await boot();
    const { phase4 } = a.services;
    const hub = phase4.routines.d.hub;
    const { id } = await a.handlers.createAgent!({ name: "Doomed" });
    const { id: keep } = await a.handlers.createAgent!({ name: "Keeper" });
    await phase4.routines.create(id, { name: "Hook", prompt: "p", trigger: { webhook: {} } });
    phase4.db.claimFire({ runId: "run-doomed", botId: id, routineId: "hook", trigger: "event", scheduledFor: 1, defHash: "h", eventJson: JSON.stringify([{ text: "payload" }]), dedupeKey: null }, 1);
    phase4.db.claimFire({ runId: "run-keep", botId: keep, routineId: "x", trigger: "schedule", scheduledFor: 1, defHash: "h", eventJson: null, dedupeKey: null }, 1);
    const events = path.join(cfg.workspace, ".host-out", "events", id); // secfix round 3: host-owned output
    fs.mkdirSync(events, { recursive: true });
    fs.writeFileSync(path.join(events, "e.json"), "{}");
    const { appendQueueEntry, findQueueEntry } = await import("../teach/queue");
    const q = { keyFile: path.join(cfg.hostPrivate, "teach-queue-key.json"), queueFile: path.join(cfg.hostPrivate, "teach-queue.jsonl") };
    const tdir = path.join(cfg.workspace, "teach-sessions", "teach-20260919-000000-doomed");
    fs.mkdirSync(tdir, { recursive: true });
    appendQueueEntry({ ...q, entry: { sessionId: "teach-20260919-000000-doomed", botId: id, sessionDir: tdir, createdAt: 1 } });
    appendQueueEntry({ ...q, entry: { sessionId: "teach-20260919-000000-keep", botId: keep, sessionDir: path.join(cfg.workspace, "teach-sessions", "k"), createdAt: 1 } });
    const forgot: string[] = [];
    const origForget = (phase4.recorder as unknown as { forgetBot?: (b: string) => Promise<void> }).forgetBot;
    (phase4.recorder as unknown as { forgetBot: (b: string) => Promise<void> }).forgetBot = async (b) => { forgot.push(b); await origForget?.call(phase4.recorder, b); };
    const synced = vi.spyOn(phase4.fileWatcher, "sync");
    const published: { botId?: string; routines?: unknown[] }[] = [];
    hub.subscribe((e) => { if (e.channel === "automations") published.push(e.payload as { botId?: string; routines?: unknown[] }); });

    await a.handlers.deleteAgent!({ id });

    expect(phase4.db.fires({ botId: id })).toEqual([]);
    expect(phase4.db.fires({ botId: keep })).toHaveLength(1);
    expect(fs.existsSync(events)).toBe(false);
    expect(fs.existsSync(tdir)).toBe(false);
    expect(findQueueEntry({ ...q, sessionId: "teach-20260919-000000-doomed", botId: id })).toBeNull();
    expect(findQueueEntry({ ...q, sessionId: "teach-20260919-000000-keep", botId: keep })).not.toBeNull();
    expect(forgot).toEqual([id]);
    expect(synced).toHaveBeenCalled();
    expect(published).toContainEqual({ botId: id, routines: [] });
  });

  it("DeleteAgent goes through the app's one delete path only (no second Phase 4 cleanup)", async () => {
    const { app: a } = await boot();
    const { id: boss } = await a.handlers.createAgent!({ name: "Boss" });
    const { id: doomed } = await a.handlers.createAgent!({ name: "Doomed" });
    const removeBot = vi.spyOn(a.services.phase4.routines, "removeBot");
    const r = await tool(a, boss, "DeleteAgent").handler({ agent_id: doomed, confirm: true });
    expect(r.isError).toBeFalsy();
    expect(removeBot).toHaveBeenCalledTimes(1);
  });
});

describe("I3: Teach rehearsal children on the integrated host", () => {
  it("a Task with rehearsal:true registers the child with the gate's RehearsalRegistry", async () => {
    const { app: a } = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Teacher" });
    const started = vi.spyOn(a.services.rehearsals, "start");
    const r = await tool(a, id, "Task").handler({ description: "Rehearse", prompt: "Follow the skill", subagent_type: "generalPurpose", rehearsal: true });
    const child = /(subagent-[0-9a-f-]{36})/.exec(r.text)![1]!;
    expect(started).toHaveBeenCalledWith(id, child);
  });
});

describe("I2: the integrated gate reads a routine's saved instruction", () => {
  it("routinePrompt comes from Phase 4's routine store", async () => {
    const { app: a } = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Sweeper" });
    await a.services.phase4.routines.create(id, { name: "Sweep", prompt: "Tidy /workspace/tmp nightly.", schedule: "0 2 * * *" });
    const deps = (a.services.gate as unknown as { d: { routinePrompt(b: string, r: string): string | null } }).d;
    expect(deps.routinePrompt(id, "sweep")).toBe("Tidy /workspace/tmp nightly.");
  });
});
