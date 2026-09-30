// A tiny stdio MCP server for the provider-MCP tests: one read-only tool that echoes, and one that reports its pid.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const s = new McpServer({ name: "echo", version: "1.0.0" });
s.registerTool("echo", { description: "Echo the text back.", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
s.registerTool("whoami", { description: "The server's pid.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: String(process.pid) }] }));
await s.connect(new StdioServerTransport());
