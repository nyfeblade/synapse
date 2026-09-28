import path from "node:path";
import { describe, expect, it } from "vitest";
import { STRC, type SendMessageEntry, type SseEvent } from "@synapse/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BotService } from "../../bots/bot-service";
import { toSdkMcpServer } from "../../brain/sdk-wiring";
import type { BrainWiring } from "../../brain/types";
import { BoxHelpService, createBoxHelpTool } from "../../computer/box-help";
import { SseHub } from "../../gateway/sse-hub";
import { AckLedger } from "../../runner/ack-ledger";
import { newSlot } from "../../runner/turn-slot";
import type { HiddenSpec } from "../../runner/turn-runner";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const hub = new SseHub();
  const events: SseEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const bots = new BotService({ cfg, hub, settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
  const acks = new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json"));
  const id = bots.create({ origin: "user", kickstart: false, name: "Scout" });
  const slot = newSlot({ botId: id, requestId: "req_7", turnNo: 3, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 2, ackToken: null, userMessageEpoch: 1, startedAt: 1 });
  const wakes: { botId: string; spec: HiddenSpec }[] = [];
  const svc = new BoxHelpService({
    bots, acks, hub, capture: async () => "data:image/webp;base64,AAAA", slot: () => slot,
    enqueueHidden: (botId, spec) => wakes.push({ botId, spec }), now: () => 5000,
  });
  const tool = createBoxHelpTool({ botId: id, service: svc });
  return { bots, id, slot, wakes, svc, tool, events };
}

describe("request_box_help (CMP-08)", () => {
  it("posts the Computer card with a screenshot, sets awaiting box, and ends the turn", async () => {
    const s = setup();
    const r = await s.tool.handler({ instruction: "Sign in to Northwind Air so I can hold the fare.\nThanks", reason: "auth", domain: "northwind-air.example" });
    expect(r).toEqual({ text: STRC.boxHelpSent });
    expect(s.slot.awaitingUserSelection).toBe(true);
    expect(s.slot.sentMessageCount).toBe(1);
    const entry = s.bots.tail(s.id, 5).find((e) => e.kind === "send-message") as SendMessageEntry;
    expect(entry.message).toMatchObject({ type: "box-help", request: { instruction: "Sign in to Northwind Air so I can hold the fare. Thanks", reason: "auth", domain: "northwind-air.example", status: "pending", inControl: false, screenshotDataUrl: "data:image/webp;base64,AAAA" } });
    expect(entry.id).toBe("t3s1");
    expect(s.bots.summary(s.id).awaiting).toMatchObject({ tabId: "box", reason: "Sign in to Northwind Air so I can hold the fare. Thanks" });
    expect(s.events.some((e) => e.channel === "box-help")).toBe(true);
  });

  it("refuses a second request while one is pending ('do NOT ask again')", async () => {
    const s = setup();
    await s.tool.handler({ instruction: "Sign in", reason: "auth" });
    s.slot.awaitingUserSelection = false;
    expect(await s.tool.handler({ instruction: "Solve the captcha", reason: "captcha" })).toEqual({ text: STRC.boxHelpDuplicate });
  });

  it("I'm done → handed_back, awaiting cleared, wake #12 with an ack token and no silence", async () => {
    const s = setup();
    await s.tool.handler({ instruction: "Sign in", reason: "auth" });
    const reqId = s.svc.pending(s.id)!.id;
    s.svc.setInControl(s.id, reqId, true);
    expect(s.svc.pending(s.id)!.inControl).toBe(true);
    const v = s.svc.handBack(s.id, reqId, "done");
    expect(v).toMatchObject({ status: "handed_back", inControl: false, settledAt: 5000 });
    expect(s.bots.summary(s.id).awaiting).toBeNull();
    expect(s.wakes[0]!.spec).toMatchObject({ source: "box-handback", lane: "background", silenceAllowed: false });
    expect(s.wakes[0]!.spec.text).toMatch(/^\[The user has given the box back to you\..*read-only mcp__bot__Screenshot tool/s);
    expect(s.wakes[0]!.spec.ackToken).toEqual(expect.any(String));
    expect(s.svc.pending(s.id)).toBeNull();
  });

  it("Skip and viewer-closed use their variants and quote the instruction", async () => {
    const s = setup();
    await s.tool.handler({ instruction: "Solve the captcha", reason: "captcha" });
    s.svc.handBack(s.id, s.svc.pending(s.id)!.id, "skip");
    expect(s.wakes[0]!.spec.text).toContain("“Solve the captcha”");
    expect(s.wakes[0]!.spec.text).toMatch(/Don't ask again/);
    await s.tool.handler({ instruction: "Pay", reason: "payment" });
    s.svc.handBack(s.id, s.svc.pending(s.id)!.id, "viewer_closed");
    expect(s.wakes[1]!.spec.text).toMatch(/closed the computer view/);
  });

  it("a stale hand-back is a 409", async () => {
    const s = setup();
    await s.tool.handler({ instruction: "Sign in", reason: "auth" });
    const id = s.svc.pending(s.id)!.id;
    s.svc.handBack(s.id, id, "done");
    expect(() => s.svc.handBack(s.id, id, "done")).toThrow(/already answered/);
  });

  it("passes the mcpfix tools/list pattern (never z.record(), served fine over MCP)", async () => {
    const s = setup();
    const server = toSdkMcpServer({ botTools: () => [s.tool] } as unknown as BrainWiring);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["request_box_help"]);
    } finally {
      await client.close();
    }
  });
});
