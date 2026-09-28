import { describe, expect, it } from "vitest";
import { shutdownOnQuit } from "../../src/main/box-quit";

describe("shutdownOnQuit", () => {
  it("always disposes the gateway and kills the coordinator", async () => {
    const log: string[] = [];
    await shutdownOnQuit({
      keepBoxOnQuit: true,
      dispose: () => { log.push("dispose"); },
      kill: () => { log.push("kill"); },
      stopBox: async () => { log.push("stop"); },
    });
    expect(log).toEqual(["dispose", "kill"]);
  });

  it("stops the computer only when the user turned keep-on-quit off", async () => {
    const log: string[] = [];
    await shutdownOnQuit({
      keepBoxOnQuit: false,
      dispose: () => { log.push("dispose"); },
      kill: () => { log.push("kill"); },
      stopBox: async () => { log.push("stop"); },
    });
    expect(log).toEqual(["dispose", "kill", "stop"]);
  });

  it("skips stop when there is no computer stopper (local/FUZZ host)", async () => {
    const log: string[] = [];
    await shutdownOnQuit({
      keepBoxOnQuit: false,
      dispose: () => { log.push("dispose"); },
      kill: () => { log.push("kill"); },
    });
    expect(log).toEqual(["dispose", "kill"]);
  });
});
