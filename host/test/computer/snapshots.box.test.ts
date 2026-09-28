import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SnapshotService, SudoSnapshotControl } from "../../computer/snapshots";
import { execBuf } from "../../computer/x-exec";

describe.runIf(process.env.RUN_BOX === "1")("bot-snapshot round trip (box)", () => {
  it("snapshots and restores /workspace without vault.key", async () => {
    fs.writeFileSync("/workspace/.p3-snap-probe", "one");
    const svc = new SnapshotService({ dir: "/home/box/.host/snapshots", control: new SudoSnapshotControl(execBuf) });
    const info = await svc.create("manual", ["workspace"]);
    fs.writeFileSync("/workspace/.p3-snap-probe", "two");
    await svc.restore(info.id, ["workspace"]);
    expect(fs.readFileSync("/workspace/.p3-snap-probe", "utf8")).toBe("one");
    await svc.remove(info.id);
    fs.rmSync("/workspace/.p3-snap-probe");
  }, 300_000);
});
