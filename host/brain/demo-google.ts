import type { FakeStep } from "./fake-brain";
import { messageText, type TurnInput } from "./types";

/**
 * FUZZ/E2E commands for the built-in Google connector (demoScript consults this for user turns):
 *   gmail: <query>                     → mcp__google__gmail_search, then relays what the tool said
 *   read mail: <id>                    → mcp__google__gmail_read, relayed
 *   mail: <to> | <subject> | <body>    → mcp__google__gmail_send (always an approval card), relayed
 *   calendar: <from ISO>               → mcp__google__calendar_list, relayed
 *   drive: <query>                     → mcp__google__drive_search, relayed
 */
export function googleDemoSteps(input: TurnInput): FakeStep[] | null {
  const text = input.prompt.map(messageText).join("\n");
  const at = (re: RegExp) => re.exec(text)?.[1]?.split("\n")[0]!.trim();
  const call = (tool: string, args: Record<string, unknown>): FakeStep[] => [{ tool: `mcp__google__${tool}`, input: args }, { relayLastToolOutput: true }];
  const mail = /\bmail:\s*([^|\n]+)\|\s*([^|\n]+)\|\s*([^\n]+)/.exec(text);
  if (mail && !/\bgmail:/.test(text)) return call("gmail_send", { to: mail[1]!.trim(), subject: mail[2]!.trim(), body: mail[3]!.trim() });
  const read = at(/read mail:\s*(\S+)/i);
  if (read) return call("gmail_read", { id: read });
  const q = at(/\bgmail:\s*(.*)$/im);
  if (q !== undefined) return call("gmail_search", { query: q });
  const from = at(/\bcalendar:\s*(.*)$/im);
  if (from !== undefined) return call("calendar_list", from ? { from } : {});
  const drive = at(/\bdrive:\s*(.*)$/im);
  if (drive !== undefined) return call("drive_search", { query: drive });
  return null;
}
