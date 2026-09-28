import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireHostLock } from "../../gateway/host-lock";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("host lock (ARCH-11)", () => {
  it("takes over a stale holder with SIGTERM", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lock-")), "host.lock");
    fs.writeFileSync(file, String(child.pid));
    const release = await acquireHostLock(file, { takeoverMs: 1000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(child.pid!)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
    release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("escalates to SIGKILL when the holder ignores SIGTERM", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lock-")), "host.lock");
    fs.writeFileSync(file, String(child.pid));
    await acquireHostLock(file, { takeoverMs: 300 });
    await new Promise((r) => setTimeout(r, 50));
    expect(alive(child.pid!)).toBe(false);
  });
});
