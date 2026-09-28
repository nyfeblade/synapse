import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isPageFormCardArgs, type SendMessageEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { refreshAwaiting } from "../../chat/widgets";
import { createWidgetExtension } from "../../chat/widgets";
import { SseHub } from "../../gateway/sse-hub";
import { AckLedger } from "../../runner/ack-ledger";
import { CreationLedger } from "../../runner/creation-ledger";
import { newSlot, type TurnSlot } from "../../runner/turn-slot";
import { SecretRequestService } from "../../secrets/secret-requests";
import { SecretVault } from "../../secrets/vault";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { createBotTools } from "../../tools/bot-tools";
import { tmpConfig } from "../helpers";

/** Security fix M8: password fields, the page-form awaiting flag, and Phase 3 delivery bookkeeping. */
async function setup() {
  const cfg = tmpConfig();
  initLayout(cfg);
  const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
  const acks = new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json"));
  const vault = await SecretVault.open({ hostPrivate: cfg.hostPrivate });
  const id = bots.create({ origin: "user", kickstart: false, name: "Piper" });
  const slot: TurnSlot = newSlot({ botId: id, requestId: "req_1", turnNo: 3, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 1 });
  const svc = new SecretRequestService({
    bots, acks, vault, slot: () => slot, enqueueHidden: () => {}, connectorDir: path.join(cfg.hostPrivate, "connector-secrets"), now: () => 9,
    fill: async () => true,
  });
  let t = 100;
  const tools = createBotTools({
    botId: id, slot: () => slot, bots, acks, creations: new CreationLedger(path.join(cfg.hostPrivate, "bot-creations.json")), now: () => (t += 1000),
    createBot: () => "x", ext: createWidgetExtension({ bots, now: () => t }),
    sendHandlers: { "secret-request": (a, c) => svc.sendSecretRequest(id, a, c), card: (a, c) => svc.sendForm(id, a, c) },
  });
  const send = tools.find((x) => x.name === "SendMessage")!;
  const last = () => bots.tail(id, 20).filter((e): e is SendMessageEntry => e.kind === "send-message").at(-1)!;
  return { bots, id, slot, svc, send, last };
}

describe("password fields never render as a plain chat-card input (M8)", () => {
  it("routes a type:\"password\" field to Phase 3, which rejects it without a fillTarget with a clear error", async () => {
    expect(isPageFormCardArgs({ kind: "form", title: "Login", fields: [{ name: "pw", label: "Password", type: "password" }] })).toBe(true);
    expect(isPageFormCardArgs({ kind: "form", title: "Login", fields: [{ name: "pw", label: "Password", kind: "password" }] })).toBe(true);
    const s = await setup();
    const r = await s.send.handler({ type: "card", card: { kind: "form", title: "Login", fields: [{ name: "user", label: "User" }, { name: "pw", label: "Password", type: "password" }] } });
    expect(r).toEqual({ text: "Password fields are typed into a web page and need a fillTarget (ref or selector). To get a password or key for yourself, use SendMessage type \"secret-request\".", isError: true });
    expect(s.bots.tail(s.id, 10).some((e) => e.kind === "send-message")).toBe(false);
  });

  it("a password field with a fillTarget is a hidden page-fill field", async () => {
    const s = await setup();
    await s.send.handler({ type: "card", card: { kind: "form", title: "Login", fields: [{ name: "pw", label: "Password", type: "password", fillTarget: { ref: "e3" } }] } });
    expect(s.last().message).toMatchObject({ type: "card", card: { fields: [{ name: "pw", type: "password", secret: true }] } });
  });
});

describe("page forms keep the awaiting flag (M8)", () => {
  it("Phase 2's refreshAwaiting doesn't clear it while a page form is pending", async () => {
    const s = await setup();
    await s.send.handler({ type: "card", card: { kind: "form", title: "Checkout", url: "https://shop.example/checkout", fields: [{ name: "zip", label: "ZIP" }] } });
    expect(s.last().status).toBe("pending");
    refreshAwaiting(s.bots, s.id, 50);
    expect(s.bots.summary(s.id).awaiting).toMatchObject({ tabId: "widget", reason: "Checkout" });
    await s.svc.submitForm(s.id, s.last().id, { zip: "80202" }, {});
    expect(s.last().status).toBe("answered");
    refreshAwaiting(s.bots, s.id, 60);
    expect(s.bots.summary(s.id).awaiting).toBeNull();
  });
});

describe("Phase 3 cards get Phase 2's delivery bookkeeping (M8)", () => {
  it("threads reply_to, notes the Bot message and clears typing for secret requests and page forms", async () => {
    const s = await setup();
    s.bots.appendEntry(s.id, { kind: "message", id: "u1u", createdAt: 1, content: "log me in" } as never);
    const typing = vi.spyOn(s.bots, "publishTyping");
    await s.send.handler({ type: "secret-request", reply_to: "u1u", secret: { label: "Stripe key", field: "STRIPE_KEY" } });
    expect(s.last()).toMatchObject({ replyToId: "u1u", branched: true, message: { type: "secret-request" } });
    expect(typing).toHaveBeenCalledWith(s.id, false, null);
    expect(s.bots.require(s.id).store.getKv("lastPreview", "")).toBe("Stripe key");
    expect(s.slot.awaitingUserSelection).toBe(true);
    s.slot.awaitingUserSelection = false;
    await s.send.handler({ type: "card", reply_to: "u1u", card: { kind: "form", title: "Checkout", url: "https://shop.example/c", fields: [{ name: "zip", label: "ZIP" }] } });
    expect(s.last()).toMatchObject({ replyToId: "u1u", message: { type: "card" } });
    expect(s.bots.require(s.id).store.getKv("lastPreview", "")).toBe("Checkout");
  });
});
