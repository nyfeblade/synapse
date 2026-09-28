import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PACKS, installPack, packInstalled, packModelDir, packPython, packRoot } from "../../src/main/native/voice-packs";

/**
 * Portable install, the real thing (RUN_VOICE_PACKS=1; ~2.4 GB per pack, so never in the default run):
 * installs a voice pack from the internet into a throwaway folder — never the user's own Bots folder — and
 * makes it speak through the real sidecar. PACK=qwen|f5 (default qwen). KEEP=1 keeps the folder for a rerun
 * (a rerun resumes; a finished pack is not downloaded again).
 */
const live = process.env.RUN_VOICE_PACKS === "1";
const id = (process.env.PACK ?? "qwen") as "qwen" | "f5";
const app = path.resolve(__dirname, "../..");

function selfTest(cmd: string, args: string[]): Promise<{ code: number | null; samples: number; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    let samples = 0;
    let err = "";
    c.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    c.stdout.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        const hl = buf.readUInt16BE(4);
        const h = JSON.parse(buf.subarray(6, 6 + hl).toString("utf8"));
        if (h.type === "audio") samples += (n - 2 - hl) / 4;
        buf = buf.subarray(4 + n);
      }
    });
    c.on("close", (code) => resolve({ code, samples, err }));
  });
}

describe.skipIf(!live)(`the ${id} voice pack, for real`, () => {
  it("downloads, installs, loads and speaks — with no Python, Homebrew or HF cache of the user's involved", async () => {
    const userData = process.env.PACK_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "voice-pack-live-"));
    const root = packRoot(userData, id);
    const def = PACKS.find((p) => p.id === id)!;
    const t0 = Date.now();
    let last = 0;
    await installPack({
      def, root, requirements: path.join(app, "native", id, "requirements.lock"),
      freeBytes: () => { const s = fs.statfsSync(userData); return s.bavail * s.bsize; },
      log: (l) => console.log(l),
      onProgress: (p) => { if (Date.now() - last > 5000) { last = Date.now(); console.log(`${p.phase} ${(p.received / 1e6).toFixed(0)}/${(p.total / 1e6).toFixed(0)} MB`); } },
    });
    console.log(`${id} pack installed in ${Math.round((Date.now() - t0) / 1000)} s at ${root}`);
    expect(packInstalled(root)).toBe(true);
    const r = id === "qwen"
      ? await selfTest("/usr/bin/arch", ["-arm64", packPython(root), "-s", "-E", path.join(app, "native/qwen/qwen_server.py"), "--model-dir", packModelDir(root), "--self-test", "Hello from the natural voice."])
      : await selfTest("/usr/bin/true", []);
    console.log(r.err.split("\n").filter((l) => /synth|load|warm/.test(l)).join("\n"));
    expect(r.code).toBe(0);
    if (id === "qwen") expect(r.samples).toBeGreaterThan(12_000);
    if (process.env.KEEP !== "1" && !process.env.PACK_DIR) fs.rmSync(userData, { recursive: true, force: true });
  }, 60 * 60_000);
});
