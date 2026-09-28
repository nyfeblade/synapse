import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { spawnKeyOf } from "../../runner/prompt-collector";
import { tmpConfig } from "../helpers";

/**
 * Per-turn token floor. Every tool a Bot is given re-sends its JSON schema on every single model call
 * of that session, so the tool surface is a fixed per-turn tax, not a per-use cost. Measured against
 * the CLI's own /context accounting (getContextUsage) on 2026-09-19: the 42 tools a Bot used to get
 * cost 9,868 tokens per turn out of a ~30.7k static floor — 32% of it.
 */
let app: HostApp | null = null;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = null; });
const boot = async () => (app = await createHostApp(tmpConfig({ FUZZ: "1" })));

/** The eight tools that only do something to a connector that is already installed. */
const MANAGE_INSTALLED = [
  "AuthenticateMcpServer", "RestartMcpServers", "SetMcpInstructions", "SetMcpToolEnabled",
  "RenameMcpAccount", "RemoveMcpAccount", "UninstallMcpServer", "UninstallPlugin",
];
/** The three read-only discovery tools plus the two add tools: always useful, nothing installed needed. */
const ALWAYS_CONNECTOR = ["SearchPlugins", "GetPlugin", "GetMcpServerStatus", "InstallPlugin", "AddMcpServer"];

describe("the spawn key covers the tool surface (§16.2)", () => {
  it("changes when the Bot's tool names change", () => {
    const k = spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], toolNames: ["SendMessage"], tokenHash: "t" });
    expect(spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], toolNames: ["SendMessage"], tokenHash: "t" })).toBe(k);
    expect(spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], toolNames: ["SendMessage", "Shell"], tokenHash: "t" })).not.toBe(k);
    // order must not matter: the set is what the CLI sees
    expect(spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], toolNames: ["Shell", "SendMessage"], tokenHash: "t" }))
      .toBe(spawnKeyOf({ systemAppend: "A", envKeys: ["BOT_ID"], mcpNames: ["bot"], toolNames: ["SendMessage", "Shell"], tokenHash: "t" }));
  });
});

describe("connector tools are gated on there being a connector to manage (PLG-01)", () => {
  it("leaves the eight manage-an-installed-connector tools out while nothing is installed", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Gated", isKickstartRequested: false });
    const names = a.services.runner.wiring(id).botTools().map((t) => t.name);
    for (const n of ALWAYS_CONNECTOR) expect(names, `${n} must always be there`).toContain(n);
    for (const n of MANAGE_INSTALLED) expect(names, `${n} has nothing to act on`).not.toContain(n);
  });

  it("adds them back the moment a server is installed, and the prompt section grows with them", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Gated", isKickstartRequested: false });
    const before = a.services.runner.systemAppend(id);
    expect(before).not.toContain("mcp__bot__RenameMcpAccount");

    // Through the Bot's own always-mounted tool, i.e. the way a Bot actually gets there.
    const add = a.services.runner.wiring(id).botTools().find((t) => t.name === "AddMcpServer")!;
    await add.handler({ name: "acme", url: "https://acme.test/mcp" });

    const names = a.services.runner.wiring(id).botTools().map((t) => t.name);
    for (const n of MANAGE_INSTALLED) expect(names, `${n} is usable now`).toContain(n);
    expect(a.services.runner.systemAppend(id)).toContain("mcp__bot__RenameMcpAccount");
  });
});

/** Group chat needs 2–6 Bots, so on a one-Bot app CreateChannel cannot succeed; UpdateChannel and
 *  LeaveChannel both start by refusing a Bot that is not already a member. 621 tokens a turn. */
describe("channel tools are gated on there being a channel to make or be in (CHN-01)", () => {
  it("offers none of them to the only Bot on the app", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Solo", isKickstartRequested: false });
    const names = a.services.runner.wiring(id).botTools().map((t) => t.name);
    expect(names).not.toContain("CreateChannel");
    expect(names).not.toContain("UpdateChannel");
    expect(names).not.toContain("LeaveChannel");
  });

  it("offers CreateChannel once a second Bot exists, and the other two once it is in a group", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "One", isKickstartRequested: false });
    const two = await a.handlers.createAgent!({ name: "Two", isKickstartRequested: false });
    const names = () => a.services.runner.wiring(id).botTools().map((t) => t.name);
    expect(names()).toContain("CreateChannel");
    expect(names()).not.toContain("LeaveChannel");

    const create = a.services.runner.wiring(id).botTools().find((t) => t.name === "CreateChannel")!;
    const r = await create.handler({ member_ids: [id, two.id], name: "Room" });
    expect(r.isError, r.text).toBeFalsy();
    expect(names()).toContain("UpdateChannel");
    expect(names()).toContain("LeaveChannel");
  });
});

/** The five tools that reach the user's own Mac do nothing until a Mac has registered over the
 *  bridge; each one answers "unavailable" otherwise. 851 tokens a turn. */
describe("local-computer tools are gated on a local computer (LOC-01)", () => {
  it("are absent until a Mac registers, and present afterwards", async () => {
    const a = await boot();
    const { id } = await a.handlers.createAgent!({ name: "Local", isKickstartRequested: false });
    const names = () => a.services.runner.wiring(id).botTools().map((t) => t.name);
    const LOCAL = ["ExternalShell", "AwaitExternalShell", "ExternalRead", "CopyToBox", "CopyFromBox", "Mac", "Browser", "MacApp"];
    for (const n of LOCAL) expect(names(), `${n} has no computer to reach`).not.toContain(n);

    await a.handlers.registerLocalComputer!({ computer: { computerId: "mac1", label: "Mac", isCurrent: true, executionPolicy: "ask", localRoot: "/Users/x" } } as never);
    for (const n of LOCAL) expect(names(), `${n} is usable now`).toContain(n);
  });
});
