import { describe, expect, it } from "vitest";
import { GOOGLE_REDIRECT_URI, GOOGLE_SCOPES, GOOGLE_SETUP_STEPS, GOOGLE_TOOL_NAMES, STRG } from "../src/index";

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

  it("has the six-step setup guide with the unverified-app and 7-day notes", () => {
    expect(GOOGLE_SETUP_STEPS).toHaveLength(6);
    expect(GOOGLE_SETUP_STEPS[0]).toContain("console.cloud.google.com");
    expect(GOOGLE_SETUP_STEPS[1]).toContain("Gmail API, Google Calendar API, Google Drive API");
    expect(GOOGLE_SETUP_STEPS[3]).toContain("Desktop app");
    expect(GOOGLE_SETUP_STEPS[4]).toContain("Continue");
    expect(STRG.testingNote).toContain("7 days");
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
