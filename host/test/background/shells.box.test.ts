import path from "node:path";
import { describe, expect, it } from "vitest";
import { PendingWakes } from "../../background/pending-wakes";
import { SudoShellSpawner } from "../../background/shell-spawner";
import { ShellService } from "../../background/shells";
import { execBuf } from "../../computer/x-exec";
import { SseHub } from "../../gateway/sse-hub";
import { loadConfig } from "../../config";

describe.runIf(process.env.RUN_BOX === "1")("Shell through bot-shell (box)", () => {
  it("runs as box with the Bot's env and survives in its own unit", async () => {
    const cfg = loadConfig(process.env);
    const shells = new ShellService({
      cfg, spawner: new SudoShellSpawner(execBuf), pending: new PendingWakes(path.join("/tmp", "p3-boxtest-pw.json")),
      revivals: { complete: () => {} } as never, hub: new SseHub(), envInputs: () => ({ secrets: { P3_SECRET: "box-secret-1" } }), enqueueHidden: () => {},
    });
    const r = await shells.run("boxtest", { command: "id -un; echo $P3_SECRET; systemctl --no-pager status $(cat /proc/self/cgroup | sed 's#.*/##') >/dev/null && echo unit-ok" });
    expect(r.text).toMatch(/^box\nbox-secret-1\nunit-ok\n/);
  }, 60_000);
});
