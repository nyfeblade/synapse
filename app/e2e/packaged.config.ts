import { defineConfig } from "@playwright/test";

// The packaged smoke suite launches the artefact under dist-release, so it is deliberately NOT part
// of `npm run e2e` (which runs the dev tree). It is serial and single-worker: one packaged app, one
// throwaway profile, one walk, with every wait bounded — a run that hangs is a failing run.
export default defineConfig({
  testDir: "./packaged",
  // Bug 289: the packaged app keeps its data in a temp folder, never the real ~/Library.
  globalSetup: "./isolated-app-data.ts",
  testMatch: "*.e2e.ts",
  timeout: 120_000,
  globalTimeout: 600_000,
  retries: 0,
  workers: 1,
  reporter: "list",
});
