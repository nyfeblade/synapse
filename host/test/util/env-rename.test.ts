import { describe, expect, it } from "vitest";
import { envSetting } from "@synapse/shared";
import { loadConfig } from "../../config";
import { withFlagOverrides, DEFAULT_FLAGS } from "../../brain/conformance/flags";

// Bug 284: the app's env settings were BOTS_*. They are SYNAPSE_* now; a box's /etc/bothost.env, a systemd drop-in
// an older build wrote, or an owner's hand edit may still say BOTS_*, so the old name is still read and the new wins.
describe("SYNAPSE_* env settings, with BOTS_* still read for one release", () => {
  it("envSetting prefers SYNAPSE_, falls back to BOTS_, and is undefined when neither is set", () => {
    expect(envSetting({ SYNAPSE_X: "new", BOTS_X: "old" }, "X")).toBe("new");
    expect(envSetting({ BOTS_X: "old" }, "X")).toBe("old");
    expect(envSetting({ SYNAPSE_X: "" , BOTS_X: "old" }, "X")).toBe("");
    expect(envSetting({}, "X")).toBeUndefined();
  });

  it("per-Bot accounts turn on under the new name and still under the old one", () => {
    expect(loadConfig({ SYNAPSE_PER_BOT_UID: "1" }).perBotUid).toBe(true);
    expect(loadConfig({ BOTS_PER_BOT_UID: "1" }).perBotUid).toBe(true);
    expect(loadConfig({}).perBotUid).toBe(false);
  });

  it("every host setting reads the new name first", () => {
    const c = loadConfig({
      SYNAPSE_CC_MANAGED: "/tmp/new", BOTS_CC_MANAGED: "/tmp/old",
      SYNAPSE_SYSTEM_PROMPT: "standalone", BOTS_SYSTEM_PROMPT: "preset",
      SYNAPSE_SYSTEM_PROMPT_BOTS: "a,b",
      SYNAPSE_VOICE_FAST_PATH: "off",
      SYNAPSE_AUTH_PROXY_PORT: "1234", SYNAPSE_AUTH_PROXY_UPSTREAM: "http://127.0.0.1:9",
      SYNAPSE_AUTH_PROXY: "off", VITEST: "true",
    });
    expect(c.ccManagedDir).toBe("/tmp/new");
    expect(c.systemPromptMode).toBe("standalone");
    expect(c.standalonePromptBotIds).toEqual(["a", "b"]);
    expect(c.voiceFastPath).toBe(false);
    expect(c.authProxy).toMatchObject({ enabled: false, port: 1234, upstream: "http://127.0.0.1:9" });
    expect(loadConfig({ SYNAPSE_AUTH_PROXY: "off" }).authProxy.enabled).toBe(true); // production: refused, as before
  });

  it("the warm-session kill switches read the new name, and the old one", () => {
    expect(withFlagOverrides(DEFAULT_FLAGS, { SYNAPSE_WARM_SESSIONS: "0" })).toMatchObject({ warmSessions: false });
    expect(withFlagOverrides(DEFAULT_FLAGS, { SYNAPSE_PREWARM: "0" })).toMatchObject({ prewarm: false });
    expect(withFlagOverrides(DEFAULT_FLAGS, { BOTS_PREWARM: "0" })).toMatchObject({ prewarm: false });
  });

  it("the suite runs with SYNAPSE_ATOMIC_FSYNC=off (host/vitest.config.ts)", () => {
    expect(process.env.SYNAPSE_ATOMIC_FSYNC).toBe("off");
  });
});
