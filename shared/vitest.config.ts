import { defineConfig } from "vitest/config";

export default defineConfig({ test: { name: "shared", include: ["test/**/*.test.ts"], setupFiles: ["../scripts/vitest-test-home.ts", "test/setup-tmpdir.ts"], globalSetup: ["../scripts/vitest-disk-guard.ts"] } });
