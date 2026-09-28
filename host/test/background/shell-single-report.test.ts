import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PendingWakes } from "../../background/pending-wakes";
import type { Completion } from "../../background/revivals";
import { LocalShellSpawner } from "../../background/shell-spawner";
import { ShellService } from "../../background/shells";
import { createShellTools } from "../../background/shell-tools";
import { SseHub } from "../../gateway/sse-hub";
import type { HiddenSpec } from "../../runner/turn-runner";
import { tmpConfig } from "../helpers";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** pollMs is long so the 5 s phase-3 tick reliably lands inside run()'s poll gap — the real race. */
function setup(pollMs: number) {
  const cfg = tmpConfig();
  const terminalsDir = path.join(cfg.workspace, ".bot", "terminals");
  const runDir = path.join(cfg.hostPrivate, "run");
  fs.mkdirSync(terminalsDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  const done: Completion[] = [];
  const notes: HiddenSpec[] = [];
  const shells = new ShellService({
    cfg, spawner: new LocalShellSpawner({ terminalsDir, runDir }), pending: new PendingWakes(path.join(cfg.hostPrivate, "host-pending-wakes.json")),
    revivals: { complete: (c: Completion) => done.push(c) } as never,
    hub: new SseHub(), envInputs: () => ({ secrets: {} }), enqueueHidden: (_b, s) => notes.push(s), pollMs,
  });
  const [shell] = createShellTools({ botId: "b", shells });
  return { cfg, shells, shell: shell!, done, notes };
}

describe("a foreground Shell command is reported exactly once (concurrency)", () => {
  it("the 5 s tick landing inside run()'s poll gap does not also fire a shell-done revival", async () => {
    const s = setup(2000);
    const run = s.shell.handler({ command: "echo hi", block_until_ms: 30_000 });
    await wait(700); // the command is long finished; run() is still asleep between polls
    await s.shells.tick();
    expect(s.done).toEqual([]); // the tool result is the only report of this command
    const r = await run;
    expect(r.text).toContain("hi");
    expect(r.text).toContain("[exit code 0");
    expect(s.done).toEqual([]);
  }, 20_000);

  it("a background command still revives from the tick", async () => {
    const s = setup(20);
    const r = await s.shell.handler({ command: "sleep 0.4; echo later", block_until_ms: 50 });
    expect(r.text).toContain("Still running");
    await wait(700);
    await s.shells.tick();
    expect(s.done.map((c) => c.kind)).toEqual(["shell"]);
  }, 20_000);
});
