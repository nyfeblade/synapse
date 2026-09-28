import { describe, expect, it } from "vitest";
import { classifyTurn, ModelRouter, ROUTE_MAX_CONTEXT, ROUTED_MODEL, STICKY_MS, type RouteTurn } from "../../brain/model-router";

/** cost-diet-2 lever 1: the deterministic routing signal and the router's state (no model call anywhere). */
const typed = (text: string, over: Partial<RouteTurn> = {}): RouteTurn => ({ source: "user", lane: "user", text, images: 0, ...over });

describe("classifyTurn: quick chat is simple, anything that asks for work is hard", () => {
  it.each(["hi", "thanks!", "good morning", "lol that's great", "what's the capital of France?", "how are you today?", "ok", "who wrote Dune?", "nice, love it"])("simple: %s", (text) => {
    expect(classifyTurn(typed(text)).kind).toBe("simple");
  });

  it.each([
    "can you check my inbox", "please send it", "fix the failing test", "look up flights to Lisbon", "remind me at 5",
    "what's in src/app.ts", "see https://example.com", "run `ls`", "email bob@example.com", "I need a summary of this",
    "how do I reset my router", "schedule a call with Ana", "yes, do it and send the draft", "add milk to the list",
  ])("hard: %s", (text) => {
    expect(classifyTurn(typed(text)).kind).toBe("hard");
  });

  it("hard: long, multi-line, an attachment, no text", () => {
    expect(classifyTurn(typed("so ".repeat(100))).reason).toBe("a long message");
    expect(classifyTurn(typed("hi\nthere")).reason).toBe("several lines");
    expect(classifyTurn(typed("what is this?", { images: 1 })).reason).toBe("an attachment");
    expect(classifyTurn(typed("  ")).kind).toBe("hard");
  });

  it("hard: every wake but a reaction (routines, peers, nudges, resumes, heartbeats, coding-agent reports)", () => {
    for (const source of ["routine", "heartbeat", "agent", "reply-nudge", "approval-resume", "coding-agent", "subagent-done", "kickstart"] as const) {
      expect(classifyTurn(typed("hi", { source, lane: "background" })).kind, source).toBe("hard");
    }
    expect(classifyTurn(typed("", { source: "reaction" })).kind).toBe("simple");
    expect(classifyTurn(typed("hi", { lane: "agent" })).kind, "a peer's message on the user source is still not the user").toBe("hard");
  });
});

describe("ModelRouter", () => {
  function setup(o: { enabled?: boolean; engineering?: boolean; ctx?: number } = {}) {
    let t = 1_000;
    const state = { enabled: o.enabled ?? true, engineering: o.engineering ?? false, ctx: o.ctx ?? 0 };
    const r = new ModelRouter({ enabled: () => state.enabled, engineering: () => state.engineering, contextTokens: () => state.ctx, now: () => t });
    return { r, state, advance: (ms: number) => { t += ms; } };
  }

  it("is off unless Save usage is on, and never routes an engineering-mode Bot", () => {
    expect(setup({ enabled: false }).r.decide("b", typed("hi"))).toBeNull();
    expect(setup({ engineering: true }).r.decide("b", typed("hi"))).toBeNull();
    expect(setup().r.decide("b", typed("hi"))).toEqual({ model: ROUTED_MODEL, reason: "quick chat" });
    expect(setup().r.decide("b", typed("fix it"))).toBeNull();
  });

  it("never routes a context the cheap model can't hold", () => {
    expect(setup({ ctx: ROUTE_MAX_CONTEXT + 1 }).r.decide("b", typed("hi"))).toBeNull();
    expect(setup({ ctx: ROUTE_MAX_CONTEXT }).r.decide("b", typed("hi"))).not.toBeNull();
  });

  it("after work, an escalation or a failure, the Bot stays on its own model for a while (per Bot)", () => {
    for (const r of [{ escalated: true, failed: false, workTools: 0 }, { escalated: false, failed: true, workTools: 0 }, { escalated: false, failed: false, workTools: 2 }]) {
      const s = setup();
      s.r.settled("b", r);
      expect(s.r.decide("b", typed("thanks")), JSON.stringify(r)).toBeNull();
      expect(s.r.decide("other", typed("thanks"))).not.toBeNull();
      s.advance(STICKY_MS + 1);
      expect(s.r.decide("b", typed("thanks"))).not.toBeNull();
    }
    const s = setup();
    s.r.settled("b", { escalated: false, failed: false, workTools: 0 });
    expect(s.r.decide("b", typed("thanks")), "a plain chat turn changes nothing").not.toBeNull();
  });
});

describe("the per-Bot Save usage switch (gateway)", () => {
  it("sets, clears back to the account setting, and needs no respawn", async () => {
    const { createHostApp } = await import("../../app");
    const { tmpConfig } = await import("../helpers");
    const app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    try {
      const { id } = await app.handlers.createAgent!({ name: "Saver", isKickstartRequested: false });
      const key = app.services.spawnConfig(id).spawnKey;
      expect((await app.handlers.setAgentSaveUsage!({ id, enabled: true })).agent.settings.saveUsage).toBe(true);
      expect(app.services.spawnConfig(id).spawnKey, "routing is per turn, not a spawn-time state").toBe(key);
      expect((await app.handlers.setAgentSaveUsage!({ id, enabled: null })).agent.settings.saveUsage).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
