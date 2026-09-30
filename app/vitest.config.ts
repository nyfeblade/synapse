import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({ plugins: [react()], test: { name: "app", include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["../scripts/vitest-test-home.ts", "test/setup-avatar-clock.ts", "test/setup-tmpdir.ts", "test/setup-exit-clones.ts"], globalSetup: ["../scripts/vitest-disk-guard.ts"], testTimeout: 20_000 } });
