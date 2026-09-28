import { describe, expect, it } from "vitest";
import { classifyTool } from "../../review/classify";
import { hostCallStatic } from "../../review/mac-floor";

// Bug 142: a Messages send on the user's Mac is always a card, and the card (read aloud on a call) names the
// recipient and the exact text, so "yes, send it" is an informed answer.

const call = (command: string) => ({ toolName: "mcp__bot__ExternalShell", input: { command }, toolUseId: "t" });
const o = { workspace: "/workspace", hostPrivate: "/home/box/.host" };
const SEND = `osascript <<'EOF'
tell application "Contacts" to set h to value of first phone of first person whose name is "Sam Lee"
tell application "Messages" to send "I'm running 10 minutes late" to participant h of (1st account whose service type = iMessage)
EOF`;

describe("a Messages send is consequential, and says who gets what", () => {
  it("the card summary names the recipient and the exact text", () => {
    expect(classifyTool(call(SEND), o).summary).toBe("Send a message to Sam Lee: “I'm running 10 minutes late”");
  });

  it("the Mac floor forces the card (never the reviewer's call alone)", () => {
    expect(hostCallStatic(call(SEND), "/workspace").forceCard).toBe(true);
  });

  it("other Mac commands keep their usual summary", () => {
    expect(classifyTool(call(`open -a Calendar`), o).summary).toBe("On your computer: open -a Calendar");
  });
});
