import { describe, expect, it } from "vitest";
import { openDesktopApp } from "../../computer/desktop-apps";
import { SudoDisplayControl } from "../../computer/display-control";

describe("desktop apps on a Bot screen", () => {
  const ensure = async (id: string) => {
    expect(id).toBe("scout");
    return { botId: id, index: 4, display: ":4", cdpPort: 9226, running: true, generation: 1 };
  };

  it("ensures the display, then has the root helper start the app as the display's owner (bug 78)", async () => {
    const launched: [number, string][] = [];
    await openDesktopApp({ botId: "scout", app: "terminal", ensure, launch: async (index, app) => { launched.push([index, app]); } });
    expect(launched).toEqual([[4, "terminal"]]);
  });

  it("the launcher is bot-display open-app through sudo; a refusal is an error the caller shows", async () => {
    const calls: string[][] = [];
    const ok = new SudoDisplayControl(async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: Buffer.from(""), stderr: "" }; });
    await ok.openApp(4, "files");
    expect(calls).toEqual([["sudo", "-n", "/usr/local/libexec/bot-display", "open-app", "4", "files"]]);
    const bad = new SudoDisplayControl(async () => ({ code: 3, stdout: Buffer.from(""), stderr: "bot-display: display :4 is not running\n" }));
    await expect(bad.openApp(4, "files")).rejects.toThrow(/not running/);
  });
});
