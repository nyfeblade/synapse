import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Catalog, type CuratedEntry } from "../../marketplace/catalog";
import { CatalogIndex } from "../../marketplace/catalog-index";
import { createConnectorToolsModule } from "../../marketplace/connectors-module";
import { createMcpServices } from "../../mcp/module";
import { HostSettingsStore } from "../../store/host-settings";
import { createPluginTools } from "../../tools/plugin-tools";
import { makeRunnerHarness } from "../runner/harness";

// Hand-test bug A: the Bot had all thirteen plugin/connector tools and no prompt anywhere told it they
// existed or when to reach for them. The guidance rides on the module that registers the tools, exactly
// as sections/computer.md rides on Phase 3 (host/app.ts extraSystemAppend), so the two can never drift.
const curated: CuratedEntry[] = [
  { id: "curated:linear", name: "Linear", description: "Issues and projects", category: "Code", via: "remote", url: "https://mcp.linear.app/mcp" },
];

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plgprompt-"));
  const ctx = {
    cfg: { hostPrivate: dir, workspace: dir }, hub: { publish: () => {} },
    settings: new HostSettingsStore(path.join(dir, "s.json")), now: () => 1, flags: () => ({}),
    bots: { appendEntry: () => {} }, slot: () => null, enqueueHidden: () => {},
  } as never;
  const mcp = createMcpServices(ctx, { connect: async () => { throw new Error("401"); } });
  const catalog = new Catalog({ curated, mcp, plugins: () => null, templates: () => null, index: new CatalogIndex(path.join(dir, "i.db")) });
  catalog.refresh();
  const module = createConnectorToolsModule(ctx, { catalog, mcp });
  const build = () => createPluginTools({ botId: "b1", slot: () => null, catalog, mcp, bots: { appendEntry: () => {} } as never, now: () => 5 });
  /** Installs a connector, which is what mounts the eight manage-an-installed-connector tools. */
  const install = async () => { await build().find((t) => t.name === "InstallPlugin")!.handler({ plugin_id: "curated:linear" }); };
  return { module, tools: build(), build, install };
}

const HEADING = "## Plugins and connectors";

describe("plugin/connector prompt section (bug A)", () => {
  it("the connector-tools module contributes the section for every Bot", () => {
    const { module } = setup();
    const text = module.systemAppendExtra!("b1");
    expect(text).toContain(HEADING);
    expect(text).toMatch(/Marketplace/);
  });

  // The section and the tool list are both gated on whether anything is installed, so the
  // name/registration invariant has to hold in BOTH states — a tool documented but not mounted is a
  // tool the model will try to call and be told does not exist.
  it.each([["nothing installed", false], ["a connector installed", true]])("every tool it names is really registered, with the mcp__bot__ prefix the model sees (%s)", async (_label, installed) => {
    const { module, build, install } = setup();
    if (installed) await install();
    const tools = build();
    const text = module.systemAppendExtra!("b1");
    const named = [...text.matchAll(/mcp__bot__([A-Za-z]+)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    const registered = tools.map((t) => t.name);
    // No documented name may drift from the real tool list…
    expect([...new Set(named)].filter((n) => !registered.includes(n))).toEqual([]);
    // …and every registered plugin tool must be documented, so a new tool can't stay invisible.
    expect(registered.filter((n) => !named.includes(n))).toEqual([]);
    // Bare names ("call InstallPlugin") make the model call a tool that does not exist (see
    // host/test/computer/subagent-tool-name.test.ts for the live failure this rule came from).
    for (const name of registered) expect(text).not.toMatch(new RegExp(`(?<!mcp__bot__)\\b${name}\\b`));
  });

  it("is in the composed system prompt when the tools are wired, and absent when they are not", async () => {
    const { module } = setup();
    const off = await makeRunnerHarness({ script: () => [] });
    const offId = off.bots.create({ origin: "user", kickstart: false, name: "Plain" });
    expect(off.runner.systemAppend(offId)).not.toContain(HEADING);

    const on = await makeRunnerHarness({ script: () => [], systemAppendExtras: (b) => module.systemAppendExtra!(b) });
    const onId = on.bots.create({ origin: "user", kickstart: false, name: "Wired" });
    expect(on.runner.systemAppend(onId)).toContain(HEADING);
  });

  // The user connected Gmail and their Bot reported, in one breath, that the catalog said "connected" and that a
  // status check said "no connectors installed". Google is the one built-in connector and the one exception to
  // "account-wide", so a section stating only the account-wide rule teaches the Bot something false about the
  // very connector it is most likely to be asked about.
  it("documents the per-Bot Google exception, so the Bot doesn't read a connected account as its own state", async () => {
    const { module, install } = setup();
    const text = module.systemAppendExtra!("b1");
    expect(text, "must name Google as the exception to account-wide").toMatch(/Google is the exception/i);
    expect(text, "must say the switch is per Bot").toMatch(/per Bot/);
    expect(text, "must point at the status tool as the Bot's own source of truth").toMatch(/GetMcpServerStatus/);
    // With nothing installed the reconnect/re-auth tools do not exist, so the warning is stated in
    // plain words; naming a tool that is not mounted is the drift this file exists to prevent.
    expect(text, "must still say reconnecting cannot fix it").toMatch(/Reconnecting a connector, or asking for a fresh sign-in, changes none of this/);
    await install();
    expect(module.systemAppendExtra!("b1"), "and must name the tools once they exist").toMatch(/mcp__bot__RestartMcpServers/);
  });

  it("stays tight — this text is in every turn's context", async () => {
    const { module, install } = setup();
    // Raised from 2200 for the Google exception: it is load-bearing, because without it the Bot
    // confidently misreports its own connector state to the user. The half that documents the eight
    // manage-an-installed-connector tools is now only carried by Bots that have one, so the common
    // case is the smaller number and 3000 is the ceiling for the whole thing.
    expect(module.systemAppendExtra!("b1").length, "nothing installed").toBeLessThan(2400);
    await install();
    expect(module.systemAppendExtra!("b1").length, "with a connector").toBeLessThan(3200);
  });
});
