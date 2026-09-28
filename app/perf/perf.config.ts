import { defineConfig } from "@playwright/test";

// The idle-CPU guard (`npm run perf:idle -w @synapse/app`): the renderer in HEADLESS Chromium against the
// FUZZ local host, left idle with ten Bots and an open chat, its main-thread time measured over CDP.
// Never Electron, never a visible window.
export default defineConfig({ testDir: ".", testMatch: "*.perf.ts", timeout: 240_000, retries: 0, workers: 1, reporter: "list", use: { headless: true, trace: "off", screenshot: "off", video: "off" } });
