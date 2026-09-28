import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubSecrets, SECRET_NAME } from "../../teach/redact";
import { startSidecar } from "../../teach/sidecar";
import type { CdpLike } from "../../teach/cdp";
import type { RawField } from "../../teach/redact";
import type { XInputLike } from "../../teach/xinput";

const src = (rel: string): string => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

// Finding 1: host/teach/redact.ts:7 and host/teach/cdp.ts:22 duplicated the identical SECRET_NAME
// regex verbatim. redact.ts must export the single source of truth and cdp.ts must import it instead
// of declaring its own copy that can silently drift.
describe("Task 43 fix round 1", () => {
  describe("finding 1: SECRET_NAME is a single exported source of truth", () => {
    it("redact.ts exports SECRET_NAME and it matches the field-name/label secret cases", () => {
      expect(SECRET_NAME.test("user_pin")).toBe(true);
      expect(SECRET_NAME.test("CVV")).toBe(true);
      expect(SECRET_NAME.test("api_token")).toBe(true);
      expect(SECRET_NAME.test("amount")).toBe(false);
    });

    it("cdp.ts does not declare its own duplicate SECRET_NAME regex and imports it from redact.ts", () => {
      const s = src("teach/cdp.ts");
      expect(s).not.toMatch(/const SECRET_NAME\s*=\s*\/pass\|pin/);
      expect(s).toMatch(/import\s*\{[^}]*SECRET_NAME[^}]*\}\s*from\s*["']\.\/redact["']/);
    });
  });

  // Finding 2: host/teach/sidecar.ts:60 (the snapshot file) and host/teach/redact.ts:40 (scrubSecrets,
  // rewriting events.jsonl/snapshot files in place) both wrote JSON documents with a plain, non-atomic
  // fs.writeFileSync, contrary to the plan's global "every JSON write is atomic" convention already
  // followed by host/teach/recorder.ts and host/teach/queue.ts via writeJsonAtomic. A crash mid-write
  // could leave a truncated/corrupted file. Both call sites must go through the tmp+fsync+rename helpers.
  describe("finding 2: atomic writes for the teach snapshot file and scrubSecrets", () => {
    afterEach(() => vi.restoreAllMocks());

    it("sidecar.ts imports writeJsonAtomic and does not write the snapshot file with a raw fs.writeFileSync", () => {
      const s = src("teach/sidecar.ts");
      expect(s).toMatch(/import\s*\{[^}]*writeJsonAtomic[^}]*\}\s*from\s*["']\.\.\/util\/atomic-json["']/);
      expect(s).not.toMatch(/fs\.writeFileSync\(path\.join\(d\.sessionDir, file\), JSON\.stringify\(snap\)\)/);
    });

    it("redact.ts imports an atomic write helper and does not write scrubbed files with a raw fs.writeFileSync", () => {
      const s = src("teach/redact.ts");
      expect(s).toMatch(/import\s*\{[^}]*writeTextAtomic[^}]*\}\s*from\s*["']\.\.\/util\/atomic-text["']/);
      const scrubIdx = s.indexOf("export function scrubSecrets");
      expect(scrubIdx).toBeGreaterThan(-1);
      expect(s.slice(scrubIdx)).not.toMatch(/fs\.writeFileSync\(file, text\)/);
    });

    it("startSidecar's snapshot write goes through a rename (tmp file -> final path), not a direct write", async () => {
      const renameSpy = vi.spyOn(fs, "renameSync");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teach-"));

      class FakeX implements XInputLike {
        private q: string[] = [];
        private wake: (() => void) | null = null;
        private closed = false;
        emit(...lines: string[]) { this.q.push(...lines); this.wake?.(); }
        press(detail: number) { this.emit("EVENT type 0 (RawButtonPress)", `    detail: ${detail}`); }
        lines = { [Symbol.asyncIterator]: () => ({ next: async (): Promise<IteratorResult<string>> => {
          while (!this.q.length && !this.closed) await new Promise<void>((r) => { this.wake = r; });
          return this.q.length ? { value: this.q.shift()!, done: false } : { value: undefined, done: true };
        } }) };
        keysym() { return null; }
        async pointer() { return { x: 10, y: 10 }; }
        async activeWindow() { return { title: "Expenses — Chromium", class: "chromium" }; }
        close() { this.closed = true; this.wake?.(); }
      }
      class FakeCdp implements CdpLike {
        onNavigate() {}
        onField() {}
        async targetAt() { return null; }
        async snapshot() { return { url: "https://x.example", nodes: [] }; }
        async close() {}
      }
      const x = new FakeX();
      const cdp = new FakeCdp();
      let t = 1000;
      const h = startSidecar({ sessionDir: dir, startedAtMs: 1000, xinput: x, cdp, now: () => (t += 100) });
      x.press(1);
      await new Promise((r) => setTimeout(r, 50));
      await h.stop();

      const snapshotFile = path.join(dir, "snapshots", "0001.json");
      expect(fs.existsSync(snapshotFile)).toBe(true);
      const renamedToSnapshot = renameSpy.mock.calls.some((c) => String(c[1]) === snapshotFile && /\.tmp$/.test(String(c[0])));
      expect(renamedToSnapshot).toBe(true);
    });

    it("scrubSecrets rewrites files via a rename (tmp file -> final path), not a direct write", () => {
      const renameSpy = vi.spyOn(fs, "renameSync");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teach-"));
      fs.mkdirSync(path.join(dir, "snapshots"));
      fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ t: 1, type: "field", value: "acct-9f8e7d" }) + "\n");
      fs.writeFileSync(path.join(dir, "snapshots", "0001.json"), JSON.stringify({ nodes: [{ name: "token acct-9f8e7d here" }] }));

      const n = scrubSecrets(dir, ["acct-9f8e7d", "abc"]);

      expect(n).toBe(2);
      const eventsFile = path.join(dir, "events.jsonl");
      const snapFile = path.join(dir, "snapshots", "0001.json");
      expect(fs.readFileSync(eventsFile, "utf8")).not.toContain("acct-9f8e7d");
      expect(fs.readFileSync(snapFile, "utf8")).toContain("[redacted]");
      const renamedTo = new Set(renameSpy.mock.calls.map((c) => String(c[1])));
      expect(renamedTo.has(eventsFile)).toBe(true);
      expect(renamedTo.has(snapFile)).toBe(true);
    });
  });
});
