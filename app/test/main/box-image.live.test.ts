import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execCommand } from "../../src/main/box-provider";
import { ORB_LIMITS, ORB_TIMEOUT_TEXT, orbCall } from "../../src/main/orb-exec";
import { resolveOrb } from "../../src/main/orb-path";
import { readImageManifest } from "../../src/main/setup/box-image";
import { boxSteps } from "../../src/main/setup/box-steps";
import { BoxProvisioner, type ProvisionState } from "../../src/main/setup/provisioner";
import { bundledImageVersion } from "../../src/main/box-lifecycle";

/**
 * 0.1.5 ready-made box, end to end on a THROWAWAY OrbStack machine (never the owner's box). Opt-in: it needs OrbStack,
 * an image built by box/build-image.sh (box/image.json + the file) and a few minutes.
 *   BOX_IMAGE_LIVE=1 BOX_IMAGE_FILE=.box-image/synapse-box-<v>-arm64.tar.zst npx vitest run --project app app/test/main/box-image.live.test.ts
 * The manifest is the build's (image.json next to the file), handed to the step as box/image.json would be.
 * BOX_IMAGE_MODE=scratch runs the same steps with the image turned off (SYNAPSE_BOX_IMAGE_URL=off), for the comparison.
 * The app's own setup steps import it from a local HTTP server (Range support, the pinned SHA-256 checked), then
 * verify-box.sh and the two-account sim's firewall checks run against it, and the machine is deleted.
 */
const LIVE = process.env.BOX_IMAGE_LIVE === "1";
const SCRATCH = process.env.BOX_IMAGE_MODE === "scratch";
const REPO = path.resolve(__dirname, "../../..");
const BOX = path.join(REPO, "box");
const UID = 577; // ports 48650-48652: never the owner's (uid 501, 47800-47802)
/** Also to BOX_IMAGE_REPORT when set (a passing test's console lines aren't shown). */
const say = (l: string) => { console.log(l); if (process.env.BOX_IMAGE_REPORT) fs.appendFileSync(process.env.BOX_IMAGE_REPORT, `${l}\n`); };

describe.runIf(LIVE)("ready-made box, live", () => {
  it("imports through the app's setup steps, passes verify-box and the firewall checks, and reports its time to ready", async () => {
    const file = path.resolve(REPO, process.env.BOX_IMAGE_FILE ?? "");
    const m = readImageManifest(path.dirname(file));
    expect(m, "box/image.json").not.toBeNull();
    expect(m!.imageVersion).toBe(bundledImageVersion(BOX));
    expect(fs.statSync(file).size).toBe(m!.bytes);
    const machine = `synapse-imgtest-${process.pid}`;
    const orb = resolveOrb();
    const server = http.createServer((req, res) => {
      const r = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      const start = r ? Number(r[1]) : 0;
      res.writeHead(r ? 206 : 200, { "content-length": String(m!.bytes - start) });
      fs.createReadStream(file, { start }).pipe(res);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/${path.basename(file)}`;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "box-image-live-"));
    let connected = false;
    const token = async () => {
      const r = await orbCall(execCommand, orb, ["-m", machine, "-u", "root", "cat", "/home/box/.host/gateway.json"], { timeoutMs: ORB_LIMITS.read, idempotent: true });
      return r.code === 0 ? (JSON.parse(r.stdout) as { port: number; token: string }) : null;
    };
    const log: string[] = [];
    try {
      const steps = boxSteps({
        exec: execCommand, orb: () => orb, machine, boxDir: BOX,
        imageVersion: () => bundledImageVersion(BOX), hostBuild: () => m!.hostBuild,
        reconnect: async () => {
          const g = await token();
          const h = g && await fetch(`http://127.0.0.1:${g.port}/health`, { headers: { authorization: `Bearer ${g.token}` } }).catch(() => null);
          connected = !!h?.ok;
        },
        connected: () => connected,
        uid: UID,
        forgetPin: () => log.push("forget-pin"),
        mac: { cpus: 2, totalMemBytes: 8 * 1024 ** 3 },
        image: { manifest: () => m, cacheDir, freeBytes: () => { const s = fs.statfsSync(cacheDir); return s.bavail * s.bsize; }, urlOverride: SCRATCH ? "off" : url },
      });
      const states: ProvisionState[] = [];
      const t0 = Date.now();
      const end = await new BoxProvisioner({ steps, publish: (s) => states.push(s) }).start();
      const ready = Date.now() - t0;
      if (end.phase !== "ready") console.log(end.log.slice(-40).join("\n"));
      expect(end.phase).toBe("ready");
      say(`box-image live (${SCRATCH ? "from scratch" : "image"}): ready in ${(ready / 1000).toFixed(1)} s; steps ${JSON.stringify(end.timings)}`);
      say(end.log.filter((l) => l.startsWith("image:")).join("\n"));
      if (!SCRATCH) {
        expect(end.log.some((l) => /setting up from scratch/.test(l))).toBe(false);
        expect(end.timings.create).toBeUndefined();
        expect(end.timings.provision).toBeUndefined();
      }
      expect(log).toContain("forget-pin");
      const bars = states.map((s) => s.progress);
      expect(bars.every((p, i) => i === 0 || p >= bars[i - 1]!)).toBe(true);
      // This install's own token and machine id, never the build's (the build's were checked absent from the image).
      const g = await token();
      expect(g?.token.length).toBeGreaterThan(20);

      const env = { ...process.env, ORB: orb, BOX_MACHINE: machine, SYNAPSE_UID: String(UID) };
      // Bug 435: the scripts bound every orb call themselves (box/orb.sh kills a stuck one and says so); a hang is
      // counted and reported, never retried around here.
      const runChecked = async (label: string, args: string[], extra: Record<string, string>) => {
        const t = Date.now();
        const r = await runScript(args, { ...env, ...extra });
        const fails = r.out.match(/^(FAIL|SKIP) .*/gm) ?? [];
        const hung = r.out.split("\n").filter((l) => l.includes(ORB_TIMEOUT_TEXT)).length;
        say(`box-image live: ${label} ${r.code === 0 && !fails.length ? "passed" : "FAILED"} in ${((Date.now() - t) / 1000).toFixed(1)} s (${(r.out.match(/^PASS /gm) ?? []).length} checks${hung ? `, ${hung} orb call(s) timed out` : ""})${fails.length ? `: ${fails.join("; ")}` : ""}`);
        return { ...r, fails };
      };
      const v = await runChecked("verify-box", [path.join(BOX, "verify-box.sh")], {});
      expect(v.fails).toEqual([]);
      expect(v.code).toBe(0);
      const sim = await runChecked("two-account sim", [path.join(BOX, "two-account-sim.sh"), BOX, String(UID)], { SIM_MACHINE: machine });
      expect(sim.fails).toEqual([]);
      expect(sim.code).toBe(0);
    } finally {
      server.close();
      await orbCall(execCommand, orb, ["delete", "-f", machine], { timeoutMs: ORB_LIMITS.delete, idempotent: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  }, 45 * 60_000);
});

/** Runs a box script (its own orb calls are bounded by box/orb.sh). */
function runScript(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn("bash", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    c.stderr.on("data", (b: Buffer) => { out += b.toString(); });
    c.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}
