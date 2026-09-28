import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasTurn, type SendRouter } from "../../runner/turn-runner";
import { makeRunnerHarness } from "./harness";

const send = (text: string) => ({ tool: "mcp__bot__SendMessage", input: { content: text } });

const src = (rel: string): string => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

describe("Task 2 fix round 1", () => {
  // Finding 1: PostToolHook's `slot` param is typed `TurnSlot | null`, not `TurnSlot` as the brief's
  // Produces line literally reads. That widening is required by the brief's own Step-1 test
  // (wiring(id).postToolUse() called with no turn started) and is not a mistake, but a hook written
  // against the brief's literal (non-null) type would crash on a real-but-unstarted-turn call. Fixed by
  // (a) an exported, documented type guard hooks can use instead of an ad hoc null-check, and (b) a
  // pinned doc comment on PostToolHook itself, so Tasks 29/30/38 don't have to rediscover this from the
  // brief text.
  describe("finding 1: PostToolHook nullable slot", () => {
    it("hasTurn narrows TurnSlot | null and is exported for hook authors", () => {
      expect(hasTurn(null)).toBe(false);
      // A structurally-real TurnSlot-shaped value narrows to true; hooks that need turn state (context,
      // counters, …) branch on this instead of assuming the brief's literal non-null type.
      const fakeSlot = { botId: "b1", context: { sideEffects: 0 } } as Parameters<typeof hasTurn>[0];
      expect(hasTurn(fakeSlot)).toBe(true);
    });

    it("a hook using hasTurn never throws when postToolUse fires with no active turn", async () => {
      const h = await makeRunnerHarness({ script: () => [] });
      const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
      let sawNullSlot = false;
      h.runner.addPostToolHook((_b, slot, call) => {
        if (!hasTurn(slot)) { sawNullSlot = true; return null; }
        // A hook written against the brief's literal `TurnSlot` type would dereference `slot.context`
        // unguarded here and crash on this exact call.
        return `ctx=${slot.context.sideEffects}:${call.toolName}`;
      });
      const out = await h.runner.wiring(id).postToolUse({ toolName: "Bash", input: { command: "ls" }, toolUseId: "t1" }, "ok");
      expect(sawNullSlot).toBe(true);
      expect(out.additionalContext ?? "").toBe("");
    });

    it("PostToolHook carries a doc comment pinning the nullable-slot contract", () => {
      const s = src("runner/turn-runner.ts");
      const line = s.split("\n").find((l) => l.includes("export type PostToolHook ="));
      expect(line).toContain("TurnSlot | null");
      // The comment immediately above the type must explain *why* and point hook authors at `hasTurn`.
      const idx = s.indexOf("export type PostToolHook =");
      const before = s.slice(Math.max(0, idx - 800), idx);
      expect(before).toMatch(/null when|no active turn|unstarted turn/i);
      expect(before).toContain("hasTurn");
    });
  });

  // Finding 2: a SendRouter's successful return bumps deliver()'s turn-counter bookkeeping via the
  // shared markSent(slot), but deliberately does NOT call noteBotMessage() (last-bot-message/preview
  // tracking) the way deliver() does. That's a legitimate call — a routed send (Task 37's GroupPoster,
  // Task 38's control plane) may not be a "message" a preview should reflect — but it's new
  // production-facing behavior the brief's Step 3 sample never spells out. Pinned here so a future
  // change to markSent (accidentally adding the noteBotMessage call, or a router silently relying on
  // one) shows up as a failing test instead of a silent behavior change.
  describe("finding 2: markSent does not call noteBotMessage", () => {
    it("markSent's doc comment states the asymmetry with deliver()/noteBotMessage explicitly", () => {
      const s = src("tools/bot-tools.ts");
      const idx = s.indexOf("const markSent =");
      expect(idx).toBeGreaterThan(-1);
      const before = s.slice(Math.max(0, idx - 700), idx);
      expect(before).toMatch(/noteBotMessage/);
      expect(before).toMatch(/does not|deliberately|never calls/i);
    });

    it("a routed successful send leaves last-bot-message state untouched, unlike a direct deliver()", async () => {
      const h = await makeRunnerHarness({
        script: (_input, ctx) =>
          ctx.turnIndex === 0
            ? [{ tool: "mcp__bot__SendMessage", input: { type: "widget", widget: { question: "Q?", options: [] } } }]
            : [send("plain text, no router match")],
      });
      const id = h.bots.create({ origin: "user", kickstart: false, name: "Piper" });
      const router: SendRouter = (_b, _slot, a) =>
        a.type === "widget" ? Promise.resolve({ text: "Widget sent." }) : null;
      h.runner.registerSendRouter(router);

      expect(h.bots.summary(id).lastBotMessageAt).toBe(0);

      // Turn 1: routed through the SendRouter — markSent runs (turn-counter bookkeeping), noteBotMessage
      // must not (finding 2's asymmetry).
      h.runner.sendPrompt(id, "ask me", "n1");
      await h.untilIdle(id);
      expect(h.bots.summary(id).lastBotMessageAt).toBe(0);

      // Turn 2: no router matches ("text" type falls through) — the default path still calls
      // deliver() -> noteBotMessage exactly as before Task 2.
      h.runner.sendPrompt(id, "hi", "n2");
      await h.untilIdle(id);
      expect(h.bots.summary(id).lastBotMessageAt).toBeGreaterThan(0);
    });
  });
});
