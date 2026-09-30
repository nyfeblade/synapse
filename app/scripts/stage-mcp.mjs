import fs from "node:fs";
import path from "node:path";

/** The launcher an MCP client runs: the bundled helper, on Synapse's own runtime (no separate Node needed). */
export const LAUNCHER = `#!/bin/sh
# Synapse's MCP helper. MCP clients (Claude Desktop, Claude Code, Cursor) start this; it talks only to the
# running Synapse app, over its private socket. Settings → System → MCP has the config to paste.
here="$(cd "$(dirname "$0")" && pwd -P)"
export ELECTRON_RUN_AS_NODE=1
exec "$here/../../MacOS/Synapse" "$here/synapse-mcp.cjs" "$@"
`;

/**
 * 0.1.4: stages Contents/Resources/mcp — the launcher (0755) and the bundled helper (dist/mcp.cjs). Outside app.asar,
 * so the launcher is a real file a client can exec and the helper loads without the archive.
 */
export function stageMcp(appDir, stage) {
  const from = path.join(appDir, "dist", "mcp.cjs");
  if (!fs.existsSync(from)) throw new Error("package: dist/mcp.cjs is missing (npm run build builds it)");
  const dir = path.join(stage, "mcp");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(from, path.join(dir, "synapse-mcp.cjs"));
  fs.writeFileSync(path.join(dir, "synapse-mcp"), LAUNCHER, { mode: 0o755 });
  fs.chmodSync(path.join(dir, "synapse-mcp"), 0o755);
  return dir;
}

/** The packaged app has both, and the launcher is executable. */
export function mcpProblems(app) {
  const dir = path.join(app, "Contents", "Resources", "mcp");
  const out = [];
  for (const f of ["synapse-mcp", "synapse-mcp.cjs"]) if (!fs.existsSync(path.join(dir, f))) out.push(`Contents/Resources/mcp/${f} is missing`);
  try { if (!(fs.statSync(path.join(dir, "synapse-mcp")).mode & 0o111)) out.push("Contents/Resources/mcp/synapse-mcp isn't executable"); } catch { /* reported above */ }
  return out;
}
