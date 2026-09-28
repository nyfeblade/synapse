import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SendMessageEntry } from "@synapse/shared";
import { BotService } from "../../bots/bot-service";
import { SseHub } from "../../gateway/sse-hub";
import { AckLedger } from "../../runner/ack-ledger";
import { newSlot } from "../../runner/turn-slot";
import type { HiddenSpec } from "../../runner/turn-runner";
import { sealTo } from "../../secrets/crypto";
import { SecretRequestService } from "../../secrets/secret-requests";
import { SecretVault } from "../../secrets/vault";
import { HostSettingsStore } from "../../store/host-settings";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

async function setup(fillOk = true) {
  const cfg = tmpConfig();
  initLayout(cfg);
  const bots = new BotService({ cfg, hub: new SseHub(), settings: new HostSettingsStore(path.join(cfg.dataRoot, "settings.json")) });
  const acks = new AckLedger(path.join(cfg.hostPrivate, "ack-obligations.json"));
  const vault = await SecretVault.open({ hostPrivate: cfg.hostPrivate });
  const id = bots.create({ origin: "user", kickstart: false, name: "Ledger" });
  const slot = newSlot({ botId: id, requestId: "req_1", turnNo: 5, lane: "user", source: "user", hidden: false, silenceAllowed: false, userSeqMax: 1, ackToken: null, userMessageEpoch: 1, startedAt: 1 });
  const fills: { target: unknown; url: string | null; value: string }[] = [];
  const wakes: HiddenSpec[] = [];
  const svc = new SecretRequestService({
    bots, acks, vault, slot: () => slot, enqueueHidden: (_b, s) => wakes.push(s), connectorDir: path.join(cfg.hostPrivate, "connector-secrets"), now: () => 9,
    fill: async (_b, target, url, value) => { fills.push({ target, url, value }); return fillOk; },
  });
  const entry = () => bots.tail(id, 10).filter((e): e is SendMessageEntry => e.kind === "send-message").at(-1)!;
  return { cfg, bots, vault, id, slot, svc, fills, wakes, entry };
}

describe("secret-request card (SEC-02)", () => {
  it("posts the card, ends the turn, and on Save stores an env secret and wakes the Bot (#15) without the value", async () => {
    const s = await setup();
    const r = await s.svc.sendSecretRequest(s.id, { type: "secret-request", secret: { label: "Stripe test key", description: "For the demo app", field: "STRIPE_KEY" } });
    expect(r.text).toBe("Asked the user for “Stripe test key”. End your turn now; you'll be woken when they save it.");
    expect(s.slot.awaitingUserSelection).toBe(true);
    const e = s.entry();
    expect(e.message).toEqual({ type: "secret-request", secret: { label: "Stripe test key", description: "For the demo app", destination: "env", field: "STRIPE_KEY", connector: null, url: null, target: null, status: "pending" } });
    expect(s.bots.summary(s.id).awaiting?.tabId).toBe("secret");
    const status = await s.svc.submitSecret(s.id, e.id, await sealTo(s.vault.publicKey, "sk_test_123456"), "hash-1");
    expect(status).toBe("saved");
    expect(s.vault.env(s.id)).toEqual({ STRIPE_KEY: "sk_test_123456" });
    expect(s.wakes[0]).toMatchObject({ source: "secret-provided", lane: "background", silenceAllowed: false });
    expect(s.wakes[0]!.text).toBe("[The user has securely supplied the secret you asked for: “Stripe test key”. It's available to your shell as $STRIPE_KEY. The value is never shown to you.] Let the user know in one short SendMessage, then carry on.");
    expect(JSON.stringify(s.bots.tail(s.id, 50))).not.toContain("sk_test_123456");
    expect(s.bots.summary(s.id).awaiting).toBeNull();
  });

  it("validates label, description and field, and rejects a second submit", async () => {
    const s = await setup();
    expect((await s.svc.sendSecretRequest(s.id, { secret: { label: "x".repeat(121), field: "A" } })).isError).toBe(true);
    expect((await s.svc.sendSecretRequest(s.id, { secret: { label: "Key", field: "PATH" } })).text).toBe("PATH is reserved.");
    // Security fix I3: the store-time denylist covers git, shell-startup, runtime and proxy names.
    expect((await s.svc.sendSecretRequest(s.id, { secret: { label: "Key", field: "GIT_EXTERNAL_DIFF" } })).text).toBe("Names starting with GIT_ are reserved.");
    expect((await s.svc.sendSecretRequest(s.id, { secret: { label: "Key", field: "BASH_ENV" } })).text).toBe("BASH_ENV is reserved.");
    expect((await s.svc.sendSecretRequest(s.id, { secret: { label: "Key", field: "NODE_OPTIONS" } })).text).toBe("Names starting with NODE_ are reserved.");
    expect((await s.svc.sendSecretRequest(s.id, { secret: { label: "Key", field: "https_proxy" } })).isError).toBe(true);
    await s.svc.sendSecretRequest(s.id, { secret: { label: "Key", field: "API_KEY" } });
    const e = s.entry();
    await s.svc.submitSecret(s.id, e.id, await sealTo(s.vault.publicKey, "abcd1234"), "h");
    await expect(s.svc.submitSecret(s.id, e.id, await sealTo(s.vault.publicKey, "abcd1234"), "h")).rejects.toThrow(/already answered/);
  });

  it("page destination fills through the browser and never stores the value (SEC-03)", async () => {
    const s = await setup();
    await s.svc.sendSecretRequest(s.id, { secret: { label: "Northwind password", target: "page", ref: "e7", url: "https://northwind-air.example/signin" } });
    const e = s.entry();
    expect(await s.svc.submitSecret(s.id, e.id, await sealTo(s.vault.publicKey, "hunter2hunter2"), "h")).toBe("filled");
    expect(s.fills).toEqual([{ target: { ref: "e7" }, url: "https://northwind-air.example/signin", value: "hunter2hunter2" }]);
    expect(s.vault.env(s.id)).toEqual({});
    expect((s.entry().message as { secret: { status: string } }).secret.status).toBe("filled");
  });

  it("a failed fill is reported to the Bot as a failure, not a success", async () => {
    const s = await setup(false);
    await s.svc.sendSecretRequest(s.id, { secret: { label: "PIN", target: "page", selector: "#pin", url: "https://bank.example/" } });
    expect(await s.svc.submitSecret(s.id, s.entry().id, await sealTo(s.vault.publicKey, "9876"), "h")).toBe("fill_failed");
    expect(s.wakes[0]!.text).toMatch(/could not be filled into the page/);
  });

  it("connector destination writes the host-private credential file (0600)", async () => {
    const s = await setup();
    await s.svc.sendSecretRequest(s.id, { secret: { label: "Linear API key", connector: "linear", field: "api_key" } });
    await s.svc.submitSecret(s.id, s.entry().id, await sealTo(s.vault.publicKey, "lin_api_123"), "h");
    const f = path.join(s.cfg.hostPrivate, "connector-secrets", s.id, "linear.json");
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toEqual({ api_key: "lin_api_123" });
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe("forms (SEC-04)", () => {
  it("returns non-secret answers to the Bot and fills secret fields without returning them", async () => {
    const s = await setup();
    const r = await s.svc.sendForm(s.id, { type: "card", card: { kind: "form", title: "Checkout address", url: "https://shop.example/checkout", fields: [
      { name: "street", label: "Street", fillTarget: { ref: "e3" } },
      { name: "card", label: "Card number", secret: true, fillTarget: { ref: "e9" } },
    ] } });
    expect(r.text).toBe("Showed the form “Checkout address”. End your turn now; you'll be woken with the answers.");
    const status = await s.svc.submitForm(s.id, s.entry().id, { street: "1 Main St" }, { card: await sealTo(s.vault.publicKey, "4242424242424242") });
    expect(status).toBe("submitted");
    expect(s.fills.map((f) => f.value)).toEqual(["1 Main St", "4242424242424242"]);
    expect(s.wakes[0]).toMatchObject({ source: "form-answer", lane: "user", silenceAllowed: false });
    expect(s.wakes[0]!.text).toContain("Street: 1 Main St");
    expect(s.wakes[0]!.text).toContain("Card number: filled into the page (hidden from you)");
    expect(s.wakes[0]!.text).not.toContain("4242");
  });
});
