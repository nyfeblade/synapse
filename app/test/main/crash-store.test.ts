import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redactText, hostLogLine } from "../../src/main/crash/redact";
import { CrashStore } from "../../src/main/crash/store";

describe("crash report redaction", () => {
  it("masks tokens, keys, bearer headers, key=value secrets and known secret values; keeps Bot ids", () => {
    const text = [
      "token sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123",
      "gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 slack xoxb-1234567890-abcdefghij",
      "authorization: Bearer abc.def.ghi-123456",
      '{"apiKey":"k-123456789","password":"hunter2"} url?session=s3cr3t&x=1',
      "my vault value is Tr0ub4dor-and-3",
      "bot 3f2a9c1e-0000-4000-8000-000000000001 started",
    ].join("\n");
    const out = redactText(text, ["Tr0ub4dor-and-3"]);
    for (const s of ["sk-ant-oat01-abc", "ghp_ABC", "xoxb-123", "abc.def.ghi", "k-123456789", "hunter2", "s3cr3t", "Tr0ub4dor-and-3"]) expect(out).not.toContain(s);
    expect(out).toContain("3f2a9c1e-0000-4000-8000-000000000001");
    expect(out).toContain("x=1");
  });

  it("keeps only time, level and message of a host log line (never its fields)", () => {
    expect(hostLogLine('{"ts":"2026-09-21T10:00:00Z","level":"error","msg":"turn failed","text":"the user said hello","botId":"b1"}')).toBe("2026-09-21T10:00:00Z error turn failed");
    expect(hostLogLine("not json at all")).toBeNull();
  });
});

function rig(logLines: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crash-"));
  const log = path.join(root, "main.log");
  fs.writeFileSync(log, logLines.join("\n") + "\n");
  let now = 1_000;
  const store = new CrashStore({ dir: path.join(root, "crashes"), appVersion: "0.3.0", hostVersion: () => "0.1.0", logFiles: () => [log], secrets: () => ["VAULTVALUE-123456"], now: () => now++ });
  return { root, store, log };
}

describe("CrashStore", () => {
  it("records a stack, versions and the last 200 redacted log lines", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i} Bearer tok-${i}-abcdefgh`);
    const { store } = rig(lines);
    const r = store.record({ kind: "main-crash", message: "boom VAULTVALUE-123456", stack: "Error: boom\n    at x (main.cjs:1:1)" });
    expect(r).toMatchObject({ kind: "main-crash", appVersion: "0.3.0", hostVersion: "0.1.0", seen: false });
    expect(r.message).not.toContain("VAULTVALUE");
    expect(r.log).toHaveLength(200);
    expect(r.log[0]).toContain("line 50");
    expect(r.log.join("\n")).not.toMatch(/tok-\d+-abcdefgh/);
    expect(store.list()[0]!.id).toBe(r.id);
  });

  it("tracks unseen problems, keeps the newest 50, and never stores a huge stack", () => {
    const { store } = rig();
    for (let i = 0; i < 55; i++) store.record({ kind: "renderer-error", message: `e${i}`, stack: "x\n".repeat(500) });
    expect(store.list()).toHaveLength(50);
    expect(store.list()[0]!.stack!.split("\n").length).toBeLessThanOrEqual(40);
    expect(store.unseen()).toBe(50);
    store.markSeen();
    expect(store.unseen()).toBe(0);
  });

  it("dedupes a crash loop: the same problem within a minute is counted, not re-recorded", () => {
    const { store } = rig();
    store.record({ kind: "helper-exit", message: "The dictation helper stopped unexpectedly (signal SIGSEGV)" });
    store.record({ kind: "helper-exit", message: "The dictation helper stopped unexpectedly (signal SIGSEGV)" });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.count).toBe(2);
  });

  it("builds a report folder with the problem and the redacted logs, and nothing else", async () => {
    const { store, root } = rig(["hello", "Bearer abcdefghijklmnop"]);
    const r = store.record({ kind: "host-crash", message: "host died", hostLog: ['{"ts":"t","level":"error","msg":"crash","text":"secret chat"}'] });
    const zipped: string[] = [];
    const zip = await store.exportReport(r.id, { outDir: path.join(root, "reports"), zip: async (dir, out) => { zipped.push(...fs.readdirSync(dir).sort()); fs.writeFileSync(out, "zip"); } });
    expect(path.basename(zip)).toMatch(/^Synapse-report-.*\.zip$/);
    expect(zipped).toEqual(["main.log", "report.json"]);
    const text = store.reportText(r.id);
    expect(text).toContain("host died");
    expect(text).toContain("t error crash");
    expect(text).not.toContain("secret chat");
    expect(text).not.toContain("abcdefghijklmnop");
  });
});
