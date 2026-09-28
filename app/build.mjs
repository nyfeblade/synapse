import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: { main: "src/main/index.ts", preload: "src/preload/index.ts", coordinator: "src/coordinator/index.ts" },
  absWorkingDir: here, outdir: "dist", outExtension: { ".js": ".cjs" },
  bundle: true, platform: "node", format: "cjs", target: "node22",
  // Dev keeps maps. A package build must not emit them — a shipped *.map is the TypeScript source
  // (bug 28). `PACKAGE_BUILD=1` is set by the package script; verify-bundle.mjs is the backstop.
  sourcemap: process.env.PACKAGE_BUILD !== "1", external: ["electron"],
});
console.log("app: built main, preload, coordinator");
// Bug 198: the phone client that Phone access serves (dist/phone, next to main.cjs).
const { buildPhone } = await import("./scripts/build-phone.mjs");
await buildPhone(path.join(here, "dist", "phone"));
console.log("app: built phone client");

// Task 22 (CHAT-08): the native Swift dictation helper only builds on macOS (swiftc + Speech/AVFoundation).
if (process.platform === "darwin") execFileSync("bash", ["native/dictation/build.sh"], { cwd: here, stdio: "inherit" });
// The warm Mac-app helper (Accessibility + OSAKit) is macOS-only for the same reason.
if (process.platform === "darwin") execFileSync("bash", ["native/macapp/build.sh"], { cwd: here, stdio: "inherit" });
