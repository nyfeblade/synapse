import { describe, expect, it } from "vitest";
import { GOOGLE_REDIRECT_URI, GOOGLE_SCOPES, GOOGLE_SETUP_GUIDE, GOOGLE_SETUP_STEPS, GOOGLE_TOOL_NAMES, STRGS, blocksGoogleConsent, googleConsoleUrl } from "../src/index";

describe("built-in Google connector contracts", () => {
  it("asks for exactly the minimal scopes", () => {
    expect([...GOOGLE_SCOPES]).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ]);
  });

  it("uses the existing OAuth loopback for the redirect", () => {
    expect(GOOGLE_REDIRECT_URI).toBe("http://127.0.0.1:47823/mcp/oauth/callback");
  });

  it("names the eleven tools of the google server", () => {
    expect([...GOOGLE_TOOL_NAMES]).toEqual([
      "gmail_search", "gmail_read", "gmail_draft", "gmail_send",
      "calendar_list", "calendar_create", "calendar_update", "calendar_delete",
      "drive_search", "drive_read", "drive_upload",
    ]);
  });

  it("has the six-step guided setup, with In production as its own step", () => {
    expect(GOOGLE_SETUP_GUIDE.map((s) => s.id)).toEqual(["project", "apis", "consent", "production", "client", "connect"]);
    expect(GOOGLE_SETUP_STEPS[3]).toBe("Publishing status: In production");
    // Every scope has its own Copy value, plus one for all of them.
    const consent = GOOGLE_SETUP_GUIDE[2]!.copies.map((c) => c.value);
    for (const s of GOOGLE_SCOPES) expect(consent).toContain(s);
    expect(consent).toContain(GOOGLE_SCOPES.join(","));
    expect(GOOGLE_SETUP_GUIDE[4]!.copies).toContainEqual({ label: "Application type", value: "Desktop app" });
    expect(STRGS.unverifiedNote).toContain("Continue");
  });

  it("console links pin the project only when a valid id is given (else Google's own picker)", () => {
    expect(googleConsoleUrl("/auth/audience")).toBe("https://console.cloud.google.com/auth/audience");
    expect(googleConsoleUrl("/auth/audience", "synapse-123")).toBe("https://console.cloud.google.com/auth/audience?project=synapse-123");
    expect(googleConsoleUrl("/flows/enableapi?apiid=a", "synapse-123")).toBe("https://console.cloud.google.com/flows/enableapi?apiid=a&project=synapse-123");
    expect(googleConsoleUrl("/auth/audience", "Bad Id&x=1")).toBe("https://console.cloud.google.com/auth/audience");
  });

  it("security fix 4: refuses every action in Google's OAuth and sign-in flow but the warning's link", () => {
    const click = (role: string, tag = role === "link" ? "a" : "button") => ({ action: "click", role, tag });
    expect(blocksGoogleConsent("https://accounts.google.com/signin/oauth/v2/consentsummary?x=1", click("button"))).toBe(true);
    expect(blocksGoogleConsent("https://accounts.google.com/signin/oauth/consent?x=1", click("link"))).toBe(true);
    expect(blocksGoogleConsent("https://accounts.google.com/o/oauth2/v2/auth?x=1", click("button"))).toBe(true);
    expect(blocksGoogleConsent("https://accounts.google.com/v3/signin/identifier?x=1", { action: "type" })).toBe(true);
    expect(blocksGoogleConsent("https://accounts.google.com/signin/oauth/warning?x=1", click("link"))).toBe(false);
    expect(blocksGoogleConsent("https://accounts.google.com/signin/oauth/v2/warning?x=1", click("link"))).toBe(false);
    expect(blocksGoogleConsent("https://accounts.google.com/signin/oauth/warning?x=1", click("button"))).toBe(true);
    expect(blocksGoogleConsent("https://accounts.google.com/signin/oauth/warning?x=1", { action: "press" })).toBe(true);
    expect(blocksGoogleConsent("https://accounts.google.com.evil.test/signin/oauth/consent", click("button"))).toBe(false);
    expect(blocksGoogleConsent("https://example.com/signin/oauth/consent", click("button"))).toBe(false);
    expect(blocksGoogleConsent("https://accounts.google.com/", click("button"))).toBe(false);
    // Re-review 3: a trailing dot on the host, and a /b/N account prefix.
    expect(blocksGoogleConsent("https://accounts.google.com./signin/oauth/v2/consentsummary?x=1", click("button"))).toBe(true);
    expect(blocksGoogleConsent("https://ACCOUNTS.GOOGLE.COM./o/oauth2/v2/auth?x=1", click("button"))).toBe(true);
    for (const p of ["/b/0/signin/oauth/consent", "/b/12/o/oauth2/auth", "/b/1/v3/signin/identifier"]) expect(blocksGoogleConsent(`https://accounts.google.com${p}?x=1`, click("button"))).toBe(true);
    expect(blocksGoogleConsent("https://accounts.google.com/b/1/signin/oauth/warning?x=1", click("link"))).toBe(false);
    expect(blocksGoogleConsent("https://accounts.google.com/b/x/signin/oauth/consent", click("button"))).toBe(false);
  });
});

describe("docs/google-setup.md", () => {
  it("carries the same six steps and scopes as the app sheet", async () => {
    const fs = await import("node:fs");
    const doc = fs.readFileSync(new URL("../../docs/google-setup.md", import.meta.url), "utf8");
    for (const step of GOOGLE_SETUP_STEPS) expect(doc).toContain(step);
    for (const scope of GOOGLE_SCOPES) expect(doc).toContain(scope);
    expect(doc).toContain(GOOGLE_REDIRECT_URI);
  });
});
