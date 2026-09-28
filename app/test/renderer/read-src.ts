import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Vite statically rewrites `new URL(<template-literal>, import.meta.url)` for asset bundling and
// mishandles a dynamic `${...}` tail in that literal (resolves to ".../undefined"), so this builds
// the relative path with plain string concatenation instead of a template literal.
const srcPath = (relPath: string) => fileURLToPath(new URL("../../src/renderer/" + relPath, import.meta.url));
export const readSrc = (relPath: string) => readFileSync(srcPath(relPath), "utf8");
