import path from "node:path";

/**
 * Final secfix round 3 (ruling 4): the host's Bot-visible output, bothost-owned 2750 dirs / 0640 files (box reads via group).
 * provision.sh pre-creates uploads/events/screens/teach; mcp-output is created on first use by
 * ensureHostOwnedDir (0750 under the bothost-owned, setgid .host-out), never inside box-writable /workspace/.bot.
 */
export const HOST_OUT = ".host-out";
export type HostOutKind = "uploads" | "events" | "screens" | "teach" | "mcp-output";
export function hostOutDir(workspace: string, kind: HostOutKind): string {
  return path.join(workspace, HOST_OUT, kind);
}

/** The Bot's own (box-writable) Teach work folder: trace.json and rehearsal.json go here, never into .host-out. */
export function teachWorkDir(workspace: string, sessionId: string): string {
  return path.join(workspace, "teach-sessions", sessionId);
}
