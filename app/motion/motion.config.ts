import { defineConfig } from "@playwright/test";

// The motion check (`npm run motion:check`): the renderer in HEADLESS Chromium against the FUZZ local
// host, every animation frame sampled, glitches detected (motion/detectors.ts). Not Electron and never
// a visible window, so it is safe to run anywhere.
export default defineConfig({ testDir: ".", testMatch: "*.motion.ts", timeout: 240_000, retries: 0, workers: 1, reporter: "list", use: { headless: true, actionTimeout: 8000, trace: "off", screenshot: "off", video: "off" } });
