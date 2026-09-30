import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// The website's /bot and /bots pages in a real browser: built into a temp folder, served with vercel.json's
// headers (serve.mjs). Separate from the Electron e2e config (testMatch *.site.ts).
export default defineConfig({ testDir: ".", testMatch: "*.site.ts", timeout: 30_000, retries: 0, workers: 1, reporter: "list", outputDir: path.join(os.tmpdir(), "synapse-site-e2e-results"), use: { browserName: "chromium" } });
