import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STR5 } from "@synapse/shared";
import { McpRegistry } from "../mcp/registry";
import { SendAcceptanceLedger } from "../runner/send-acceptance";
import { HostSettingsStore } from "../store/host-settings";
import { BotService } from "../bots/bot-service";
import { SseHub } from "../gateway/sse-hub";
import { initLayout } from "../store/layout";
import { LocalBridge } from "../local/bridge";
import { SkillLibrary } from "../skills/library";
import { tmpConfig } from "./helpers";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "copy-"));

function botService() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")), now: () => 1 });
  bots.loadAll();
  return { cfg, bots };
}

describe("error copy: internals stay out of the user's error channel", () => {
  it("a server added without a name says what to do, not which field is missing", () => {
    const dir = tmp();
    const reg = new McpRegistry({ dir: path.join(dir, "mcp"), settings: new HostSettingsStore(path.join(dir, "settings.json")), now: () => 5 });
    expect(() => reg.add({ name: "  ", url: "https://example.com/mcp" }, "custom")).toThrow("Give the server a name.");
  });

  it("a reused send nonce never mentions the nonce", () => {
    const l = new SendAcceptanceLedger(path.join(tmp(), "send-acceptance.json"));
    l.record("b", "n1", "hi", "t1u");
    expect(() => l.check("b", "n1", "other")).toThrow("This message was already sent. Start a new message instead.");
  });

  it("the local-server install warning names Bots' computer, not a “box”", () => {
    expect(STR5.localServerInstall).toBe("Adds a program that runs on Bots' computer. Review it before allowing.");
  });
});

describe("error copy: terminal periods on the terse gateway errors", () => {
  it("BotService rejects an unknown Bot, an unknown avatar and a non-group with full sentences", () => {
    const { bots } = botService();
    const a = bots.create({ name: "Planner", origin: "user", kickstart: false });
    expect(() => bots.require("no-such-id")).toThrow("No such Bot.");
    expect(() => bots.create({ origin: "user", kickstart: false, avatarShape: "trapezoid" as never })).toThrow("Unknown avatar shape.");
    expect(() => bots.create({ origin: "user", kickstart: false, avatarColor: "#nope" })).toThrow("Unknown avatar color.");
    expect(() => bots.setGroupMemberIds(a, [])).toThrow("Not a group.");
  });

  it("an unknown skill and an absent copy end with a period", () => {
    const { cfg } = botService();
    const lib = new SkillLibrary({ cfg, now: () => 1, writeSkillFile: () => {}, deleteSkillDir: () => {} });
    expect(() => lib.view("nope", [])).toThrow("No such skill.");
    const bridge = new LocalBridge({ hub: new SseHub(), now: () => 1, workspace: path.join(tmp(), "ws") });
    expect(() => bridge.upload("nope", 0, "", true)).toThrow("No copy in progress.");
  });
});
