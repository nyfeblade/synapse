import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "../../src/main/box-provider";
import { bundledImageVersion } from "../../src/main/box-lifecycle";
import { resolveOrb } from "../../src/main/orb-path";
import { boxSteps } from "../../src/main/setup/box-steps";
import { listMachines } from "../../src/main/setup/orb";
import { BoxProvisioner } from "../../src/main/setup/provisioner";
import { realHomeForOrb } from "./orb-live-home";

/**
 * Portable install, the fresh-Mac acceptance run for the Bots' computer (docs/portable-install.md):
 *
 *   RUN_FRESH_BOX=1 FRESH_BOX_MACHINE=synapse-accept-1 npx vitest run app/test/main/fresh-box.live.test.ts
 *
 * Creates a THROWAWAY OrbStack machine with the name given, provisions it with the repo's box scripts through
 * the same resumable steps the setup screen runs, prints how long each step took, and deletes the machine at
 * the end (KEEP=1 keeps it). It refuses a name that already exists, so it can never touch "box" or anyone's
 * machine. Deploying the host (FRESH_BOX_DEPLOY=1) is off by default: two machines serving the gateway on the
 * same localhost port would fight over OrbStack's forward, so deploy only on a Mac with no other box running.
 * Needs ~8 GB of free memory (the machine is capped at 4 GiB here) and ~1 GB of downloads.
 */
const machine = process.env.FRESH_BOX_MACHINE ?? "";
const live = process.env.RUN_FRESH_BOX === "1" && /^synapse-accept-[a-z0-9-]+$/.test(machine);

describe.skipIf(!live)("a fresh Bots' computer, for real", () => {
  realHomeForOrb();
  it("create → start → provision (→ deploy) resumably, and a second run does nothing", async () => {
    const orb = resolveOrb();
    expect((await listMachines(execCommand, orb)).some((m) => m.name === machine), `${machine} already exists; pick a new name`).toBe(false);
    const boxDir = path.resolve(__dirname, "../../../box");
    const deploy = process.env.FRESH_BOX_DEPLOY === "1";
    const steps = boxSteps({
      exec: execCommand, orb: () => orb, machine, boxDir,
      imageVersion: () => bundledImageVersion(boxDir),
      hostBuild: () => { try { return fs.readFileSync(path.resolve(boxDir, "../host/dist/build-id.txt"), "utf8").trim(); } catch { return null; } },
      // deploy.sh's own check-gateway.sh proves the host answers; the app-side connection isn't part of this run.
      reconnect: async () => {}, connected: () => true,
      forgetPin: () => {}, mac: { cpus: Math.min(2, os.cpus().length), totalMemBytes: 8 * 1024 ** 3 },
    }).filter((s) => deploy || (s.id !== "deploy" && s.id !== "connect"));
    const log = path.join(os.tmpdir(), `${machine}.log`);
    try {
      const first = await new BoxProvisioner({ steps, publish: () => {} }).start();
      fs.writeFileSync(log, first.log.join("\n"));
      console.log(`${machine}: ${first.phase} in ${Math.round(((first.finishedAt ?? 0) - (first.startedAt ?? 0)) / 1000)} s`, first.timings, first.error ?? "", `(log: ${log})`);
      expect(first.phase, first.error ?? "").toBe("ready");
      const again = await new BoxProvisioner({ steps, publish: () => {} }).start();
      expect(again.phase).toBe("ready");
      expect(Object.keys(again.timings)).toEqual([]); // nothing ran: every step already done
    } finally {
      if (process.env.KEEP !== "1") await execCommand(orb, ["delete", "-f", machine], { timeoutMs: 180_000 });
    }
  }, 90 * 60_000);
});
