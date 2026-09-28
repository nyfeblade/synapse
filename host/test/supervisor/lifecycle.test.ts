import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bootSweep, SupervisorLedger } from "../../supervisor/ledger";
import { treeRss } from "../../supervisor/rss";

describe("supervisor ledger (ORIG-16 §16.8)", () => {
  it("writes supervisor.json with the boot id and processes", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "led-")), "supervisor.json");
    const l = new SupervisorLedger(file, "boot-1");
    l.write([{ pid: 42, botId: "b", kind: "bot", sessionId: "s", startedAt: 1 }]);
    expect(l.read()).toEqual({ hostBootId: "boot-1", procs: [{ pid: 42, botId: "b", kind: "bot", sessionId: "s", startedAt: 1 }] });
  });

  it("reaps orphans at boot only for the real brain", async () => {
    let reaped = 0;
    await bootSweep({ brain: "fake", reap: async () => { reaped++; } });
    expect(reaped).toBe(0);
    await bootSweep({ brain: "claude", reap: async () => { reaped++; } });
    expect(reaped).toBe(1);
  });
});

describe("treeRss", () => {
  it("sums VmRSS over a process and its descendants", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proc-"));
    const mk = (pid: number, ppid: number, kb: number) => {
      fs.mkdirSync(path.join(root, String(pid)));
      fs.writeFileSync(path.join(root, String(pid), "stat"), `${pid} (x) S ${ppid} 0 0`);
      fs.writeFileSync(path.join(root, String(pid), "status"), `Name:\tx\nVmRSS:\t   ${kb} kB\n`);
    };
    mk(10, 1, 1000); mk(11, 10, 2000); mk(12, 11, 500); mk(20, 1, 9999);
    expect(treeRss(10, root)).toBe(3500 * 1024);
  });
});
