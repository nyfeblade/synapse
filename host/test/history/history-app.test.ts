import fs from "node:fs";
import path from "node:path";
import type { TranscriptEntry } from "@synapse/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { tmpConfig } from "../helpers";

/**
 * The archive wired into the real host: bothost-private storage, live indexing from real turns, the
 * Bot-facing tool keyed by the Bot's own id, the storage readout on the gateway, and deletion.
 */
let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
const until = async (f: () => Promise<boolean> | boolean, ms = 6000) => { const t = Date.now() + ms; while (!(await f())) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

describe("history archive in the host", () => {
  it("lives in host-private storage, indexes real turns, answers only the calling Bot, and reports its size", async () => {
    const cfg = tmpConfig();
    app = await createHostApp(cfg);
    const a = app;
    const archive = a.services.historyArchive;
    expect(path.resolve(archive.file).startsWith(path.resolve(cfg.hostPrivate) + path.sep), "the archive must be outside what uid box can read").toBe(true);
    expect(path.resolve(archive.file).startsWith(path.resolve(cfg.dataRoot))).toBe(false);
    expect(fs.statSync(archive.file).mode & 0o777).toBe(0o600);

    const { id: A } = await a.handlers.createAgent!({ name: "Piper", isKickstartRequested: false });
    const { id: B } = await a.handlers.createAgent!({ name: "Quill", isKickstartRequested: false });
    const tail = (id: string) => a.services.bots.tail(id, 1000) as TranscriptEntry[];
    const say = async (id: string, text: string) => {
      const before = tail(id).length;
      await a.handlers.sendPrompt!({ id, text, clientNonce: crypto.randomUUID() } as never);
      await until(() => tail(id).length > before + 1 && a.services.runner.isIdle(id));
    };
    await say(A, "The Halvor retainer is 4500 a month.");
    await say(B, "Quill's own zebra plan is secret.");
    await a.services.historyIndexer.drain();

    const toolOf = (id: string) => a.services.runner.wiring(id).botTools().find((t) => t.name === "SearchHistory")!;
    expect(toolOf(A), "SearchHistory is mounted for every Bot").toBeTruthy();
    expect((await toolOf(A).handler({ query: "Halvor retainer" })).text).toContain("The Halvor retainer is 4500 a month.");
    const cross = await toolOf(A).handler({ query: "zebra plan", bot_id: B, agent_id: B });
    expect(cross.text).not.toContain("zebra plan is secret");

    const stats = await a.handlers.getHistoryArchiveStats!({ id: A });
    expect(stats.rows).toBeGreaterThanOrEqual(2);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.oldestAt).not.toBeNull();

    await a.handlers.deleteAgent!({ id: B } as never);
    await until(() => archive.stats(B).rows === 0);
    expect(archive.stats(A).rows).toBeGreaterThan(0);
  });
});
