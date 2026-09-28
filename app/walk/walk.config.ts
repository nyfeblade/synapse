import { defineConfig } from "@playwright/test";

// Capability walks: the REAL box, real Claude, real screens. Deliberately NOT part of `npm test`
// (vitest includes test/**) or `npm run e2e` (testMatch *.e2e.ts): files here are *.walk.ts.
// Run one by name: `WALK_REAL=1 npx playwright test -c app/walk/walk.config.ts -g J1`.
// No retries (a flaky pass is not a pass), no traces or screenshots from Playwright itself (J2 types
// a real API key; nothing may capture the window unasked), one worker (one app, one box).
export default defineConfig({
  testDir: ".",
  testMatch: "*.walk.ts",
  timeout: 420_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { trace: "off", screenshot: "off", video: "off" },
});
