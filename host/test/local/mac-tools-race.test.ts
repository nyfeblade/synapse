import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { STR5 } from "@synapse/shared";
import { LocalAsks } from "../../local/asks";
import { LocalBridge } from "../../local/bridge";
import { EgressCounter } from "../../local/egress";
import { createLocalModule } from "../../local/module";
import { spawnKeyOf } from "../../runner/prompt-collector";
import { loadPrompt } from "../../prompts";

/**
 * Bug-log 129 (2026-09-22): after a host restart the bridge forgot the Mac. The desktop app registers only when it
 * connects, and a heartbeat from a computer the host doesn't know was silently ignored, so every Bot spawned after the
 * 08:22 restart got NO Mac tools until Synapse was relaunched (journal: last spawn with mcp__bot__ExternalShell 08:12;
 * Disk Saver, created later, never had them). The host now remembers the last registered Mac across restarts, keeps
 * the tools in the list whenever one has ever registered (they answer "not connected" while it's away), and tells an
 * unknown computer to register again.
 */
const computer = { computerId: "mac", label: "Alex's MacBook", isCurrent: true, executionPolicy: "ask" as const, localRoot: "/Users/alex/W", home: "/Users/alex" };
let now = 1_000;
let dir: string;
let ws: string;
beforeEach(() => {
  now = 1_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-race-"));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "mac-race-ws-"));
});
const hub = { publish: () => {} } as never;
const mkBridge = (file?: string) => new LocalBridge({ hub, now: () => now, workspace: ws, idleMs: 50, ...(file ? { file } : {}) });
const ctx = {
  now: () => now, cfg: { workspace: "/workspace" },
  settings: { get: () => ({ autoReviewEnabled: true }) },
  bots: { has: () => true, summary: () => ({ settings: { permMode: "full-auto" } }) },
} as never;
const mkModule = (bridge: LocalBridge) => createLocalModule(ctx, { bridge, asks: new LocalAsks({ bots: {} as never, now: () => now }), egress: new EgressCounter() as never });
const names = (m: ReturnType<typeof mkModule>) => m.botTools!("b1", () => null, []).map((t) => t.name);

describe("the Mac survives a host restart (bug-log 129)", () => {
  it("a restarted host remembers the last registered Mac; its next heartbeat makes it available", () => {
    const file = path.join(dir, "local-computer.json");
    mkBridge(file).register(computer);
    const after = mkBridge(file); // the host process restarted
    expect(after.computer()).toMatchObject({ computerId: "mac", label: "Alex's MacBook" });
    expect(after.available()).toBe(false); // nothing heard from it yet
    // Available at once (an app without the re-register flag keeps working), but asked for a fresh policy copy.
    expect(after.heartbeat("mac")).toMatchObject({ register: true });
    expect(after.available()).toBe(true);
    after.register({ ...computer, executionPolicy: "never" });
    expect(after.heartbeat("mac").register).toBeFalsy();
    expect(mkBridge(file).computer()?.executionPolicy).toBe("never");
  });

  it("a heartbeat from a computer the host doesn't know asks it to register again", () => {
    const b = mkBridge(path.join(dir, "local-computer.json"));
    expect(b.heartbeat("mac")).toMatchObject({ pending: [], register: true });
    b.register(computer);
    expect(b.heartbeat("mac").register).toBeFalsy();
    expect(b.heartbeat("other-mac")).toMatchObject({ register: true });
  });

  it("a corrupt or foreign state file is ignored", () => {
    const file = path.join(dir, "local-computer.json");
    fs.writeFileSync(file, "{not json");
    expect(mkBridge(file).computer()).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ computer: { label: "x" } }));
    expect(mkBridge(file).computer()).toBeNull();
  });

  it("every Bot keeps the Mac tools across a restart; while the Mac is away they say so", async () => {
    const file = path.join(dir, "local-computer.json");
    mkBridge(file).register(computer);
    const m = mkModule(mkBridge(file)); // restarted: the app hasn't re-registered yet
    const tools = m.botTools!("b1", () => null, []);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["ExternalShell", "ExternalRead", "Mac", "CopyToBox", "CopyFromBox"]));
    const r = await tools.find((t) => t.name === "ExternalShell")!.handler({ command: "df -h /" });
    expect(r).toMatchObject({ isError: true, text: STR5.localNotConnected });
  });

  it("a first registration changes the tool set, so a warm session's spawn key changes and it respawns next turn", async () => {
    const m = mkModule(mkBridge(path.join(dir, "local-computer.json")));
    const key = () => spawnKeyOf({ systemAppend: "p", envKeys: [], mcpNames: ["bot"], toolNames: names(m), tokenHash: "t" });
    expect(names(m)).not.toContain("ExternalShell"); // no Mac has ever registered: no dead schemas (851 tokens a turn)
    const before = key();
    await m.handlers!.registerLocalComputer!({ computer } as never);
    expect(names(m)).toContain("ExternalShell");
    expect(key()).not.toBe(before);
  });
});

describe("Bot self-knowledge about the two computers (bug-log 129)", () => {
  it("the base prompt says which computer is which and that missing Mac tools mean not connected, not a permission", () => {
    const base = loadPrompt("base.md");
    expect(base).toMatch(/Mac tools/);
    expect(base).toMatch(/isn't connected/);
    expect(base).toMatch(/reopen/i);
    expect(base).toMatch(/never a per-Bot permission/i);
  });
});
