import path from "node:path";
import { googleDemoSteps } from "./demo-google";
import { phase3DemoSteps } from "./demo-phase3";
import type { FakeScript, FakeStep } from "./fake-brain";
import { messageText } from "./types";

const send = (content: string): FakeStep => ({ tool: "mcp__bot__SendMessage", input: { content } });
const slow = (text: string): FakeStep[] => (/\bslowly\b/i.test(text) ? [{ wait: 4000 }] : []);
const meOf = (systemAppend: string) => /You are ([^,]+), a persistent assistant/.exec(systemAppend)?.[1]?.trim() ?? "Bot";
const idOf = (systemAppend: string, name: string) => new RegExp(`- ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(id: ([^)]+)\\)`).exec(systemAppend)?.[1] ?? null;

/**
 * FUZZ/E2E brain: never calls Claude. Commands (user messages):
 *   run: <cmd>                                  → Bash through the real hooks and review pipeline (Phase 1)
 *   remember: <fact> · save skill: <name> · ask: <question>|<opt>|<opt> · send back: <workspace path>
 *   react please · card: table|link|form|email  → Phase 2 memory / skills / widgets / files / reactions / cards
 *   say link: <url>                             → a reply with that link (Bot sharing: a share link in a chat)
 *   computer: · bg: · task: · secret:           → Phase 3 (demo-phase3.ts, consulted first for user turns)
 *   ask <Name>: <text>                          → SendToAgent kind:"request" to that teammate (B2B-01)
 *   routine: <name> | <schedule> | <prompt>     → update_state target:"routine" action:"create" (RTN-02)
 *   choose: <A> or <B>                          → a widget "Which one?" (CHAT-16)
 *   local: · local-wait: · install: · code:     → Phase 5 ExternalShell / InstallPlugin / CodingAgent (+ a rate_limit usage event)
 *   gmail: · read mail: · mail: · calendar: · drive: → the built-in Google connector (demo-google.ts)
 *   "slowly" in a routine prompt or a group post → that routine run / member turn waits 4 s first (fuzz abuse cases)
 * Wakes: a request is answered with one result; a result is relayed to the user; routine fires report
 * "Routine ran: <name>"; group turns post once per room turn, then "(pass)".
 */
export function demoScriptFor(workspace: string): FakeScript {
  return (input, ctx) => {
    if (ctx.nudge) return [send("Sorry, here it is: done.")];
    // The per-turn clock (bug #50) is host context, not a command: keep it out of what the demo parses.
    const text = input.prompt.map(messageText).filter((t) => !t.startsWith("<system_reminder>Now: ")).join("\n");
    const me = meOf(input.systemAppend ?? "");

    // Phase 4 wake sources first: their text is teammate/routine content, not user commands.
    if (input.source === "group-member") {
      const history = text.split("It's your turn")[0] ?? "";
      const sinceUser = history.slice(Math.max(0, history.lastIndexOf("\nUser: ")));
      if (/Here's a first take:/.test(sinceUser)) return [send("(pass)")]; // someone already answered the latest user post
      const topic = [...text.matchAll(/^User: (.+)$/gm)].at(-1)?.[1]?.replace(/^(@\w+\s*)+/, "").trim() ?? "this";
      return [...slow(topic), send(`Here's a first take: ${topic}`)];
    }
    if (input.source === "agent") {
      const req = /<message kind="(?:request|question)" id="(r_[a-z0-9]+)"[^>]*>\s*([\s\S]*?)<\/message>/.exec(text);
      if (req) {
        const fromName = /<message kind="(?:request|question)"[^>]*from="([^"(]+?) \(id /.exec(text)?.[1] ?? "";
        const target = idOf(input.systemAppend ?? "", fromName);
        if (!target) return [];
        return [{ tool: "mcp__bot__SendToAgent", input: { target_id: target, kind: "result", in_reply_to: req[1], message: `${me} says: done — ${req[2]!.trim()}` } }];
      }
      const res = /<message kind="result"[^>]*>\s*([\s\S]*?)<\/message>/.exec(text);
      if (res) return [send(res[1]!.trim())];
      return [];
    }
    if (input.source === "routine") {
      const name = /"([^"]+)"/.exec(text)?.[1] ?? "routine";
      return [...slow(text), send(`Routine ran: ${name}`)];
    }

    const p3 = phase3DemoSteps(input);
    if (p3) return p3;
    const google = input.source === "user" ? googleDemoSteps(input) : null;
    if (google) return google;
    if (input.source === "kickstart") return [send("Hi! Tell me what you'd like help with. Lasting instructions for me go in Bot Settings.")];
    if (input.source === "reaction") return []; // silence-allowed: a reaction needs no reply
    if (input.source === "widget-answer") {
      // Phase 4's "choose:" widget asks "Which one?"; Phase 2's "ask:" widgets echo the answer.
      if (/\("Which one\?"\)/.test(text)) return [send(`You picked ${/\): (.+)$/m.exec(text)?.[1] ?? "that"}.`)];
      return [send(`Got it: ${/: ([^\n]+)$/m.exec(text)?.[1] ?? "thanks"}.`)];
    }
    // Bug #96: a Mac card ends the turn; the user's answer wakes the Bot, which runs exactly that command again.
    const macResume = /\[Mac\] The user approved on their Mac: (.+)\. Run exactly that again now\./.exec(text)?.[1];
    if (macResume) return [{ tool: "mcp__bot__ExternalShell", input: { command: macResume, block_ms: 20_000 } }, send("Done on your Mac.")];
    // Silence-allowed hidden wakes stay quiet (Phase 4), except a coding agent's result, which the Bot reports (EVT-02 #11).
    if (input.hidden) return input.silenceAllowed && input.source !== "coding-agent" ? [] : [send("Still here. Where were we?")];

    let m: RegExpExecArray | null;
    if ((m = /remember:\s*(.+)/i.exec(text))) return [{ tool: "mcp__bot__update_state", input: { target: "memory", action: "write", fact: m[1]!.trim(), tier: "profile" } }, send("Noted.")];
    if ((m = /save skill:\s*(.+)/i.exec(text))) return [{ tool: "mcp__bot__update_state", input: { target: "workflow", action: "write", name: m[1]!.trim(), description: `Use this when the user asks for ${m[1]!.trim().toLowerCase()}.`, body: "1. Gather the inputs\n2. Draft\n3. Ask before sending" } }, send("Saved it as a skill.")];
    if ((m = /ask:\s*([^|\n]+)\|([^\n]+)/i.exec(text))) return [{ tool: "mcp__bot__SendMessage", input: { type: "widget", widget: { question: m[1]!.trim(), options: m[2]!.split("|").map((o) => ({ label: o.trim(), value: o.trim() })) } } }];
    if ((m = /card:\s*(table|link|form|email)/i.exec(text))) {
      const cards: Record<string, unknown> = {
        table: { kind: "table", title: "Flights", columns: ["Flight", "Departs", "Price"], rows: [["UA 512", "9:10 AM", "$248"], ["DL 88", "6:05 PM", "$231"]] },
        link: { kind: "link", url: "https://example.com/itinerary", title: "Itinerary", description: "Denver, Oct 14–16" },
        form: { kind: "form", title: "Trip details", fields: [{ name: "city", label: "City", kind: "text", required: true }, { name: "notes", label: "Notes", kind: "textarea" }, { name: "seat", label: "Seat", kind: "select", options: ["Aisle", "Window"] }], submitLabel: "Send" },
        email: { kind: "email-draft", from: null, to: ["dana@example.com"], subject: "Q3 deck", body: "Hi Dana,\n\nThe deck is attached.\n\nThanks" },
      };
      return [{ tool: "mcp__bot__SendMessage", input: { type: "card", card: cards[m[1]!.toLowerCase()] } }];
    }
    // Bot sharing e2e: a reply carrying a link (e.g. a synapse://import link), rendered as a markdown link.
    if ((m = /say link:\s*(\S+)/i.exec(text))) return [send(`[Add this Bot](${m[1]})`)];
    if ((m = /send back:\s*(\S+)/i.exec(text))) return [{ tool: "mcp__bot__SendMessage", input: { type: "attachment", url: `file://${path.join(workspace, m[1]!)}`, content: "Here it is." } }];
    if (/react please/i.test(text)) return [{ tool: "mcp__bot__ReactToMessage", input: { message_address: /\[(t\d+u)\]/.exec(text)?.[1] ?? "t1u", emoji: "👍" } }];

    const at = (re: RegExp) => re.exec(text)?.[1]?.split("\n")[0]!.trim();
    const usageEvent = { emit: { kind: "rate_limit" as const, status: "allowed", windows: { seven_day: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 5 * 86_400 } } } };
    // LOC-06 lifecycle journey: block long enough for the Mac-unavailable watchdog, then relay what the tool said.
    const localWait = at(/local-wait:\s*(.+)/i);
    if (localWait) return [send("Checking on your Mac."), { tool: "mcp__bot__ExternalShell", input: { command: localWait, block_ms: 120_000 } }, { relayLastToolOutput: true }];
    const local = at(/local:\s*(.+)/i);
    if (local) return [usageEvent, send("Checking on your Mac."), { tool: "mcp__bot__ExternalShell", input: { command: local, block_ms: 20_000 } }, send("Done on your Mac.")];
    const install = at(/install:\s*(\S+)/i);
    if (install) return [usageEvent, { tool: "mcp__bot__InstallPlugin", input: { plugin_id: install } }, send(`Asked to install ${install}.`)];
    const code = at(/code:\s*(\S+)/i);
    if (code) return [usageEvent, { tool: "mcp__bot__CodingAgent", input: { action: "launch", repo: code, task: "Add a line to the README (demo)" } }, send("Launched a coding agent.")];

    const ask = /ask ([A-Z][\w ]*?):\s*(.+)/.exec(text);
    if (ask) {
      const target = idOf(input.systemAppend ?? "", ask[1]!.trim());
      if (!target) return [send(`I can't find ${ask[1]} in my teammates.`)];
      return [send(`Asking ${ask[1]}.`), { tool: "mcp__bot__SendToAgent", input: { target_id: target, kind: "request", message: ask[2]!.split("\n")[0]!.trim(), expects: "a short list of options" } }];
    }
    const routine = /routine:\s*([^|]+)\|\s*([^|]+)\|\s*(.+)/.exec(text);
    if (routine) {
      return [{ tool: "mcp__bot__update_state", input: { target: "routine", action: "create", name: routine[1]!.trim(), schedule: routine[2]!.trim(), prompt: routine[3]!.split("\n")[0]!.trim() } }, send(`Saved "${routine[1]!.trim()}".`)];
    }
    const choose = /choose:\s*(.+?)\s+or\s+(.+)/.exec(text);
    if (choose) {
      const opts = [choose[1]!, choose[2]!.split("\n")[0]!].map((o) => o.trim());
      return [{ tool: "mcp__bot__SendMessage", input: { type: "widget", widget: { question: "Which one?", options: opts.map((o) => ({ label: o, value: o.toLowerCase() })) } } }];
    }
    const r = /run:\s*(.+)/i.exec(text);
    const command = (r?.[1] ?? "ls -la /workspace").split("\n")[0]!.trim();
    return [usageEvent, send("On it."), { think: true }, { tool: "Bash", input: { command, description: "demo" } }, send(`Done: ${command}`)];
  };
}

export const demoScript: FakeScript = demoScriptFor("/workspace");
