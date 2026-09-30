import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeBrain } from "../../brain/claude-brain";
import { DEFAULT_FLAGS } from "../../brain/conformance/flags";
import { SEND_TOOL } from "../../brain/tool-policy";
import { tmpConfig } from "../helpers";
import { input, testWiring } from "./helpers";
import { realHomeForTest } from "../../../scripts/test-home";

// ORIG-16 §16.11 lifecycle, against the Mac's logged-in Claude Code (runAs same-uid, bundled CLI). Spends a little quota.
describe.skipIf(!process.env.RUN_CLAUDE)("ClaudeBrain against real Claude", () => {
  it("new session, warm second turn, cold resume remembers turn 1", async () => {
    const home = realHomeForTest("the Mac's logged-in Claude Code (opt-in RUN_CLAUDE run)");
    const cfg = { ...tmpConfig(), boxHome: home, claudeConfigDir: `${home}/.claude` };
    fs.mkdirSync(cfg.workspace, { recursive: true });
    let session: string | null = null;
    const sent: string[] = [];
    const wiring = testWiring({ flags: () => ({ ...DEFAULT_FLAGS, runAs: "same-uid" }) });
    wiring.botTools = () => [{ name: "SendMessage", description: "Send a message to the user.", schema: {}, readOnly: false, handler: async (a) => { sent.push(String(a.content)); return { text: "Message sent." }; } }];
    const brain = new ClaudeBrain({
      botId: "it", cfg, wiring, getSessionId: () => session, setSessionId: (id) => { session = id; },
      spawnConfig: () => ({ model: "claude-haiku-4-5-20251001", systemAppend: `Only ${SEND_TOOL} reaches the user.`, env: { HOME: home, PATH: process.env.PATH as string }, spawnKey: "k" }),
    });
    await brain.runTurn(input("Remember the word KUMQUAT. Reply only with OK."), () => {});
    expect(session).toMatch(/[0-9a-f-]{36}/);
    expect(brain.procState).toBe("warm_idle");
    await brain.runTurn(input("Reply only with TWO."), () => {});
    await brain.cool("test");
    const r = await brain.runTurn(input("What word did I ask you to remember? Reply with just the word."), () => {});
    expect(r.finalText.toUpperCase()).toContain("KUMQUAT");
    await brain.dispose();
  }, 180_000);
});
