// The Info.plist keys scripts/package.mjs adds to Synapse.app (electron-packager `extendInfo`).

/** Info.plist CFBundleIdentifier — the same string the signature's identifier uses (sign-app.mjs). */
export const APP_BUNDLE_ID = "com.nyfeblade.synapse";

export function extendInfo(bundleName) {
  return {
    CFBundleDisplayName: bundleName,
    // Portable install: the helpers are built for macOS 14 (native/*/build.sh) and the bundled MLX runtime
    // needs it; Apple silicon only (verify-bundle.mjs checks the helpers' minos against this).
    LSMinimumSystemVersion: "14.0",
    LSArchitecturePriority: ["arm64"],
    // A Bot's Mac command or file tool reaching these folders raises the prompt with THESE words, not Electron's.
    NSDocumentsFolderUsageDescription: "Synapse opens files in Documents when you ask a Bot to work with them.",
    NSDesktopFolderUsageDescription: "Synapse opens files on the Desktop when you ask a Bot to work with them.",
    NSDownloadsFolderUsageDescription: "Synapse opens files in Downloads when you ask a Bot to work with them.",
    NSCameraUsageDescription: "Synapse uses the camera only when you share it with a Bot.",
    NSBluetoothAlwaysUsageDescription: "Synapse uses Bluetooth headsets and microphones for voice calls with your Bots.",
    // Bug 99: Synapse.app is the TCC responsible process for the bots-dictation helper it spawns,
    // so the prompts use THESE strings. Without the speech one macOS kills the helper on its
    // Speech request instead of asking. (native/dictation/Info.plist mirrors them for a helper
    // run on its own.)
    NSMicrophoneUsageDescription: "Synapse uses the microphone for dictation and voice conversations with your Bots.",
    NSSpeechRecognitionUsageDescription: "Synapse turns your speech into text on this Mac for dictation.",
    // mac-apps: the same rule for the bots-mac helper. Synapse.app is its TCC responsible process, so macOS
    // shows THESE strings when a Bot first reaches Messages, Mail, Calendar, Reminders, Notes or Contacts —
    // and without NSAppleEventsUsageDescription it refuses the Apple event instead of asking.
    // (native/macapp/Info.plist mirrors them for a helper run on its own.)
    NSAppleEventsUsageDescription: "Synapse controls the apps you allow so your Bots can send a message, change your calendar or work in an app for you.",
    NSContactsUsageDescription: "Synapse looks people up in Contacts so your Bots can reach the right person by name.",
    NSCalendarsUsageDescription: "Synapse reads and changes your calendar so your Bots can see, add and move events.",
    NSRemindersUsageDescription: "Synapse reads and changes your reminders so your Bots can add and complete them.",
    // Bug 286: synapse:// (shared/src/app-data.ts APP_SCHEMES), and bots://, the old name, as an alias for one release.
    CFBundleURLTypes: [{ CFBundleURLName: bundleName, CFBundleURLSchemes: ["synapse", "bots"] }],
    CFBundleDocumentTypes: [{
      CFBundleTypeName: "Synapse Bot",
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "Owner",
      CFBundleTypeExtensions: ["botpack"],
    }],
    UTExportedTypeDeclarations: [{
      UTTypeIdentifier: "com.nyfeblade.synapse.botpack",
      UTTypeDescription: "Synapse Bot",
      UTTypeConformsTo: ["public.data"],
      UTTypeTagSpecification: { "public.filename-extension": ["botpack"] },
    }],
  };
}
