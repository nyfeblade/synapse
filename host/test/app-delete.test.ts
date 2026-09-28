import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApp } from "../app";
import { sealTo } from "../secrets/crypto";
import { tmpConfig } from "./helpers";

/**
 * Security fix I6 (06:45 ruling): delete order is mark deleted + interrupt → Phase 3 cleanup (shells, subagents,
 * displays) → drain/drop the memory chain → clear memory → session files (child sessions included), the
 * connector-secrets dir and the vault (revision bump + listeners); the browser refs are cleared.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("deleteAgent order and leftovers (I6)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the ruling's order and removes child sessions, connector secrets, vault, refs", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    const app = await createHostApp(cfg);
    const { bots, phase3, memory, runner, memoryEngine } = app.services;
    const { id } = await app.handlers.createAgent!({ name: "Doomed" });
    const { boxPublicKey } = await app.handlers.getBotSecretsStatus!({ botId: id });
    await app.handlers.setBotSecrets!({ botId: id, upserts: [{ name: "API_KEY", description: "k", sealed: await sealTo(boxPublicKey, "sk_live_delete_me"), valueHash: "h" }], removes: [] });
    // Leftovers a Bot can accumulate.
    const conn = path.join(cfg.hostPrivate, "connector-secrets", id);
    fs.mkdirSync(conn, { recursive: true });
    fs.writeFileSync(path.join(conn, "linear.json"), '{"value":"x"}');
    const childFile = path.join(cfg.claudeConfigDir, "projects", "-workspace", "child-sid.jsonl");
    fs.mkdirSync(path.dirname(childFile), { recursive: true });
    fs.writeFileSync(childFile, "{}\n");
    phase3.subagents["d"].onChildSession?.(id, "child-sid");
    const viewId = bots.sessionId(id) ?? id;
    phase3.browser.setRefs(viewId, new Map([["e1", 42]]));
    const changed: string[] = [];
    phase3.vault.onChange((b) => changed.push(b));

    const order: string[] = [];
    const spy = <T extends object>(o: T, k: keyof T & string, label: string) => {
      const orig = (o[k] as unknown as (...a: unknown[]) => unknown).bind(o);
      vi.spyOn(o, k as never).mockImplementation(((...a: unknown[]) => { order.push(label); return orig(...a); }) as never);
    };
    let deletedWhenShellsStopped = false;
    const origForget = phase3.shells.forgetBot.bind(phase3.shells);
    vi.spyOn(phase3.shells, "forgetBot").mockImplementation(async (b) => { order.push("shells"); deletedWhenShellsStopped = runner["rt"].get(b)?.deleted === true; return origForget(b); });
    spy(phase3.subagents, "forgetBot", "subagents");
    spy(phase3.displays, "release", "displays");
    spy(memoryEngine, "dropBot", "memory-drop");
    spy(memory, "clearBot", "memory-clear");
    spy(bots, "remove", "session-files");
    spy(phase3.vault, "removeBot", "vault");

    await app.handlers.deleteAgent!({ id });
    expect(deletedWhenShellsStopped).toBe(true);
    expect(order).toEqual(["subagents", "shells", "displays", "memory-drop", "memory-clear", "session-files", "vault"]);
    expect(fs.existsSync(childFile)).toBe(false);
    expect(fs.existsSync(conn)).toBe(false);
    expect(changed).toContain(id);
    expect(phase3.vault.env(id)).toEqual({});
    expect(phase3.scanners.check(id, "sk_live_delete_me")).toBeNull();
    expect(phase3.browser.ref(viewId, "e1")).toBeNull();
    await app.close();
  });

  it("a turn racing the delete can't start a new shell or display", async () => {
    const cfg = tmpConfig({ FUZZ: "1" });
    const app = await createHostApp(cfg);
    const { phase3 } = app.services;
    const { id } = await app.handlers.createAgent!({ name: "Racer" });
    const shell = phase3.botTools(id).find((t) => t.name === "Shell")!;
    const marker = path.join(cfg.workspace, "raced-marker");
    // A shell started in the same tick as the delete is stopped by it; one after it is refused.
    const started = shell.handler({ command: `sleep 0.6; touch ${marker}`, block_until_ms: 0 });
    const del = app.handlers.deleteAgent!({ id });
    await started;
    await del;
    const late = await shell.handler({ command: `touch ${marker}-late`, block_until_ms: 0 });
    expect(late.isError).toBe(true);
    await expect(phase3.displays.ensure(id)).rejects.toThrow();
    expect(phase3.displays.list().find((d) => d.botId === id)).toBeUndefined();
    expect(phase3.displays.env(id)).toEqual({});
    const task = await phase3.subagents.launch(id, { description: "x", prompt: "y" });
    expect(task.isError).toBe(true);
    await wait(900);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(`${marker}-late`)).toBe(false);
    await app.close();
  });
});
