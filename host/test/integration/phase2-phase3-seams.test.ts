import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FormCardView, SendMessageEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { createWidgetCommands } from "../../chat/widget-commands";
import { createWidgetExtension } from "../../chat/widgets";
import { mirrorRecord } from "../../context/transcript-mirror";
import { SseHub } from "../../gateway/sse-hub";
import { AckLedger } from "../../runner/ack-ledger";
import { CreationLedger } from "../../runner/creation-ledger";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { createBotTools } from "../../tools/bot-tools";
import { tmpConfig } from "../helpers";

// Phase 2 (CHAT-16 chat cards) and Phase 3 (SEC-04 page-fill forms) both answer SendMessage type "card"
// with kind "form". The merge routes page-targeting forms to Phase 3 and every other card to Phase 2.
function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const settings = new HostSettingsStore(path.join(cfg.dataRoot, "settings.json"));
  const bots = new BotService({ cfg, hub: new SseHub(), settings });
  const acks = new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json"));
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const slot: TurnSlot = newSlot({ botId: id, requestId: "req_1", turnNo: 1, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 1 });
  const p3 = { card: vi.fn(async () => ({ text: "p3 form" })), "secret-request": vi.fn(async () => ({ text: "p3 secret" })) };
  let t = 0;
  const tools = createBotTools({
    botId: id, slot: () => slot, bots, acks, creations: new CreationLedger(path.join(cfg.hostPrivate, "bot-creations.json")), now: () => (t += 1000),
    createBot: () => "x",
    ext: createWidgetExtension({ bots, now: () => t }),
    sendHandlers: p3,
  });
  const send = tools.find((x) => x.name === "SendMessage")!;
  return { bots, acks, id, send, p3 };
}

describe("SendMessage routing across Phase 2 and Phase 3", () => {
  it("sends a plain form card through Phase 2 (CHAT-16)", async () => {
    const s = setup();
    const r = await s.send.handler({ type: "card", card: { kind: "form", title: "Trip", fields: [{ name: "city", label: "City", kind: "text" }] } });
    expect(r.isError).toBeFalsy();
    expect(s.p3.card).not.toHaveBeenCalled();
    expect(s.bots.getEntry(s.id, "t1s1")).toMatchObject({ status: "pending", message: { type: "card", card: { kind: "form", title: "Trip" } } });
  });

  it("sends a form with a url, fillTarget or secret field through Phase 3 (SEC-04)", async () => {
    for (const card of [
      { kind: "form", title: "Checkout", url: "https://shop.example/checkout", fields: [{ name: "zip", label: "ZIP" }] },
      { kind: "form", title: "Login", fields: [{ name: "pw", label: "Password", secret: true, fillTarget: { ref: "e3" } }] },
      { kind: "form", title: "Address", fields: [{ name: "street", label: "Street", fillTarget: { selector: "#street" } }] },
    ]) {
      const s = setup();
      expect(await s.send.handler({ type: "card", card })).toEqual({ text: "p3 form" });
      expect(s.p3.card).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the other Phase 2 card kinds and widgets on Phase 2, and secret-request on Phase 3", async () => {
    const s = setup();
    await s.send.handler({ type: "card", card: { kind: "link", url: "https://example.com", title: "Example" } });
    expect(s.p3.card).not.toHaveBeenCalled();
    expect(await s.send.handler({ type: "secret-request", secret: { label: "Key" } })).toEqual({ text: "p3 secret" });
  });
});

describe("Phase 2 widget answers never touch a Phase 3 page-fill form", () => {
  it("refuses respondToWidget on a page-fill form card", async () => {
    const s = setup();
    const card: FormCardView = { kind: "form", title: "Login", url: "https://x.example", fields: [{ name: "pw", label: "Password", type: "password", secret: true, required: true, fillTarget: { ref: "e1" } }], status: "pending", answeredFields: [] };
    const e: SendMessageEntry = { kind: "send-message", id: "t1s9", requestId: "r", createdAt: 1, status: "pending", message: { type: "card", card } };
    s.bots.appendEntry(s.id, e);
    const cmd = createWidgetCommands({ bots: s.bots, acks: s.acks, wake: () => {} });
    await expect(cmd.respondToWidget!({ id: s.id, entryId: "t1s9", value: "", formValues: { pw: "hunter2" } })).rejects.toMatchObject({ code: "NOT_INTERACTIVE" });
  });
});

describe("transcript mirror covers the Phase 3 message types (CTX-04)", () => {
  it("mirrors box-help and secret-request without the secret value", () => {
    const help = mirrorRecord({ kind: "send-message", id: "t1s1", requestId: "r", createdAt: 1, message: { type: "box-help", request: { instruction: "Sign in to Northwind" } as never } });
    expect(JSON.stringify(help)).toContain("Sign in to Northwind");
    const sec = mirrorRecord({ kind: "send-message", id: "t1s2", requestId: "r", createdAt: 2, message: { type: "secret-request", secret: { label: "Stripe key", description: "", destination: "env", field: "STRIPE_KEY", connector: null, url: null, target: null, status: "saved" } } });
    expect(JSON.stringify(sec)).toContain("Stripe key");
    expect(JSON.stringify(sec)).not.toContain("approval card");
  });
});
