import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { END_RECORD, encodeRecord, readRecords } from "@synapse/host/backup/records";
import { BackupService, type BackupDeps } from "../../src/main/backup/service";
import { recoveryCode } from "../../src/main/backup/archive";

const hostStream = (bots: { id: string; name: string }[]) => gzipSync(Buffer.concat([
  encodeRecord("manifest.json", Buffer.from(JSON.stringify({ kind: "synapse-host-backup", v: 1, createdAt: 1, hostVersion: "0.1.0", bots, vaultKeyId: null, files: 1, bytes: 2 }))),
  encodeRecord("data/settings.json", Buffer.from("{}"), 0o640),
  END_RECORD,
]));

async function records(gz: Buffer) {
  const out: string[] = [];
  for await (const r of readRecords(Readable.from([gunzipSync(gz)]))) out.push(`${r.meta.p}:${r.data.length}`);
  return out;
}

function rig(over: Partial<BackupDeps> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  const userData = path.join(root, "profile");
  const dir = path.join(root, "backups");
  fs.mkdirSync(path.join(userData, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(userData, "app-settings.json"), "{\"theme\":\"dark\"}");
  fs.writeFileSync(path.join(userData, "local-bot-modes.json"), "{\"b1\":\"local\"}");
  fs.writeFileSync(path.join(userData, "code-identity.json"), "{}");
  fs.writeFileSync(path.join(userData, "secrets.hashkey.bin"), "SEALED-HASHKEY");
  fs.writeFileSync(path.join(userData, "secrets", "updateToken.bin"), "SEALED-TOKEN");
  let key: Buffer | null = null;
  let bootId = "boot-1";
  const lines: string[] = [];
  const staged: Buffer[] = [];
  const events: string[] = [];
  let bots = [{ id: "b1", name: "Nova" }, { id: "b2", name: "Orbit" }];
  let now = Date.parse("2026-09-21T10:00:00Z");
  const deps: BackupDeps = {
    userData, appVersion: "0.1.0", now: () => now,
    settings: () => ({ auto: true, keep: 3, dir }),
    key: { get: () => key, set: (k) => { key = k; } },
    host: {
      snapshot: async () => { events.push("snapshot"); return Readable.from([hostStream(bots)]); },
      stage: async (file) => { events.push("stage"); staged.push(fs.readFileSync(file)); },
      health: async () => ({ ok: true, bootId, hostVersion: "0.1.0", lastRestore: bootId === "boot-2" ? { at: now, ok: true, bots: 2 } : null }),
      botCount: async () => bots.length,
      restart: async () => { events.push("restart"); bootId = "boot-2"; bots = [{ id: "b1", name: "Nova" }, { id: "b2", name: "Orbit" }]; },
      reconnect: async () => { events.push("reconnect"); },
    },
    sessions: { pull: async () => Buffer.from("SESSIONS"), push: async (b) => { events.push(`sessions:${b.toString()}`); } },
    canUnseal: () => true,
    log: (l) => lines.push(l),
    sleep: async () => {},
    ...over,
  };
  return { svc: new BackupService(deps), deps, userData, dir, lines, staged, events, getKey: () => key, tick: (ms: number) => { now += ms; }, setBots: (b: typeof bots) => { bots = b; } };
}

describe("BackupService", () => {
  it("backs up host state, Mac state and sessions into one encrypted archive, and shows the recovery code once", async () => {
    const r = rig();
    const info = await r.svc.backupNow("manual");
    expect(path.dirname(info.file)).toBe(r.dir);
    expect(path.basename(info.file)).toMatch(/^Synapse-2026-09-21-\d{6}\.synbak$/);
    const p = await r.svc.preview(info.file);
    expect(p).toMatchObject({ bots: [{ id: "b1", name: "Nova" }, { id: "b2", name: "Orbit" }], appVersion: "0.1.0", sessions: true });
    expect(p.macFiles).toEqual(expect.arrayContaining(["app-settings.json", "local-bot-modes.json", "secrets.hashkey.bin", "secrets/updateToken.bin"]));
    expect(p.macFiles).not.toContain("code-identity.json");
    const code = r.svc.pendingRecoveryCode();
    expect(code).toBe(recoveryCode(r.getKey()!));
    r.svc.ackRecoveryCode();
    expect(r.svc.pendingRecoveryCode()).toBeNull();
    await r.svc.backupNow("manual");
    expect(r.svc.pendingRecoveryCode()).toBeNull(); // the key is created once
    for (const l of r.lines) { expect(l).not.toContain(code!); expect(l).not.toContain(r.getKey()!.toString("base64")); }
    expect(r.lines.some((l) => /backup ok/.test(l))).toBe(true);
  });

  it("keeps only the newest N archives", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) { await r.svc.backupNow("auto"); r.tick(60_000); }
    expect(r.svc.list().map((a) => a.createdAt)).toHaveLength(3);
  });

  it("bug-log 128: the automatic daily backup keeps only the configured count (7) over many days", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b7-"));
    const r = rig({ settings: () => ({ auto: true, keep: 7, dir }) });
    for (let day = 0; day < 12; day++) {
      expect(await r.svc.tick()).toBe(true);
      r.tick(24 * 3600_000 + 60_000);
    }
    expect(r.svc.list()).toHaveLength(7);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".synbak"))).toHaveLength(7);
  });

  it("bug-log 128: a backup that died mid-write leaves no .part behind for long", async () => {
    const r = rig();
    fs.mkdirSync(r.dir, { recursive: true });
    const stale = path.join(r.dir, "Synapse-2026-09-01-030000.synbak.part");
    fs.writeFileSync(stale, Buffer.alloc(1024));
    const old = (Date.now() - 2 * 3600_000) / 1000;
    fs.utimesSync(stale, old, old);
    await r.svc.tick();
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("bug-log 128: skips the daily backup with a warning when the Mac has under 5 GB free, and runs again once there is room", async () => {
    let free = 4.2 * 1024 ** 3;
    const r = rig({ freeBytes: () => free });
    expect(await r.svc.tick()).toBe(false);
    expect(r.svc.list()).toHaveLength(0);
    expect(r.svc.status().lastError).toMatch(/Skipped the daily backup.*4\.2 GB free.*5 GB/);
    expect(r.lines.filter((l) => /backup skipped: low disk/.test(l))).toHaveLength(1);
    expect(await r.svc.tick()).toBe(false);
    expect(r.lines.filter((l) => /backup skipped: low disk/.test(l))).toHaveLength(1); // warned once, not every half hour
    free = 40 * 1024 ** 3;
    expect(await r.svc.tick()).toBe(true);
    expect(r.svc.status().lastError).toBeNull();
    // A manual backup is the user's call: it still runs on a low disk.
    free = 1024 ** 3;
    r.tick(60_000);
    await expect(r.svc.backupNow("manual")).resolves.toMatchObject({ reason: "manual" });
  });

  it("the safety backup never prunes the archive being restored", async () => {
    const r = rig();
    const oldest = await r.svc.backupNow("manual");
    for (let i = 0; i < 2; i++) { r.tick(60_000); await r.svc.backupNow("auto"); }
    r.tick(60_000);
    await r.svc.restore(oldest.file);
    expect(fs.existsSync(oldest.file)).toBe(true);
  });

  it("runs the daily backup only when a day has passed", async () => {
    const r = rig();
    expect(await r.svc.tick()).toBe(true);
    r.tick(3600_000);
    expect(await r.svc.tick()).toBe(false);
    r.tick(24 * 3600_000);
    expect(await r.svc.tick()).toBe(true);
  });

  it("restores: safety backup first, stage, restart, verify, then sessions and Mac files", async () => {
    const r = rig();
    const { file } = await r.svc.backupNow("manual");
    fs.writeFileSync(path.join(r.userData, "app-settings.json"), "{\"theme\":\"light\"}");
    r.setBots([{ id: "b1", name: "Nova" }]);
    r.events.length = 0;
    const res = await r.svc.restore(file);
    expect(res).toMatchObject({ ok: true, bots: 2, verified: true });
    expect(r.events).toEqual(["snapshot", "stage", "restart", "sessions:SESSIONS", "reconnect"]);
    expect(await records(r.staged[0]!)).toEqual(["manifest.json:" + (await records(hostStream([{ id: "b1", name: "Nova" }, { id: "b2", name: "Orbit" }])))[0]!.split(":")[1], "data/settings.json:2"]);
    expect(fs.readFileSync(path.join(r.userData, "app-settings.json"), "utf8")).toBe("{\"theme\":\"dark\"}");
    expect(r.svc.list().some((a) => a.reason === "pre-restore")).toBe(true);
  });

  it("skips another Mac's sealed files, and refuses a foreign archive until its recovery code is given", async () => {
    const a = rig();
    const { file } = await a.svc.backupNow("manual");
    const code = a.svc.pendingRecoveryCode()!;
    const b = rig({ canUnseal: () => false });
    fs.writeFileSync(path.join(b.userData, "secrets.hashkey.bin"), "THIS-MAC");
    await expect(b.svc.preview(file)).rejects.toThrow(/recovery code/);
    await expect(b.svc.preview(file, "SYN-AAAA")).rejects.toThrow(/recovery code/);
    expect((await b.svc.preview(file, code)).bots).toHaveLength(2);
    const res = await b.svc.restore(file, code);
    expect(res).toMatchObject({ ok: true, macSecretsSkipped: true });
    expect(fs.readFileSync(path.join(b.userData, "secrets.hashkey.bin"), "utf8")).toBe("THIS-MAC");
    expect(fs.readFileSync(path.join(b.userData, "local-bot-modes.json"), "utf8")).toBe("{\"b1\":\"local\"}");
  });

  it("re-review 1: a restored push (VAPID) key this Mac can't unseal is dropped; the phones stay, push re-pairs", async () => {
    const a = rig();
    fs.writeFileSync(path.join(a.userData, "phone-access.json"), JSON.stringify({
      enabled: true, devices: [{ id: "p1", tokenHash: "t", name: "Phone", createdAt: 1, lastSeenAt: 1 }],
      vapid: { publicKey: "PUB", sealed: Buffer.from("OTHER-MAC").toString("base64") },
      subs: [{ deviceId: "p1", endpoint: "https://push.example/x", p256dh: "k", auth: "a", createdAt: 1 }], mapped: null,
    }));
    const { file } = await a.svc.backupNow("manual");
    const code = a.svc.pendingRecoveryCode()!;
    // This Mac opens its own hash key but not the other Mac's push key.
    const b = rig({ canUnseal: (buf) => buf.toString() !== "OTHER-MAC" });
    await b.svc.restore(file, code);
    const p = JSON.parse(fs.readFileSync(path.join(b.userData, "phone-access.json"), "utf8")) as { vapid: unknown; subs: unknown[]; devices: unknown[]; enabled: boolean };
    expect(p.vapid).toBeNull();
    expect(p.subs).toEqual([]);
    expect(p.devices).toHaveLength(1);
    expect(p.enabled).toBe(true);
  });

  it("a restored push key this Mac CAN unseal is kept", async () => {
    const r = rig();
    fs.writeFileSync(path.join(r.userData, "phone-access.json"), JSON.stringify({ enabled: true, devices: [], vapid: { publicKey: "PUB", sealed: Buffer.from("MINE").toString("base64") }, subs: [], mapped: null }));
    const { file } = await r.svc.backupNow("manual");
    fs.writeFileSync(path.join(r.userData, "phone-access.json"), "{}");
    await r.svc.restore(file);
    const p = JSON.parse(fs.readFileSync(path.join(r.userData, "phone-access.json"), "utf8")) as { vapid: { sealed: string } };
    expect(Buffer.from(p.vapid.sealed, "base64").toString()).toBe("MINE");
  });

  it("a restore the host rejects leaves the Mac untouched and says why", async () => {
    const r = rig();
    const { file } = await r.svc.backupNow("manual");
    fs.writeFileSync(path.join(r.userData, "app-settings.json"), "{\"theme\":\"light\"}");
    let boot = "boot-1";
    r.deps.host.restart = async () => { boot = "boot-9"; };
    r.deps.host.health = async () => ({ ok: true, bootId: boot, hostVersion: "0.1.0", lastRestore: boot === "boot-9" ? { at: r.deps.now(), ok: false, message: "The staged restore is damaged." } : null });
    await expect(r.svc.restore(file)).rejects.toThrow(/damaged/);
    expect(fs.readFileSync(path.join(r.userData, "app-settings.json"), "utf8")).toBe("{\"theme\":\"light\"}");
    expect(r.svc.status().lastError).toMatch(/damaged/);
  });

  it("refuses to make a key it could not keep (secrets not open)", async () => {
    const r = rig({ key: { get: () => null, set: () => {} } });
    await expect(r.svc.backupNow("manual")).rejects.toThrow(/open yet/i);
  });
});
