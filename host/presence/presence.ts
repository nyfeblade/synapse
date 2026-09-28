import path from "node:path";
import { LIMITS, type Activity, type Presence } from "@synapse/shared";
import type { RuntimeView } from "../bots/bot-service";
import { SEND_TOOL } from "../brain/tool-policy";

export function toolPersona(name: string): Presence {
  if (name === SEND_TOOL) return "thinking";
  if (name === "mcp__bot__SendToAgent" || name === "mcp__bot__UpdateAgent" || name === "mcp__bot__CreateAgent") return "sending";
  if (name === "WebFetch" || name === "WebSearch" || name.startsWith("mcp__browser__")) return "searching";
  if (name === "Task" || name === "Agent" || name === "mcp__bot__Task" || name === "mcp__bot__AwaitShell") return "orbit";
  return "working";
}

export function activityDetail(name: string, input: Record<string, unknown>): string {
  let d = "";
  if (name === "Bash" || name === "mcp__bot__Shell") {
    const cmd = String(input.command ?? "");
    const target = /(?:>>?|\btee\s+(?:-a\s+)?|sed\s+-i\S*\s+(?:'[^']*'|"[^"]*"|\S+)\s+)\s*(\S+)\s*$/.exec(cmd);
    d = target ? path.basename(target[1] as string) : cmd;
  } else if (name === "Read" || name === "Edit" || name === "Write") d = path.basename(String(input.file_path ?? ""));
  else if (name === "WebSearch") d = String(input.query ?? "");
  else if (name === "WebFetch") { try { d = new URL(String(input.url)).hostname; } catch { d = String(input.url ?? ""); } }
  else if (name.startsWith("mcp__")) d = (name.split("__")[1] ?? "").replace(/^claude_ai_/, "");
  return d.slice(0, LIMITS.activityDetailMax);
}

interface State { running: boolean; thinking: boolean; tool: { name: string; detail: string } | null; lastNamed: { name: string; detail: string; endedAt: number } | null }

export class PresenceTracker {
  private s = new Map<string, State>();

  constructor(private onChange: (botId: string) => void, private now: () => number = Date.now) {}

  private get(botId: string): State {
    let st = this.s.get(botId);
    if (!st) {
      st = { running: false, thinking: false, tool: null, lastNamed: null };
      this.s.set(botId, st);
    }
    return st;
  }

  turnStarted(botId: string): void {
    Object.assign(this.get(botId), { running: true, thinking: false, tool: null, lastNamed: null });
    this.onChange(botId);
  }
  turnEnded(botId: string): void {
    Object.assign(this.get(botId), { running: false, thinking: false, tool: null, lastNamed: null });
    this.onChange(botId);
  }
  thinking(botId: string, active: boolean): void {
    this.get(botId).thinking = active;
    this.onChange(botId);
  }
  toolStart(botId: string, name: string, input: Record<string, unknown>): void {
    this.get(botId).tool = { name, detail: activityDetail(name, input) };
    this.onChange(botId);
  }
  toolEnd(botId: string, name: string): void {
    const st = this.get(botId);
    if (st.tool && st.tool.name === name) st.lastNamed = { ...st.tool, endedAt: this.now() };
    st.tool = null;
    this.onChange(botId);
  }

  view(botId: string): RuntimeView {
    const st = this.get(botId);
    if (!st.running) return { presence: "idle", activity: null, running: false };
    if (st.tool) return { presence: toolPersona(st.tool.name), activity: { tool: st.tool.name, detail: st.tool.detail }, running: true };
    const held = st.lastNamed && this.now() - st.lastNamed.endedAt < LIMITS.namedActivityHoldMs ? st.lastNamed : null;
    if (held) return { presence: toolPersona(held.name), activity: { tool: held.name, detail: held.detail }, running: true };
    if (st.thinking) return { presence: "thinking", activity: { thinking: true } as Activity, running: true };
    return { presence: "working", activity: null, running: true };
  }
}
