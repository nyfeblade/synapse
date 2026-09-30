import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { LAUNCHER, mcpProblems, stageMcp } from "../../scripts/stage-mcp.mjs";

/**
 * 0.1.4: the packaged app ships Contents/Resources/mcp — an executable launcher and the bundled helper — outside
 * app.asar. The launcher runs the helper on the app's own binary (ELECTRON_RUN_AS_NODE): here a stand-in
 * Contents/MacOS/Synapse that is plain Node answers MCP's initialize through the real launcher.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "p-")); dirs.push(d); return d; };

describe("the packaged MCP helper", () => {
  it("stages an executable launcher and the helper; a bundle without them isn't shippable", async () => {
    const appDir = tmp();
    fs.mkdirSync(path.join(appDir, "dist"));
    await build({ entryPoints: [path.resolve(__dirname, "../../src/mcp/entry.ts")], outfile: path.join(appDir, "dist", "mcp.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "silent" });
    const stage = tmp();
    const dir = stageMcp(appDir, stage);
    expect(fs.readFileSync(path.join(dir, "synapse-mcp"), "utf8")).toBe(LAUNCHER);
    expect(fs.statSync(path.join(dir, "synapse-mcp")).mode & 0o777).toBe(0o755);

    const app = path.join(tmp(), "Synapse.app");
    expect(mcpProblems(app)).toEqual(["Contents/Resources/mcp/synapse-mcp is missing", "Contents/Resources/mcp/synapse-mcp.cjs is missing"]);
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    fs.cpSync(dir, path.join(app, "Contents", "Resources", "mcp"), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(app, "Contents", "MacOS", "Synapse"));
    expect(mcpProblems(app)).toEqual([]);

    // The launcher, exactly as shipped, answers initialize (no socket needed for that).
    const child = spawn(path.join(app, "Contents", "Resources", "mcp", "synapse-mcp"), ["--client", "cursor"], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "", SYNAPSE_MCP_SOCKET: path.join(app, "none.sock") } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    const line = await new Promise<string>((resolve) => { let b = ""; child.stdout.on("data", (d) => { b += String(d); if (b.includes("\n")) resolve(b); }); });
    child.kill();
    expect(JSON.parse(line)).toMatchObject({ id: 1, result: { serverInfo: { name: "synapse" }, capabilities: { tools: {} } } });
  }, 60_000);
});
