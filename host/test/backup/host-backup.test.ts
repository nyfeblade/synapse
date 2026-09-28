import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyPendingRestore, readLastRestore, snapshotHostState, stageRestore } from "../../backup/host-backup";
import { readRecords } from "../../backup/records";
import { FactLedger, ledgerRef } from "../../memory/ledger";
import { tmpConfig } from "../helpers";

const BOT = "3f2a9c1e-0000-4000-8000-000000000001";

function seed() {
  const cfg = tmpConfig();
  const bot = path.join(cfg.dataRoot, "agents", BOT);
  fs.mkdirSync(bot, { recursive: true });
  fs.writeFileSync(path.join(bot, "profile.json"), JSON.stringify({ name: "Nova" }));
  fs.writeFileSync(path.join(cfg.dataRoot, "settings.json"), "{\"a\":1}");
  fs.mkdirSync(path.join(cfg.dataRoot, "user-memory", "agents", BOT), { recursive: true });
  fs.writeFileSync(path.join(cfg.dataRoot, "user-memory", "agents", BOT, "facts.md"), "likes tea");
  fs.mkdirSync(cfg.hostPrivate, { recursive: true });
  // A live WAL database with rows only in the WAL: a plain file copy would lose them.
  const live = new DatabaseSync(path.join(bot, "store.db"));
  live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v TEXT);");
  live.prepare("INSERT INTO t VALUES (?)").run("in-the-wal");
  const hist = new DatabaseSync(path.join(cfg.hostPrivate, "history-archive.db"));
  hist.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE h(v TEXT); INSERT INTO h VALUES ('old chat');");
  for (const [f, v] of [["chains.json", "[]"], ["gateway.json", "{\"token\":\"GATEWAY\"}"], ["claude-oauth-token", "sk-ant-oat01-secret"], ["box-keypair.json", "{}"], ["host.lock", "1"]] as const) fs.writeFileSync(path.join(cfg.hostPrivate, f), v);
  fs.writeFileSync(path.join(cfg.hostPrivate, "vault.key"), Buffer.alloc(32, 7));
  fs.mkdirSync(path.join(cfg.hostPrivate, "mcp"));
  fs.writeFileSync(path.join(cfg.hostPrivate, "mcp", "servers.json"), "SEALED-CIPHERTEXT");
  fs.mkdirSync(path.join(cfg.hostPrivate, "snapshots"));
  fs.writeFileSync(path.join(cfg.hostPrivate, "snapshots", "snap-x.tar.zst"), "huge");
  return { cfg, live, hist, bot };
}

async function snapshotBytes(cfg: ReturnType<typeof tmpConfig>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await snapshotHostState(cfg, { bots: () => [{ id: BOT, name: "Nova" }], hostVersion: "0.1.0", now: () => 1_000 })) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function entries(gz: Buffer) {
  const out = new Map<string, Buffer>();
  for await (const r of readRecords(Readable.from([gz]).pipe(createGunzip()))) out.set(r.meta.p, r.data);
  return out;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("host backup snapshot", () => {
  it("holds Bot folders, live databases (WAL rows included), host history and sealed stores — never the host's own keys or tokens", async () => {
    const { cfg, live, hist } = seed();
    const e = await entries(await snapshotBytes(cfg));
    const manifest = JSON.parse(e.get("manifest.json")!.toString());
    expect(manifest).toMatchObject({ kind: "synapse-host-backup", v: 1, hostVersion: "0.1.0", createdAt: 1_000, bots: [{ id: BOT, name: "Nova" }] });
    expect(manifest.vaultKeyId).toMatch(/^[0-9a-f]{16}$/);
    expect(e.has(`data/agents/${BOT}/profile.json`)).toBe(true);
    expect(e.get(`data/user-memory/agents/${BOT}/facts.md`)!.toString()).toBe("likes tea");
    expect(e.has("private/chains.json")).toBe(true);
    expect(e.get("sealed/mcp/servers.json")!.toString()).toBe("SEALED-CIPHERTEXT");
    for (const k of e.keys()) expect(k).not.toMatch(/gateway\.json|claude-oauth-token|vault\.key|box-keypair|host\.lock|snapshots|-wal$|-shm$/);
    const copy = path.join(cfg.hostPrivate, "check.db");
    fs.writeFileSync(copy, e.get(`data/agents/${BOT}/store.db`)!);
    expect(new DatabaseSync(copy).prepare("SELECT v FROM t").all()).toEqual([{ v: "in-the-wal" }]);
    fs.writeFileSync(copy, e.get("private/history-archive.db")!);
    expect(new DatabaseSync(copy).prepare("SELECT v FROM h").all()).toEqual([{ v: "old chat" }]);
    live.close(); hist.close();
  });

  // Memory provenance: the fact ledger is host state (history and provenance live nowhere else), so every backup holds
  // it, live rows included, and the copy opens as a working ledger with its history.
  it("holds the memory fact ledger (history and provenance) and team memory", async () => {
    const { cfg, live, hist } = seed();
    const ledger = new FactLedger(path.join(cfg.hostPrivate, "memory-ledger.db"), () => 5_000);
    const ref = ledgerRef({ kind: "team", botId: BOT });
    ledger.record(ref, { factId: "a", text: "The office wifi name is Harbor.", date: "2026-01-01" }, { botId: BOT, chatId: BOT, messageId: "t3u", source: "user", confidence: 0.8 });
    const now = ledger.record(ref, { factId: "b", text: "The office wifi name is Lantern.", date: "2026-02-01" }, { botId: BOT, source: "user", confidence: 0.8 });
    ledger.end(ref.shard, "a", now.id);
    fs.mkdirSync(path.join(cfg.dataRoot, "team-memory", "agents", BOT), { recursive: true });
    fs.writeFileSync(path.join(cfg.dataRoot, "team-memory", "agents", BOT, "profile.md"), "- (2026-02-01) The office wifi name is Lantern.\n");
    const e = await entries(await snapshotBytes(cfg));
    expect(e.has(`data/team-memory/agents/${BOT}/profile.md`)).toBe(true);
    const copy = path.join(cfg.hostPrivate, "restored-ledger.db");
    fs.writeFileSync(copy, e.get("private/memory-ledger.db")!);
    const back = new FactLedger(copy);
    expect(back.history(now.id)).toMatchObject([{ text: "The office wifi name is Harbor.", messageId: "t3u", source: "user" }]);
    back.dispose(); ledger.dispose(); live.close(); hist.close();
  });
});

describe("host restore", () => {
  it("applies a staged snapshot at start-up, keeps the host's keys, and reports the result", async () => {
    const { cfg, live, hist, bot } = seed();
    const snap = await snapshotBytes(cfg);
    live.close(); hist.close();
    // After the backup: the Bot is deleted, settings change, a new token appears, history grows.
    fs.rmSync(bot, { recursive: true });
    fs.writeFileSync(path.join(cfg.dataRoot, "settings.json"), "{\"a\":2}");
    fs.writeFileSync(path.join(cfg.hostPrivate, "gateway.json"), "{\"token\":\"NEW\"}");
    fs.writeFileSync(path.join(cfg.hostPrivate, "history-archive.db-wal"), "stale wal");
    await stageRestore(cfg, Readable.from([snap]), sha(snap), () => 5_000);
    const r = await applyPendingRestore(cfg, () => 6_000);
    expect(r).toMatchObject({ ok: true, bots: 1, sealed: "applied" });
    expect(fs.readFileSync(path.join(cfg.dataRoot, "settings.json"), "utf8")).toBe("{\"a\":1}");
    expect(fs.existsSync(path.join(bot, "profile.json"))).toBe(true);
    expect(new DatabaseSync(path.join(bot, "store.db")).prepare("SELECT v FROM t").all()).toEqual([{ v: "in-the-wal" }]);
    expect(fs.existsSync(path.join(cfg.hostPrivate, "history-archive.db-wal"))).toBe(false);
    expect(new DatabaseSync(path.join(cfg.hostPrivate, "history-archive.db")).prepare("SELECT v FROM h").all()).toEqual([{ v: "old chat" }]);
    expect(fs.readFileSync(path.join(cfg.hostPrivate, "gateway.json"), "utf8")).toBe("{\"token\":\"NEW\"}");
    expect(fs.readFileSync(path.join(cfg.hostPrivate, "claude-oauth-token"), "utf8")).toBe("sk-ant-oat01-secret");
    expect(readLastRestore(cfg)).toMatchObject({ ok: true, at: 6_000 });
    expect(await applyPendingRestore(cfg, () => 7_000)).toBeNull(); // applied once
  });

  it("skips sealed stores sealed with another box's vault key", async () => {
    const { cfg, live, hist } = seed();
    const snap = await snapshotBytes(cfg);
    live.close(); hist.close();
    fs.chmodSync(path.join(cfg.hostPrivate, "vault.key"), 0o600);
    fs.writeFileSync(path.join(cfg.hostPrivate, "vault.key"), Buffer.alloc(32, 9));
    fs.writeFileSync(path.join(cfg.hostPrivate, "mcp", "servers.json"), "THIS-BOX");
    await stageRestore(cfg, Readable.from([snap]), sha(snap), () => 5_000);
    expect(await applyPendingRestore(cfg, () => 6_000)).toMatchObject({ ok: true, sealed: "skipped" });
    expect(fs.readFileSync(path.join(cfg.hostPrivate, "mcp", "servers.json"), "utf8")).toBe("THIS-BOX");
  });

  it("refuses a bad checksum, and a staged restore nobody applied within 10 minutes is dropped", async () => {
    const { cfg, live, hist } = seed();
    const snap = await snapshotBytes(cfg);
    live.close(); hist.close();
    await expect(stageRestore(cfg, Readable.from([snap]), "0".repeat(64), () => 5_000)).rejects.toThrow(/checksum/);
    expect(await applyPendingRestore(cfg, () => 6_000)).toBeNull();
    await stageRestore(cfg, Readable.from([snap]), sha(snap), () => 5_000);
    fs.writeFileSync(path.join(cfg.dataRoot, "settings.json"), "{\"a\":3}");
    expect(await applyPendingRestore(cfg, () => 5_000 + 11 * 60_000)).toMatchObject({ ok: false });
    expect(fs.readFileSync(path.join(cfg.dataRoot, "settings.json"), "utf8")).toBe("{\"a\":3}");
  });

  it("puts everything back when the snapshot is damaged half-way", async () => {
    const { cfg, live, hist } = seed();
    const snap = await snapshotBytes(cfg);
    live.close(); hist.close();
    fs.writeFileSync(path.join(cfg.dataRoot, "settings.json"), "{\"a\":4}");
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const raw = gunzipSync(snap);
    const broken = gzipSync(raw.subarray(0, raw.length - 10));
    await stageRestore(cfg, Readable.from([broken]), sha(broken), () => 5_000);
    expect(await applyPendingRestore(cfg, () => 6_000)).toMatchObject({ ok: false });
    expect(fs.readFileSync(path.join(cfg.dataRoot, "settings.json"), "utf8")).toBe("{\"a\":4}");
  });
});
