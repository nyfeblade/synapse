import { defineConfig } from "@playwright/test";

// workers: 1 — each spec launches its own Electron app + local host; run in parallel they flake (Task 48: phase1 B1-B4 and
// phase4 failed under default workers, all 6 pass serially). Every FUZZ app also binds the fixed OAuth loopback port
// (47823, the registered redirect URI), so two apps authorizing at once answer each other's callbacks (Task 34).
// testIgnore — `testMatch: "*.e2e.ts"` is matched against the whole path, so it also picked up
// `packaged/packaged-smoke.e2e.ts`, whose `findPackagedApp()` throws AT IMPORT TIME when there is no
// `dist-release`. One import throw aborts collection for the whole run, so `npm run e2e` reported
// "Total: 0 tests in 0 files" and every dev run needed a hand-written path filter (bug 39). The
// packaged suite is deliberately not part of the dev run — it has its own config (packaged.config.ts,
// `npm run smoke:packaged`), whose testDir IS ./packaged and which this ignore cannot reach.
// globalSetup (bug 289): every launched app keeps its data in a temp folder, never the real ~/Library.
export default defineConfig({ testDir: ".", globalSetup: "./isolated-app-data.ts", testMatch: "*.e2e.ts", testIgnore: "packaged/**", timeout: 90_000, retries: 0, workers: 1, reporter: "list" });
