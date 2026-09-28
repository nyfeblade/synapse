import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../../app";
import { PendingWakes } from "../../../background/pending-wakes";
import { SubagentService, childSystemAppend, type ChildSpec } from "../../../background/subagents";
import { FakeBrain } from "../../../brain/fake-brain";
import { DEFAULT_FLAGS } from "../../../brain/conformance/flags";
import type { BotToolDef, BrainWiring } from "../../../brain/types";
import { computerToolsFor } from "../../../computer/computer-mcp";
import { perceptionMode, registerLabeler } from "../../../computer/perception/mode";
import { SseHub } from "../../../gateway/sse-hub";
import { classifyTool } from "../../../review/classify";
import { Supervisor } from "../../../supervisor/supervisor";
import { tmpConfig } from "../../helpers";

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

const wiring = (): BrainWiring => ({
  preToolUse: async () => ({ decision: "allow" }), canUseTool: async () => ({ behavior: "allow" }), postToolUse: async () => ({}),
  stop: async () => ({ block: false }), botTools: () => [], turnCounters: () => ({ sentMessageCount: 0, reacted: false, awaitingUserSelection: false, endedOnSilentToolCalls: false }),
  flags: () => DEFAULT_FLAGS,
});

function subagents(mode: "screenshots" | "live") {
  const specs: ChildSpec[] = [];
  const svc = new SubagentService({
    supervisor: new Supervisor({ caps: { maxLive: 20, maxRunning: 20, warmIdleMs: 600_000, userPreemptAfterMs: 15_000 }, brainFactory: () => { throw new Error("no bots"); } }),
    makeBrain: (spec) => { specs.push(spec); return new FakeBrain(`child:${spec.id}`, wiring(), () => [{ text: "done" }]); },
    revivals: { complete: () => {} }, pending: new PendingWakes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pm-")), "pw.json")),
    hub: new SseHub(), bots: { summary: () => ({ profile: { model: "claude-opus-5" } }) as never, nextTurnNo: () => 1, userMessageEpoch: () => 1 },
    transcriptPath: (s) => `/x/${s}.jsonl`, perception: () => mode,
  });
  return { svc, specs };
}

describe("Computer perception: Live is shelved, every Bot runs Screenshots", () => {
  it("a stored \"live\" (the Bot's or the account's) resolves to Screenshots at read time", () => {
    expect(perceptionMode({}, undefined)).toBe("screenshots");
    expect(perceptionMode({}, "live")).toBe("screenshots");
    expect(perceptionMode({ computerPerception: "screenshots" }, "live")).toBe("screenshots");
    expect(perceptionMode({ computerPerception: "live" }, "screenshots")).toBe("screenshots");
    expect(perceptionMode({ computerPerception: "live" }, "live")).toBe("screenshots");
  });

  it("no command can choose Live; a Bot whose stored setting is \"live\" keeps the data but runs Screenshots", async () => {
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = app;
    expect((await a.handlers.getHostSettings!({})).computerPerception).toBe("screenshots");
    const { id } = await a.handlers.createAgent!({ name: "Eyes", isKickstartRequested: false });
    expect(a.services.phase3!.computerPerception(id)).toBe("screenshots");
    await expect(async () => a.handlers.setAgentComputerPerception!({ id, mode: "live" })).rejects.toThrow(/shelved/);
    await expect(async () => a.handlers.setHostSettings!({ computerPerception: "live" })).rejects.toThrow(/shelved/);
    expect((await a.handlers.setAgentComputerPerception!({ id, mode: "screenshots" })).agent.settings.computerPerception).toBe("screenshots");
    expect((await a.handlers.setAgentComputerPerception!({ id, mode: null })).agent.settings.computerPerception).toBeUndefined();
    await expect(async () => a.handlers.setHostSettings!({ computerPerception: "video" as never })).rejects.toThrow(/Screenshots/);
    // Stored data from before the shelving is left alone and read as Screenshots.
    a.services.bots.updateSettings(id, { computerPerception: "live" });
    expect(a.services.bots.summary(id).settings.computerPerception).toBe("live");
    expect(a.services.phase3!.computerPerception(id)).toBe("screenshots");
  });
});

describe("dormant Live code (shelved; kept, never enabled)", () => {
  it("a computerUse child in Live mode gets the live prompt; Screenshots mode and browserUse are unchanged", async () => {
    const live = subagents("live");
    await live.svc.launch("bot-a", { description: "Rename the file", prompt: "…", subagent_type: "computerUse" });
    expect(live.specs[0]).toMatchObject({ type: "computerUse", perception: "live" });
    expect(live.specs[0]!.systemAppend).toContain("Look");
    expect(live.specs[0]!.systemAppend).not.toContain("through the Computer tool");
    const shots = subagents("screenshots");
    await shots.svc.launch("bot-a", { description: "Rename the file", prompt: "…", subagent_type: "computerUse" });
    expect(shots.specs[0]!.perception).toBeUndefined();
    expect(shots.specs[0]!.systemAppend).toBe(childSystemAppend("computerUse"));
    await live.svc.launch("bot-b", { description: "Find fares", prompt: "…", subagent_type: "browserUse" });
    expect(live.specs[1]!.perception).toBeUndefined();
  });

  it("Live swaps the Computer tool for Look/Act/Screenshot on the computer server; the Computer tool itself stays for Screenshots mode", () => {
    const t = (name: string) => ({ name }) as BotToolDef;
    const o = { computer: t("Computer"), browser: [t("browser_navigate")], live: () => [t("Look"), t("Act"), t("Screenshot")] };
    expect(computerToolsFor("computerUse", o).map((x) => x.name)).toEqual(["Computer"]);
    expect(computerToolsFor("computerUse", o, "live").map((x) => x.name)).toEqual(["Look", "Act", "Screenshot"]);
    expect(computerToolsFor("browserUse", o, "live").map((x) => x.name)).toEqual(["browser_navigate"]);
    expect(computerToolsFor("generalPurpose", o, "live")).toEqual([]);
  });
});

describe("review of the live tools", () => {
  const C = (toolName: string, input: Record<string, unknown>) => classifyTool({ toolName, input, toolUseId: "t" }, { workspace: "/workspace", hostPrivate: "/home/box/.host", enforce: true, botId: "b" });
  it("Look and Screenshot are read-only; hover/scroll are side effects without a card; click/type/key/drag/select/upload are reviewed", () => {
    expect(C("mcp__computer__Look", { query: "red" })).toMatchObject({ surface: null, sideEffect: false });
    expect(C("mcp__computer__Screenshot", {})).toMatchObject({ surface: null, sideEffect: false });
    expect(C("mcp__computer__Act", { do: "hover", on: "e2" })).toMatchObject({ surface: null, sideEffect: true });
    expect(C("mcp__computer__Act", { do: "scroll", text: "down 3" })).toMatchObject({ surface: null, sideEffect: true });
    expect(C("mcp__computer__Act", { do: "click", on: "640,400" })).toMatchObject({ surface: "computer", summary: "Click at (640, 400) on Bots' computer", target: { action: "computer", arguments: { action_kind: "click", coordinates: [640, 400] } } });
    expect(C("mcp__computer__Act", { do: "type", on: "e4", text: "ada@example.com" }).summary).toBe("Type “ada@example.com” into e4 on Bots' computer");
    expect(C("mcp__computer__Act", { do: "key", text: "ctrl+s" }).summary).toBe("Press ctrl+s on Bots' computer");
    expect(C("mcp__computer__Act", { do: "upload", on: "e9", text: "/workspace/cv.pdf" }).summary).toBe("Attach /workspace/cv.pdf with e9 on Bots' computer");
    expect(C("mcp__computer__Act", { do: "drag", on: "e1", to: "e2" }).summary).toBe("Drag e1 to e2 on Bots' computer");
  });

  it("the card names the element the id stood for when the Bot's live service has seen it", () => {
    registerLabeler("b", (id) => (id === "e3" ? 'button "Delete account"' : null));
    try {
      expect(C("mcp__computer__Act", { do: "click", on: "e3" }).summary).toBe('Click e3 (button "Delete account") on Bots\' computer');
      expect(C("mcp__computer__Act", { do: "click", on: "e4" }).summary).toBe("Click e4 on Bots' computer");
    } finally {
      registerLabeler("b", null);
    }
  });
});
