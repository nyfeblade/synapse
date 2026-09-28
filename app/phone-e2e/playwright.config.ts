import { defineConfig, devices } from "@playwright/test";
import { SPEECH_WAV } from "./setup";

// Bug 198: Phone access end to end — the phone app in WebKit as an iPhone and in Chromium as an
// Android phone, against the real phone server, the real call helper and the real call loop, with
// `tailscale serve` played by a local HTTPS proxy that adds the tailnet identity header.
export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  globalSetup: "./setup.ts",
  timeout: 150_000,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "../../test-reports/tailscale-phone/playwright-results.json" }]],
  use: { ignoreHTTPSErrors: true, trace: "off" },
  projects: [
    // The fake microphone WAV is served by page.route, which a service worker would bypass (and push is
    // checked in Chromium): WebKit runs without one.
    { name: "iphone-webkit", use: { ...devices["iPhone 15"], browserName: "webkit", serviceWorkers: "block" } },
    {
      name: "android-chromium",
      use: {
        ...devices["Pixel 7"],
        browserName: "chromium",
        // Full Chromium in its new headless mode (the headless shell has no notifications at all).
        channel: "chromium",
        permissions: ["microphone", "notifications"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${SPEECH_WAV}`, "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--ignore-certificate-errors"] },
      },
    },
  ],
});
