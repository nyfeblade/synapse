import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const hostDir = path.resolve(__dirname, "..");

describe("bundled host (smoke)", () => {
  beforeAll(() => { execFileSync(process.execPath, ["build.mjs"], { cwd: hostDir, stdio: "inherit" }); }, 60_000);

  it("serves /health from dist/host.mjs and exits cleanly on SIGTERM", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bots-smoke-"));
    const env = {
      ...process.env, DATA_ROOT: path.join(d, "agent-data"), HOST_PRIVATE: path.join(d, ".host"),
      WORKSPACE: path.join(d, "ws"), CLAUDE_CONFIG_DIR: path.join(d, ".claude"), HOST_PORT: "0", WEBHOOK_PORT: "0", BRAIN: "fake", REVIEWER: "stub", // the box's 47801 is forwarded to the Mac by OrbStack
    };
    const child = spawn(process.execPath, [path.join(hostDir, "dist", "host.mjs"), "serve"], { env, stdio: "ignore" });
    const infoFile = path.join(d, ".host", "gateway.json");
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(infoFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { headers: { authorization: `Bearer ${info.token}` } });
    expect(res.status).toBe(200);
    // The app asks /hello before it sends the token, when gateway.json says this host answers it.
    expect(info.hello).toBe(1);
    expect((await fetch(`http://127.0.0.1:${info.port}/hello?nonce=${"ab".repeat(16)}`)).status).toBe(200);
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 30_000);
});
