import { describe, expect, it, vi } from "vitest";
import { ensureMicAccess, privacySettingsUrl, PRIVACY_URLS } from "../../src/main/native/privacy";

function sp(status: string, grant = true) {
  return { getMediaAccessStatus: vi.fn((_: "microphone") => status), askForMediaAccess: vi.fn(async (_: "microphone") => grant) };
}

describe("ensureMicAccess (bug 99): check, ask only when undecided, never fail silently", () => {
  it("granted → granted, no prompt", async () => {
    const s = sp("granted");
    expect(await ensureMicAccess(s)).toBe("granted");
    expect(s.askForMediaAccess).not.toHaveBeenCalled();
  });
  it("not-determined → asks (the macOS prompt) and reports the answer", async () => {
    const yes = sp("not-determined", true);
    expect(await ensureMicAccess(yes)).toBe("granted");
    expect(yes.askForMediaAccess).toHaveBeenCalledWith("microphone");
    expect(await ensureMicAccess(sp("not-determined", false))).toBe("denied");
  });
  it("denied / restricted → reported as such, no prompt (macOS would not show one)", async () => {
    const d = sp("denied");
    expect(await ensureMicAccess(d)).toBe("denied");
    expect(d.askForMediaAccess).not.toHaveBeenCalled();
    expect(await ensureMicAccess(sp("restricted"))).toBe("restricted");
  });
  it("unknown status → lets the helper try (it reports its own failure)", async () => {
    expect(await ensureMicAccess(sp("unknown"))).toBe("granted");
  });
  it("a throwing askForMediaAccess is a denial, not a crash", async () => {
    const s = { getMediaAccessStatus: () => "not-determined", askForMediaAccess: async () => { throw new Error("no usage string"); } };
    expect(await ensureMicAccess(s)).toBe("denied");
  });
});

describe("privacySettingsUrl: only the fixed panes", () => {
  it("maps the panes to System Settings deep links", () => {
    expect(privacySettingsUrl("microphone")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    expect(privacySettingsUrl("speech")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition");
    expect(privacySettingsUrl("screen")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    expect(Object.keys(PRIVACY_URLS)).toEqual(["microphone", "speech", "screen"]);
  });
  it("rejects anything else", () => {
    expect(() => privacySettingsUrl("camera")).toThrow();
    expect(() => privacySettingsUrl("__proto__")).toThrow();
  });
});
