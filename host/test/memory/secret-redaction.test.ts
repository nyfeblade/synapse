import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import type { OneShotModel } from "../../brain/one-shot";
import { mirrorPath, startTranscriptMirror } from "../../context/transcript-mirror";
import { Rollover } from "../../context/rollover";
import { SseHub } from "../../gateway/sse-hub";
import { createMemoryEngineHooks } from "../../memory/engine";
import { EpisodeWriter } from "../../memory/episodes";
import { MemoryExtractor } from "../../memory/extractor";
import { MemoryStore } from "../../memory/memory-store";
import type { SettledTurn } from "../../runner/hooks";
import { SearchIndex } from "../../search/search-index";
import { ScannerRegistry } from "../../secrets/scanner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { TrayService } from "../../trays/trays";
import { log } from "../../util/log";
import { tmpConfig } from "../helpers";

/** Security fix I5: Phase 2 stores never keep a Bot's secret, raw or encoded (base64, hex, URL). */
const SECRET = "sk_live+Zq81/memGuard!";
const B64 = Buffer.from(SECRET).toString("base64").replace(/=+$/, "");
const HEX = Buffer.from(SECRET).toString("hex");
const URLENC = encodeURIComponent(SECRET);
const forms = [SECRET, B64, HEX, URLENC];

function fakeVault() {
  const vals = new Map<string, { name: string; value: string }[]>();
  const ls = new Set<(b: string) => void>();
  return {
    set(botId: string, v: { name: string; value: string }[]) { vals.set(botId, v); for (const l of ls) l(botId); },
    values: (botId: string) => vals.get(botId) ?? [],
    onChange: (cb: (b: string) => void) => { ls.add(cb); return () => ls.delete(cb); },
  };
}

const turn = (user: string, bot: string): SettledTurn => ({
  source: "user", lane: "user", hidden: false, requestId: "r", turnNo: 1, userSeqMax: 1, userTexts: [user], sentTexts: [bot], finalText: "",
  aborted: false, superseded: false, error: null, usage: {} as SettledTurn["usage"], startedAt: 0, firstEventAt: null, endedAt: 1,
});

function memSetup(o: { batch?: number } = {}) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const vault = fakeVault();
  vault.set(id, [{ name: "API_KEY", value: SECRET }]);
  const scanners = new ScannerRegistry(vault);
  const store = new MemoryStore({ cfg });
  const prompts: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  // The model echoes the exchange back as facts, so anything unredacted it saw would be stored.
  const model: OneShotModel = {
    complete: async (p) => {
      prompts.push(p.user);
      await gate;
      const ex = (JSON.parse(p.user) as { exchange?: { user: string; bot: string } }).exchange;
      return ex ? `profile: ${ex.user.slice(0, 200)}\nlog: ${ex.bot.slice(0, 200)}` : "NONE";
    },
  } as OneShotModel;
  const opts = { store, model, timeZone: () => "UTC", nameOf: () => "Piper", secrets: (b: string) => vault.values(b).map((v) => v.value) };
  const hooks = createMemoryEngineHooks({
    extractor: new MemoryExtractor(opts), episodes: new EpisodeWriter({ ...opts, bots }),
    redact: (b, t) => scanners.redact(b, t), secrets: (b) => vault.values(b).map((v) => v.value), ...(o.batch ? { batch: o.batch } : {}),
  });
  return { cfg, bots, id, vault, store, prompts, hooks, release };
}

describe("memory captures secrets when the turn settles (I5)", () => {
  it("redacts raw and encoded forms at afterSettle, even if the vault is emptied before the job runs", async () => {
    const s = memSetup();
    s.hooks.afterSettle!(s.id, turn(`My key is ${SECRET}; base64 ${B64}; hex ${HEX}; url ${URLENC}. Please remember where the invoices live?`, `Stored ${B64} for you.`));
    s.vault.set(s.id, []); // the Bot's secrets are removed before the job gets to run
    s.release();
    await s.hooks.drain();
    expect(s.prompts.length).toBeGreaterThan(0);
    for (const p of s.prompts) for (const f of forms) expect(p, f).not.toContain(f);
    const stored = JSON.stringify(s.store.all({ kind: "agent", botId: s.id }));
    for (const f of forms) expect(stored).not.toContain(f);
    expect(JSON.stringify(s.bots.require(s.id).store.getKv("episodePending", []))).not.toContain(SECRET);
  });

  // The per-Bot job chain, one job per exchange (batch 1); batching and a dropped Bot's pending batch are pinned in engine.test.ts.
  it("dropBot() drops queued jobs and waits for the one in flight", async () => {
    const s = memSetup({ batch: 1 });
    s.hooks.afterSettle!(s.id, turn("Can you remember that the invoices are in the blue folder?", "Sure."));
    s.hooks.afterSettle!(s.id, turn("Can you also remember that Dana likes the Q3 numbers first?", "Sure."));
    await new Promise((r) => setTimeout(r, 10));
    let dropped = false;
    const p = s.hooks.dropBot(s.id).then(() => { dropped = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(dropped).toBe(false); // the in-flight extraction is still running
    s.release();
    await p;
    const calls = s.prompts.length;
    await s.hooks.drain();
    expect(s.prompts.length).toBe(calls); // nothing queued ran after the drop
    expect(calls).toBe(1);
    s.hooks.afterSettle!(s.id, turn("Can you remember one more thing about the blue folder?", "Sure."));
    await s.hooks.drain();
    expect(s.prompts.length).toBe(1); // a dropped Bot gets no new jobs
  });
});

describe("Phase 2 stores redact with the scanner (I5)", () => {
  const entry = (id: string, content: string): TranscriptEntry => ({ kind: "message", id, createdAt: 1, content } as TranscriptEntry);

  it("the search index never stores a secret, raw or encoded", () => {
    const cfg = tmpConfig();
    fs.mkdirSync(cfg.hostPrivate, { recursive: true });
    const vault = fakeVault();
    vault.set("b1", [{ name: "API_KEY", value: SECRET }]);
    const scanners = new ScannerRegistry(vault);
    const idx = new SearchIndex(path.join(cfg.hostPrivate, "search.db"), { redact: (b, t) => scanners.redact(b, t) });
    idx.upsertEntry("b1", entry("m1", `key ${SECRET} and ${HEX} at https://x.example/?k=${URLENC}&b=${B64}`));
    expect(idx.search(HEX)).toEqual([]);
    const raw = fs.readFileSync(path.join(cfg.hostPrivate, "search.db")).toString("latin1") + (fs.existsSync(path.join(cfg.hostPrivate, "search.db-wal")) ? fs.readFileSync(path.join(cfg.hostPrivate, "search.db-wal")).toString("latin1") : "");
    for (const f of forms) expect(raw).not.toContain(f);
    expect(idx.search("API_KEY").length).toBeGreaterThan(0);
    idx.close();
  });

  it("the transcript mirror never writes a secret, raw or encoded", () => {
    const cfg = tmpConfig();
    const hub = new SseHub();
    const vault = fakeVault();
    vault.set("b1", [{ name: "API_KEY", value: SECRET }]);
    const scanners = new ScannerRegistry(vault);
    const stop = startTranscriptMirror({ hub, dataRoot: cfg.dataRoot, redact: (b, t) => scanners.redact(b, t) });
    hub.publish({ channel: "transcript", payload: { botId: "b1", op: "append", entry: entry("m1", `key ${SECRET} / ${B64} / ${HEX} / ${URLENC}`) } } as never);
    stop();
    const text = fs.readFileSync(mirrorPath(cfg.dataRoot, "b1"), "utf8");
    for (const f of forms) expect(text).not.toContain(f);
    expect(text).toContain("[secret:API_KEY]");
  });

  it("the rollover tail copy and the handoff summary are redacted", async () => {
    const cfg = tmpConfig();
    initLayout(cfg);
    const hub = new SseHub();
    const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
    const bots = new BotService({ cfg, hub, settings });
    const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
    bots.setSessionId(id, "old-sid");
    const vault = fakeVault();
    vault.set(id, [{ name: "API_KEY", value: SECRET }]);
    const scanners = new ScannerRegistry(vault);
    const oldFile = bots.sessionFilePath(id)!;
    const recs = [
      { type: "system", subtype: "compact_boundary", sessionId: "old-sid" },
      { type: "user", isCompactSummary: true, message: { content: `Summary: the key is ${SECRET}` } },
      { type: "user", toolUseResult: { stdout: `${B64} ${HEX} ${URLENC}` }, message: { content: "x" } },
    ];
    const written: Record<string, string> = {};
    const hidden: string[] = [];
    const runner = {
      runMaintenance: (_b: string, job: { run: (s: AbortSignal) => Promise<void> | void }) => { void job.run(new AbortController().signal); return true; },
      enqueueHidden: (_b: string, spec: { text: string }) => hidden.push(spec.text), retryUserTurn: () => {},
    };
    const mk = (fail: boolean) => new Rollover({
      cfg, bots, runner: runner as never, trays: new TrayService(hub), flags: () => ({ rolloverBytes: 1 }) as never, now: () => 5, newId: () => "new-sid",
      readSession: () => Buffer.from(recs.map((r) => JSON.stringify(r)).join("\n")),
      writeSession: (p, d) => { if (fail) throw new Error("helper down"); written[p] = d.toString("utf8"); },
      sizeOf: () => 0, redact: (b, t) => scanners.redact(b, t),
    });
    mk(false).rollNow(id, "test");
    await new Promise((r) => setTimeout(r, 10));
    const copy = Object.values(written).join("\n");
    expect(copy).toContain("new-sid");
    for (const f of forms) expect(copy).not.toContain(f);
    bots.setSessionId(id, "old-sid");
    void oldFile;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    mk(true).rollNow(id, "test");
    await new Promise((r) => setTimeout(r, 10));
    warn.mockRestore();
    expect(hidden.length).toBe(1);
    for (const f of forms) expect(hidden[0]).not.toContain(f);
  });
});
