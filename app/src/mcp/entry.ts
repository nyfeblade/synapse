import { main } from "./helper";

// The bundled helper's entry (dist/mcp.cjs → Contents/Resources/mcp/synapse-mcp.cjs).
void main().catch((e: unknown) => { process.stderr.write(`synapse-mcp: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
