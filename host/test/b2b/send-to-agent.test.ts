import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessageEntry, EventEntry } from "@synapse/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import { broadcast } from "../../tools/send-to-agent";
import { b2bHarness, promptText, say, sta } from "./harness";

let h: ReturnType<typeof b2bHarness>;
afterEach(() => h?.stop());

const agentEntries = (name: string) => h.bots.tail(h.id(name), 200).filter((e): e is AgentMessageEntry => e.kind === "message" && ("toAgent" in e || "fromAgent" in e));

describe("SendToAgent", () => {
  it("refuses self, unknown and deleted targets with the fixed refusal strings", async () => {
    h = b2bHarness(["Piper", "Scout", "Ledger"]);
    h.script("Piper", () => [
      sta({ target_id: h.id("Piper"), kind: "question", message: "Is this me?", expects: "a yes or a no" }),
      sta({ target_id: "nope", kind: "question", message: "Who are you?", expects: "a name please" }),
      sta({ target_id: h.id("Ledger"), kind: "question", message: "What is the Q3 total?", expects: "a dollar amount" }),
      say("ok"),
    ]);
    h.script("Ledger", () => []);
    h.user("Piper", "go");
    await h.settle();
    await h.runner.deleteBot(h.id("Ledger"));
    h.script("Piper", () => [sta({ target_id: h.ids.Ledger as string, kind: "question", message: "Still there? The Q3 total please", expects: "a dollar amount" }), say("ok")]);
    h.user("Piper", "again");
    await h.settle();
    const texts = h.toolLog("Piper").map((l) => l.text);
    expect(texts[0]).toBe("Can't message itself");
    expect(texts[1]).toBe("No Bot or group with id nope.");
    expect(texts[3]).toBe("That agent has been deleted");
  });

  it("delivers a request: result string, entries on both sides, no unread, partners, one wake with the typed message", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    h.script("Piper", (input) => (input.source === "user" ? [sta({ target_id: h.id("Scout"), kind: "request", message: "Please build a CSV of Q3 leads from the CRM export", expects: "a CSV at /workspace/leads-q3.csv" }), say("Asked Scout.")] : []));
    h.script("Scout", () => []);
    const unreadBefore = h.bots.summary(h.id("Scout")).marker;
    h.user("Piper", "get me Q3 leads");
    await h.settle();
    const out = h.toolLog("Piper")[0]?.text ?? "";
    expect(out).toMatch(/^Sent request r_[a-z2-7]{8} to Scout\. Its result will wake you once — don't wait on it now\.$/);
    const rid = out.split(" ")[2];
    expect(agentEntries("Piper")[0]).toMatchObject({ role: "assistant", toAgent: { id: h.id("Scout"), name: "Scout", kind: "request", rid } });
    expect(agentEntries("Scout")[0]).toMatchObject({ role: "user", fromAgent: { id: h.id("Piper"), name: "Piper", kind: "request", rid }, content: "Please build a CSV of Q3 leads from the CRM export" });
    expect(h.bots.summary(h.id("Scout")).marker).toBe(unreadBefore);
    expect(h.bots.require(h.id("Scout")).store.getKv<string[]>("conversationPartners", [])).toEqual([h.id("Piper")]);
    expect(h.agentWakes("Scout")).toHaveLength(1);
    expect(promptText(h.agentWakes("Scout")[0]!)).toContain(`<message kind="request" id="${rid}"`);
    expect(h.requests.get(rid as string)).toMatchObject({ status: "open", from: h.id("Piper"), to: h.id("Scout") });
  });

  it("drops an acknowledgement: it appears in no transcript, wakes no one, and counts as dropped", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    h.script("Piper", () => [sta({ target_id: h.id("Scout"), kind: "result", message: "Thanks!" }), say("ok")]);
    h.user("Piper", "thank Scout");
    await h.settle();
    expect(h.toolLog("Piper")[0]).toMatchObject({ isError: false, text: expect.stringContaining("Not sent: this only acknowledges or thanks.") });
    expect(agentEntries("Piper")).toEqual([]);
    expect(agentEntries("Scout")).toEqual([]);
    expect(h.inputs("Scout")).toHaveLength(0);
    expect(h.metrics.efficiency().messagesDropped).toBe(1);
  });

  it("puts an unsolicited result in the inbox without a wake and folds it into the next turn", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    h.script("Piper", () => [sta({ target_id: h.id("Scout"), kind: "result", message: "FYI: moved the report to /workspace/reports/q3.pdf" }), say("ok")]);
    h.script("Scout", () => [say("hi")]);
    h.user("Piper", "tell Scout");
    await h.settle();
    expect(h.toolLog("Piper")[0]?.text).toBe("Sent to Scout's inbox (no wake): a result that answers no open request never wakes anyone.");
    expect(agentEntries("Scout")[0]).toMatchObject({ inbox: true });
    expect(h.inputs("Scout")).toHaveLength(0);
    h.user("Scout", "hello");
    await h.settle();
    expect(promptText(h.inputs("Scout")[0]!)).toContain("Inbox (no reply needed):\n- Piper: FYI: moved the report to /workspace/reports/q3.pdf");
    expect(h.metrics.efficiency().wakesAvoided).toBeGreaterThanOrEqual(1);
  });

  it("adds a 'Messaged N Bots' row on fan-out and rations priority", async () => {
    h = b2bHarness(["Piper", "Scout", "Ledger"]);
    h.script("Piper", (input) => (input.source === "user" ? [
      sta({ target_id: h.id("Scout"), kind: "question", priority: true, message: "Which hotel is cheapest?", expects: "a hotel name" }),
      sta({ target_id: h.id("Ledger"), kind: "question", message: "What's our travel budget?", expects: "a dollar amount" }),
      say("Asked both."),
    ] : []));
    h.user("Piper", "plan the trip");
    await h.settle();
    expect(h.toolLog("Piper")[0]?.text).toContain("Sent to Scout as a normal message: priority is only for blockers and requests.");
    const ev = h.bots.tail(h.id("Piper"), 50).find((e): e is EventEntry => e.kind === "event" && e.event.type === "agents-messaged");
    expect(ev?.event).toMatchObject({ type: "agents-messaged", botIds: [h.id("Scout"), h.id("Ledger")] });
  });

  it("puts the contract, the teammate directory with ids and the ask-your-teammate rule (bug #61) in the Bot prompt", () => {
    h = b2bHarness(["Piper", "Scout"]);
    const p = h.runner.systemAppend(h.id("Piper"));
    expect(p).toContain(`- Scout (id: ${h.id("Scout")}) — `);
    // Bug #61: teammates' folders are walled off; the prompt names the one way to ask instead of a path.
    expect(p).toContain('ask it: SendToAgent kind "question"');
    expect(p).not.toContain(`${h.cfg.dataRoot}/agents`);
    // The Bot-to-Bot contract must hang off a real heading, so a model reconstructing structure
    // attaches these rules to "other Bots" and not to the user-facing "acknowledge briefly" rule.
    expect(p).toContain("## Working with other Bots");
    expect(p).toContain("- Never send another Bot acknowledgements, thanks, \"on it\", \"sounds good\" or status\n  chatter. The app drops them and they waste the user's usage.");
    expect(p).toContain("Fan-out to several Bots only when the user asked for it");
  });

  it("broadcasts one background wake #7 to every Bot", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    h.script("Piper", () => [say("noted")]);
    h.script("Scout", () => [say("noted")]);
    expect(broadcast(h.runner, h.bots, "Office closed Friday")).toBe(2);
    await h.settle();
    for (const n of ["Piper", "Scout"]) {
      const i = h.inputs(n)[0]!;
      expect(i).toMatchObject({ source: "broadcast", lane: "background" });
      expect(promptText(i)).toContain("[broadcast] A direct message from your user");
      expect(promptText(i)).toContain("Office closed Friday");
    }
  });
});

describe("SendToAgent's real \"bot\" SDK MCP server (mcpfix round-trip)", () => {
  // bot-tools.test.ts's "mcpfix" test only round-trips createBotTools()'s own tools through the real
  // Agent SDK tools/list path. In production (host/brain/claude-brain.ts:126), the "bot" MCP server is
  // built from `wiring.botTools()`, which is TurnRunner's mergedTools(): createBotTools()'s base tools
  // PLUS every registerToolProvider tool — including SendToAgent (host/tools/send-to-agent.ts), merged
  // in at host/runner/turn-runner.ts:285-289. Nothing exercised SendToAgent's own schema through that
  // exact path, so a bad Zod field there (e.g. a nested z.record()) would silently zero out the whole
  // "bot" server's tools/list — the identical failure mode mcpfix guards against — and nothing here
  // would catch it before the real box. Use the harness's real TurnRunner.wiring(), which is the exact
  // merged BrainWiring claude-brain.ts feeds to toSdkMcpServer at runtime, no cast.
  it("lists SendToAgent (merged in via registerToolProvider) over MCP tools/list, with its real input schema", async () => {
    const h = b2bHarness(["Piper", "Scout"]);
    try {
      const wiring = h.runner.wiring(h.id("Piper"));
      const baseNames = wiring.botTools().map((t) => t.name);
      expect(baseNames).toContain("SendToAgent");
      const server = toSdkMcpServer(wiring);
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverSide);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(clientSide);
      try {
        const listed = await client.listTools();
        expect(listed.tools.map((t) => t.name).sort()).toEqual(baseNames.slice().sort());
        const send = listed.tools.find((t) => t.name === "SendToAgent")!;
        expect(Object.keys(send.inputSchema.properties ?? {})).toEqual(
          expect.arrayContaining(["target_id", "kind", "message", "expects", "in_reply_to", "status", "artifacts", "task_id", "images", "priority"]),
        );
      } finally {
        await client.close();
      }
    } finally {
      h.stop();
    }
  });
});

describe("ruling (d): no closing nudge after delegating", () => {
  it("a request sent after the ack ends the turn without a closing-send nudge; the result wake replies", async () => {
    h = b2bHarness(["Piper", "Scout"]);
    const nudges: string[] = [];
    h.script("Piper", (input, ctx) => {
      if (ctx.nudge) { nudges.push(ctx.nudge); return [say("Sorry: still waiting.")]; }
      return input.source === "user" ? [say("Asking Scout."), sta({ target_id: h.id("Scout"), kind: "request", message: "Please list three venues for the offsite", expects: "three venue names" })] : [];
    });
    h.script("Scout", () => []);
    h.user("Piper", "find venues");
    await h.settle();
    expect(h.toolLog("Piper").some((l) => l.text.startsWith("Sent request"))).toBe(true);
    expect(nudges).toEqual([]);
  });
});

describe("ruling (d) extended: a pending handoff is exempt too; a blocker keeps the nudge", () => {
  const run = async (kind: "handoff" | "blocker") => {
    h = b2bHarness(["Piper", "Scout"]);
    const nudges: string[] = [];
    h.script("Piper", (input, ctx) => {
      if (ctx.nudge) { nudges.push(ctx.nudge); return [say("Update: still on it.")]; }
      return input.source === "user"
        ? [say("Passing this on."), sta({ target_id: h.id("Scout"), kind, message: "Please take over the venue search", ...(kind === "handoff" ? { task_id: "venues-1", expects: "a shortlist of venues" } : {}) })]
        : [];
    });
    h.script("Scout", () => []);
    h.user("Piper", "find venues");
    await h.settle();
    const sent = h.toolLog("Piper").map((l) => l.text).join("\n");
    expect(sent).toMatch(kind === "handoff" ? /^Handed off task venues-1/m : /^Sent blocker/m);
    return nudges;
  };
  it("a handoff after the ack ends the turn without a closing-send nudge", async () => {
    expect(await run("handoff")).toEqual([]);
  });
  it("a blocker after the ack still gets the closing-send nudge", async () => {
    expect((await run("blocker")).length).toBeGreaterThan(0);
  });
});
