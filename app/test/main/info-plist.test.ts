import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_BUNDLE_ID, extendInfo } from "../../scripts/info-plist.mjs";

// Bug 99: the app is the TCC responsible process for its dictation helper, so ITS Info.plist must
// carry both usage strings — without NSSpeechRecognitionUsageDescription macOS kills the helper the
// moment it asks for Speech, with no prompt at all.
describe("Synapse.app Info.plist (bug 99)", () => {
  const info = extendInfo("Synapse");
  it("explains the microphone and speech recognition in Synapse's own words", () => {
    expect(info.NSMicrophoneUsageDescription).toBe("Synapse uses the microphone for dictation and voice conversations with your Bots.");
    expect(info.NSSpeechRecognitionUsageDescription).toBe("Synapse turns your speech into text on this Mac for dictation.");
  });
  // Portable install: the helpers and the bundled MLX runtime need macOS 14 on Apple silicon; say so in the plist
  // (Finder then refuses an older Mac up front) and explain the folder, camera and Bluetooth prompts in Synapse's words.
  it("promises exactly what the bundle can run on: macOS 14+, arm64", () => {
    expect(info.LSMinimumSystemVersion).toBe("14.0");
    expect(info.LSArchitecturePriority).toEqual(["arm64"]);
  });
  it("explains the Documents / Desktop / Downloads, camera and Bluetooth prompts in Synapse's own words", () => {
    const strings = info as unknown as Record<string, string>;
    for (const k of ["NSDocumentsFolderUsageDescription", "NSDesktopFolderUsageDescription", "NSDownloadsFolderUsageDescription", "NSCameraUsageDescription", "NSBluetoothAlwaysUsageDescription"]) {
      expect(strings[k], k).toMatch(/^Synapse .+\.$/);
    }
  });
  it("the bundle id matches the signing identifier (one identity for TCC)", () => {
    expect(APP_BUNDLE_ID).toBe("com.nyfeblade.synapse");
  });
  it("keeps the document type; the URL scheme is synapse://, with bots:// still registered for one release (bug 286)", () => {
    expect(info.CFBundleURLTypes).toEqual([{ CFBundleURLName: "Synapse", CFBundleURLSchemes: ["synapse", "bots"] }]);
    expect(info.CFBundleDocumentTypes[0].CFBundleTypeExtensions).toEqual(["botpack"]);
  });
  it("the helper's embedded plist says the same thing (used when it is run on its own)", () => {
    const helper = fs.readFileSync(path.resolve(__dirname, "../../native/dictation/Info.plist"), "utf8");
    expect(helper).toContain(info.NSMicrophoneUsageDescription);
    expect(helper).toContain(info.NSSpeechRecognitionUsageDescription);
  });

  // mac-apps: the same rule for bots-mac. Without NSAppleEventsUsageDescription macOS refuses the first
  // Apple event outright instead of asking, which is bug 99 again in a different pane.
  it("explains Apple events, Contacts, Calendars and Reminders in Synapse's own words", () => {
    const strings = info as unknown as Record<string, string>;
    for (const k of ["NSAppleEventsUsageDescription", "NSContactsUsageDescription", "NSCalendarsUsageDescription", "NSRemindersUsageDescription"]) {
      expect(strings[k], k).toMatch(/^Synapse .+\.$/);
      expect(strings[k], `${k} says what it is FOR`).toMatch(/so your Bots can/);
    }
  });

  it("the bots-mac helper's embedded plist says the same four things", () => {
    const helper = fs.readFileSync(path.resolve(__dirname, "../../native/macapp/Info.plist"), "utf8");
    for (const k of ["NSAppleEventsUsageDescription", "NSContactsUsageDescription", "NSCalendarsUsageDescription", "NSRemindersUsageDescription"] as const) {
      expect(helper, k).toContain(k);
    }
  });
});
