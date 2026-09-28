import type { FakeStep } from "./fake-brain";
import { messageText, type TurnInput } from "./types";

const say = (content: string): FakeStep => ({ tool: "mcp__bot__SendMessage", input: { type: "text", content } });

/** FUZZ/E2E behaviour for Phase 3; demoScript consults this first. */
export function phase3DemoSteps(input: TurnInput): FakeStep[] | null {
  const text = input.prompt.map(messageText).join("\n");
  if (input.source === "box-handback") return [{ tool: "mcp__bot__Screenshot", input: {} }, say("Thanks for handing the computer back. The fare is on hold.")];
  if (input.source === "shell-done") return [say(`The background command finished.\n${/Full output: (.*)/.exec(text)?.[1] ?? ""}`)];
  if (input.source === "subagent-done") return [say("The background task finished; here's what it found.")];
  if (input.source === "secret-provided") return [say("Got it, saved securely.")];
  const m = /\b(computer|bg|task|secret):\s*(.*)$/m.exec(text);
  if (!m) return null;
  const [, kind, rest] = m;
  if (kind === "computer") return [{ tool: "mcp__bot__request_box_help", input: { instruction: "Sign in to Northwind Air so I can see your saved trips and hold the refundable fare.", reason: "auth", domain: "northwind-air.example" } }];
  if (kind === "bg") return [{ tool: "mcp__bot__Shell", input: { command: rest, block_until_ms: 0 } }, say("Started that in the background; I'll tell you when it's done.")];
  if (kind === "task") return [{ tool: "mcp__bot__Task", input: { description: rest || "Look into it", prompt: rest || "Look into it", subagent_type: "generalPurpose" } }, say("I started a background task for that.")];
  return [{ tool: "mcp__bot__SendMessage", input: { type: "secret-request", secret: { label: "Stripe test key", description: "For the demo app", field: "STRIPE_KEY" } } }];
}
