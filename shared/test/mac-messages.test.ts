import { describe, expect, it } from "vitest";
import { messagesSend } from "../src/mac-messages";
import { evaluateFixedRules } from "../src/perm-rules";

// Bug 142 (voice fast path): a Bot sends an iMessage/SMS through Messages with AppleScript. That is ALWAYS
// consequential: a card every time (never lifted by a rule or Full-auto), showing the recipient and the exact text.

const send = (script: string) => `osascript -e '${script}'`;

describe("messagesSend: reads the recipient and the exact text", () => {
  it("the recipe's own form (Contacts lookup by name, then send)", () => {
    const cmd = send(`tell application "Contacts" to set h to value of first phone of first person whose name is "Sam Lee"
tell application "Messages" to send "I'm running 10 minutes late" to participant h of (1st account whose service type = iMessage)`);
    expect(messagesSend(cmd)).toEqual({ recipient: "Sam Lee", text: "I'm running 10 minutes late", service: "iMessage" });
  });

  it("a handle given directly, SMS, and escaped quotes", () => {
    expect(messagesSend(send(`tell application "Messages" to send "Say \\"hi\\" to Mom" to participant "+15551234567" of (1st account whose service type = SMS)`)))
      .toEqual({ recipient: "+15551234567", text: "Say \"hi\" to Mom", service: "SMS" });
    expect(messagesSend(send(`tell application "Messages" to send "ok" to buddy "sam@example.com"`)))
      .toEqual({ recipient: "sam@example.com", text: "ok", service: null });
  });

  it("JXA and multi -e forms", () => {
    expect(messagesSend(`osascript -l JavaScript -e 'Application("Messages").send("On my way", {to: Application("Messages").participants.whose({handle: "+15550001111"})[0]})'`)?.text).toBe("On my way");
    expect(messagesSend(`osascript -e 'tell application "Messages"' -e 'send "Yes" to participant "+1555"' -e 'end tell'`)).toEqual({ recipient: "+1555", text: "Yes", service: null });
  });

  it("anything else is not a Messages send (opening the app, reading chats, other apps)", () => {
    expect(messagesSend(`open -a Messages`)).toBeNull();
    expect(messagesSend(send(`tell application "Messages" to get name of every chat`))).toBeNull();
    expect(messagesSend(send(`tell application "Mail" to send outgoing message 1`))).toBeNull();
    expect(messagesSend(`echo 'tell application "Messages" to send "x" to buddy "y"'`)).toBeNull();
  });

  it("an unreadable text or recipient is still a send, and says so", () => {
    const r = messagesSend(send(`tell application "Messages" to send msg to participant h`));
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/couldn't read/);
    expect(r!.recipient).toMatch(/couldn't read/);
  });
});

describe("the fixed rules: a Messages send is always a card", () => {
  const ctx = { home: "/Users/me", projectDirs: ["/Users/me/code"] };
  it("always-ask with the recipient and the exact text (the layer Full-auto can't lift)", () => {
    const r = evaluateFixedRules({ side: "mac", kind: "command", command: send(`tell application "Messages" to send "Running late" to participant "+15551234567"`), cwd: "/Users/me/code" }, ctx);
    expect(r.verdict).toBe("always-ask");
    expect(r.rule).toBe("ask.messages-send");
    expect(r.reason).toContain("+15551234567");
    expect(r.reason).toContain("Running late");
  });

  it("the same send inside a script file run by path is still a card (the text is read from the command)", () => {
    const r = evaluateFixedRules({ side: "mac", kind: "command", command: `/usr/bin/osascript -e 'tell application "Messages" to send "hi" to buddy "x@y.z"'`, cwd: "/Users/me/code" }, ctx);
    expect(r.verdict).toBe("always-ask");
  });
});
