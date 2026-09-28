import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PendingWakes } from "../../background/pending-wakes";
import type { ShellSpawner } from "../../background/shell-spawner";
import { ShellService, terminalFileFor } from "../../background/shells";
import { SseHub } from "../../gateway/sse-hub";
import { botUserName } from "../../walls/bot-uid";
import { tmpConfig } from "../helpers";

const A = "3f2b8c1e-9d4a-4e6b-8f00-123456789abc";

/**
 * Bug #66 follow-up: a Bot's Shell transcript is private to that Bot. Once the box runs per-Bot accounts it lives in
 * the host's staging tree, /workspace/.host-out/terminals/<botId>/ (bothost:<the Bot's group> 2750, bot-user makes
 * it), written 0640 by the host and by systemd for the unit (StandardOutput=append:), so no other Bot can read it.
 */
describe("bug #66: Shell terminal files are private to the owning Bot", () => {
  function setup(perBotUid: boolean) {
    const cfg = { ...tmpConfig(), perBotUid };
    const calls: unknown[][] = [];
    let script = "";
    const spawner: ShellSpawner = {
      async start(id, cwd, account, botId) {
        calls.push([id, cwd, account, botId]);
        script = fs.readFileSync(path.join(cfg.hostPrivate, "run", `${id}.sh`), "utf8");
        const f = terminalFileFor(cfg, botId ?? A, id);
        fs.appendFileSync(f, `out\n\n---\nexit_code: 0\nelapsed_ms: 1\nended_at: 1\ncwd: ${cwd}\n---\n`);
      },
      async stop() {}, async status() { return "stopped" as const; },
    };
    const shells = new ShellService({
      cfg, spawner, pending: new PendingWakes(path.join(cfg.hostPrivate, "pw.json")), revivals: { complete: () => {} } as never,
      hub: new SseHub(), envInputs: () => ({}), enqueueHidden: () => {}, pollMs: 10,
    });
    return { cfg, shells, calls, script: () => script };
  }

  it("migrated: the file is under host-out/terminals/<botId>/, 0640; the unit gets the Bot's account and id; cwd goes to a random private file", async () => {
    const s = setup(true);
    const r = await s.shells.run(A, { command: "echo out" });
    expect(r.text).toMatch(/^out/);
    const [id, , account, botId] = s.calls[0] as string[];
    expect(account).toBe(botUserName(A));
    expect(botId).toBe(A);
    const f = path.join(s.cfg.workspace, ".host-out", "terminals", A, `${id}.txt`);
    expect(terminalFileFor(s.cfg, A, id!)).toBe(f);
    expect(fs.statSync(f).mode & 0o777).toBe(0o640);
    // Live finding: systemd's PrivateTmp is inert on OrbStack, so the cwd note goes to shell-runner's mktemp file.
    expect(s.script()).toContain('> "${BOT_SHELL_CWD_FILE:-/dev/null}"');
    expect(s.script()).not.toContain("/tmp/");
    expect(s.script()).not.toContain(".bot/terminals");
  });

  it("not migrated: the shared terminals dir, as before", async () => {
    const s = setup(false);
    fs.mkdirSync(path.join(s.cfg.workspace, ".bot", "terminals"), { recursive: true });
    await s.shells.run(A, { command: "echo out" });
    const [id, , account] = s.calls[0] as string[];
    expect(account).toBeUndefined();
    expect(terminalFileFor(s.cfg, A, id!)).toBe(path.join(s.cfg.workspace, ".bot", "terminals", `${id}.txt`));
  });
});
