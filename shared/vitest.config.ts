import { defineConfig } from "vitest/config";

export default defineConfig({ test: { name: "shared", include: ["test/**/*.test.ts"], setupFiles: ["test/setup-tmpdir.ts"], globalSetup: ["../scripts/vitest-disk-guard.ts"] } });
