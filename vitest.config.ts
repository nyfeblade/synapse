import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["shared", "host", "app"],
    // The temp-dir and disk guard (bug-log 128): refuses a full run under 10 GB free, fails a run that leaks temp dirs.
    globalSetup: ["scripts/vitest-disk-guard.ts"],
  },
});
