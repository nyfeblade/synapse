import { describe, expect, it } from "vitest";
import { execCommand } from "../../src/main/box-provider";
import { orbCall, ORB_LIMITS } from "../../src/main/orb-exec";
import { resolveOrb } from "../../src/main/orb-path";

/**
 * Bug 435, live: OrbStack 2.2.3 now and then leaves a finished command unreaped right after the host restarts, and
 * the Mac-side orb waits forever. On a THROWAWAY machine that already exists (never "box"):
 *
 *   RUN_ORB_HANG=1 ORB_HANG_MACHINE=t435-123 npx vitest run app/test/main/orb-hang.live.test.ts
 *
 * installs a stand-in host service, restarts it ROUNDS times, and after each restart makes BURST quick orb calls
 * through the app's helper. Every call must come back (a hang is killed and retried); it prints how many hung.
 */
const machine = process.env.ORB_HANG_MACHINE ?? "";
const live = process.env.RUN_ORB_HANG === "1" && /^t435-[a-z0-9-]+$/.test(machine);
const ROUNDS = Number(process.env.ORB_HANG_ROUNDS ?? 20);
const BURST = Number(process.env.ORB_HANG_BURST ?? 40);

describe.skipIf(!live)("orb calls right after a host restart, for real (bug 435)", () => {
  it("every call returns: a stuck one is killed and retried", async () => {
    const orb = resolveOrb();
    const call = (args: string[], timeoutMs: number = ORB_LIMITS.read) => orbCall(execCommand, orb, ["-m", machine, "-u", "root", ...args], { timeoutMs, idempotent: true });
    const unit = "[Service]\nExecStart=/bin/sh -c 'while :; do date > /run/hang-host; sleep 0.2; done'\n";
    expect((await call(["sh", "-c", `printf '%s' "${unit}" > /etc/systemd/system/hang-host.service && systemctl daemon-reload`], ORB_LIMITS.inBox)).code).toBe(0);
    let hung = 0; let calls = 0; let failed = 0; let slowest = 0;
    const t0 = Date.now();
    for (let r = 0; r < ROUNDS; r++) {
      await call(["systemctl", "restart", "hang-host"], ORB_LIMITS.inBox);
      await Promise.all(Array.from({ length: BURST }, async (_, i) => {
        const s = Date.now();
        const res = await orbCall(execCommand, orb, ["-m", machine, ...(i % 2 ? ["-u", "root"] : []), "cat", "/etc/hostname"], { timeoutMs: ORB_LIMITS.read, idempotent: true });
        calls++;
        slowest = Math.max(slowest, Date.now() - s);
        if (Date.now() - s > ORB_LIMITS.read) hung++;
        if (res.code !== 0) failed++;
      }));
    }
    process.stderr.write(`bug 435 live: ${calls} calls over ${ROUNDS} restarts in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${hung} hung and were killed + retried; ${failed} still failed; slowest ${slowest} ms\n`);
    expect(calls).toBe(ROUNDS * BURST);
  }, 30 * 60_000);
});
