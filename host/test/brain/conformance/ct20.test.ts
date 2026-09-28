import fs from "node:fs";
import path from "node:path";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { ConformanceContext } from "../../../brain/conformance/types";
import { BOT_FLAG_SETTINGS, BOT_MANAGED_SETTINGS } from "../../../brain/spawn-options";
import { tmpConfig } from "../../helpers";

// Final secfix round 4 (ruling 1): CT-20 no longer has a "user" settingSource fallback. It checks that a managed
// skills plugin (the --plugin-dir tree the host owns) loads with settingSources [], and reports a plain FAIL otherwise.
vi.mock("../../../skills/skill-box-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../skills/skill-box-ops")>();
  return { ...actual, writeSkillFile: vi.fn(), deleteSkillDir: vi.fn() };
});
const { writeSkillFile, deleteSkillDir } = await import("../../../skills/skill-box-ops");
const { ct20, judgeCt20, installCt20Plugin, removeCt20Plugin, CT20_PLUGIN, CT20_SKILL } = await import("../../../brain/conformance/checks/ct20-skills");

function fakeQuery(msgs: SDKMessage[]): Query {
  let i = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    next: async () => (i < msgs.length ? { value: msgs[i++], done: false } : { value: undefined, done: true }),
    return: async () => ({ value: undefined, done: true }), interrupt: async () => undefined, close: () => undefined,
  } as unknown as Query;
}

describe("CT-20 managed plugin skills load with settingSources []", () => {
  it("passes when the plugin skill loads; otherwise a FAIL with no fallback flags", () => {
    expect(judgeCt20({ loaded: true })).toMatchObject({ status: "pass" });
    const f = judgeCt20({ loaded: false });
    expect(f.status).toBe("fail");
    expect(f.flags).toBeUndefined();
    expect(ct20.onThrow).toEqual({});
  });

  it("installs the probe as a skills-only plugin in the host-owned managed tree (2750 dirs, 0640 files), never through the ~/.claude box helpers", () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    const dir = installCt20Plugin(cfg);
    expect(dir).toBe(path.join(cfg.ccManagedDir!, "skills", CT20_PLUGIN));
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".claude-plugin", "plugin.json"), "utf8")).name).toBe(CT20_PLUGIN);
    const md = path.join(dir, "skills", CT20_SKILL, "SKILL.md");
    expect(fs.readFileSync(md, "utf8")).toContain("MARMALADE-20");
    for (const d of [dir, path.join(dir, ".claude-plugin"), path.join(dir, "skills"), path.dirname(md)]) expect(fs.statSync(d).mode & 0o7777, d).toBe(0o2750);
    expect(fs.statSync(md).mode & 0o777).toBe(0o640);
    expect(writeSkillFile).not.toHaveBeenCalled();
    removeCt20Plugin(cfg);
    expect(fs.existsSync(dir)).toBe(false);
    expect(deleteSkillDir).not.toHaveBeenCalled();
  });

  it("probes once with settingSources [], the Bot lockdown settings and the plugin; never the user source", async () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    const seen: Partial<Options>[] = [];
    const ctx: ConformanceContext = {
      cfg, runAs: "setpriv", now: Date.now, boxUid: async () => null, log: () => {},
      baseOptions: (extra: Partial<Options> = {}) => ({ settingSources: [], ...extra }) as Options,
      queryFn: ((a: { options: Partial<Options> }) => {
        seen.push(a.options);
        return fakeQuery([{ type: "result", subtype: "success", result: "MARMALADE-20" } as unknown as SDKMessage]);
      }) as never,
    };
    const out = await ct20.run(ctx);
    expect(out.status).toBe("pass");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.settingSources).toEqual([]);
    expect(seen[0]!.settings).toEqual({ ...BOT_FLAG_SETTINGS });
    expect(seen[0]!.managedSettings).toEqual({ ...BOT_MANAGED_SETTINGS });
    expect(seen[0]!.plugins).toEqual([{ type: "local", path: path.join(cfg.ccManagedDir!, "skills", CT20_PLUGIN), skipMcpDiscovery: true }]);
    expect(fs.existsSync(path.join(cfg.ccManagedDir!, "skills", CT20_PLUGIN))).toBe(false);
  });

  it("a probe that doesn't find the word is a FAIL and still cleans up", async () => {
    const cfg = tmpConfig({ BRAIN: "claude" });
    const ctx = {
      cfg, runAs: "setpriv", now: Date.now, boxUid: async () => null, log: () => {},
      baseOptions: (extra: Partial<Options> = {}) => extra as Options,
      queryFn: (() => fakeQuery([{ type: "result", subtype: "success", result: "no idea" } as unknown as SDKMessage])) as never,
    } as ConformanceContext;
    const out = await ct20.run(ctx);
    expect(out).toMatchObject({ status: "fail" });
    expect(out.flags).toBeUndefined();
    expect(fs.existsSync(path.join(cfg.ccManagedDir!, "skills", CT20_PLUGIN))).toBe(false);
  });
});
