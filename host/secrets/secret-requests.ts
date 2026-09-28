import path from "node:path";
import { LIMITSC, isPageFormCard, sendEntryId, type FormCardView, type PageFormField as FormField, type SecretRequestView, type SendMessageEntry } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import type { BotToolResult } from "../brain/types";
import type { BrowserHub } from "../computer/browser/hub";
import { GatewayError } from "../gateway/errors";
import { fillTemplate, loadPrompt } from "../prompts";
import type { AckLedger } from "../runner/ack-ledger";
import type { HiddenSpec } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";
import { readJson, writeJsonAtomic } from "../util/atomic-json";
import type { SendDeliverCtx } from "../tools/bot-tools";
import { validateSecretName, type SecretVault } from "./vault";

export interface SecretRequestDeps {
  bots: BotService; acks: AckLedger; vault: Pick<SecretVault, "open" | "apply">;
  fill(botId: string, target: { ref?: string; selector?: string }, url: string | null, value: string): Promise<boolean>;
  slot(botId: string): TurnSlot | null; enqueueHidden(botId: string, spec: HiddenSpec): void; connectorDir: string; now(): number;
}
const err = (text: string): BotToolResult => ({ text, isError: true });
const sameDoc = (a: string, b: string) => { try { const x = new URL(a); const y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch { return false; } };

/** SEC-03: focus the referenced input and insert the value through CDP after checking the page is still the one asked about. */
export async function fillIntoPage(o: { hub: BrowserHub; botId: string; viewId: string; target: { ref?: string; selector?: string }; url: string | null; value: string }): Promise<boolean> {
  try {
    const tab = await o.hub.tab(o.botId, o.viewId);
    if (o.url && !sameDoc(o.url, tab.page.url())) return false;
    let backendNodeId: number | null = o.target.ref ? o.hub.ref(o.viewId, o.target.ref) : null;
    if (backendNodeId === null && o.target.selector) {
      const { root } = await tab.page.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
      const { nodeId } = await tab.page.send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector: o.target.selector });
      if (!nodeId) return false;
      backendNodeId = (await tab.page.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId })).node.backendNodeId;
    }
    if (backendNodeId === null) return false;
    await tab.page.send("DOM.focus", { backendNodeId });
    const { object } = await tab.page.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId });
    await tab.page.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { if (this.select) this.select(); }" });
    await tab.page.send("Input.insertText", { text: o.value });
    return true;
  } catch {
    return false;
  }
}

export class SecretRequestService {
  constructor(private d: SecretRequestDeps) {}

  /** M8: through Phase 2's deliver when SendMessage passes it (reply_to, typing, preview, acks); the card ends the turn. */
  private post(botId: string, message: SendMessageEntry["message"], preview: string, ctx?: SendDeliverCtx, extra: Partial<SendMessageEntry> = {}): SendMessageEntry {
    const slot = this.d.slot(botId);
    if (ctx && slot) {
      const e = ctx.deliver(message, extra, preview);
      slot.awaitingUserSelection = true; // OUT-06: the card ends the turn
      return e;
    }
    const turn = slot?.turnNo ?? this.d.bots.nextTurnNo(botId);
    const k = slot ? ++slot.nextSendK : 1;
    const e: SendMessageEntry = { kind: "send-message", id: sendEntryId(turn, k), requestId: slot?.requestId ?? "", createdAt: this.d.now(), message, ...extra };
    this.d.bots.appendEntry(botId, e);
    this.d.bots.publishTyping(botId, false, null);
    this.d.bots.noteBotMessage(botId, preview);
    if (slot) {
      slot.awaitingUserSelection = true; // OUT-06: the card ends the turn
      slot.sentMessageCount += 1;
      slot.segment += 1;
      if (slot.userSeqMax > 0) this.d.bots.confirmUserSeq(botId, slot.userSeqMax);
      if (slot.ackToken) this.d.acks.clear(botId, slot.ackToken);
    }
    return e;
  }

  async sendSecretRequest(botId: string, a: Record<string, unknown>, ctx?: SendDeliverCtx): Promise<BotToolResult> {
    const s = (a.secret ?? {}) as Record<string, string | undefined>;
    const label = String(s.label ?? "").trim();
    const description = String(s.description ?? "").trim();
    if (!label || label.length > LIMITSC.secretLabelMax) return err("secret.label is required (at most 120 characters).");
    if (description.length > LIMITSC.secretDescriptionMax) return err("secret.description can be at most 400 characters.");
    const target = s.ref || s.selector ? { ...(s.ref ? { ref: s.ref } : {}), ...(s.selector ? { selector: s.selector } : {}) } : null;
    const destination = s.target === "page" || target ? "page" : s.connector ? "connector" : "env";
    if (destination === "env") {
      const bad = validateSecretName(String(s.field ?? ""));
      if (bad) return err(bad);
    }
    if (destination === "page" && !target) return err("A page secret needs secret.ref (from browser_snapshot) or secret.selector.");
    const view: SecretRequestView = { label, description, destination, field: s.field ?? null, connector: s.connector ?? null, url: s.url ?? null, target, status: "pending" };
    this.post(botId, { type: "secret-request", secret: view }, label, ctx);
    this.d.bots.setAwaiting(botId, { tabId: "secret", reason: label, since: this.d.now() });
    return { text: `Asked the user for “${label}”. End your turn now; you'll be woken when they save it.` };
  }

  private pendingEntry<T extends "secret-request" | "card">(botId: string, entryId: string, type: T): SendMessageEntry {
    const e = this.d.bots.getEntry(botId, entryId) as SendMessageEntry | null;
    const status = e?.message.type === "secret-request" ? e.message.secret.status : e?.message.type === "card" && isPageFormCard(e.message.card) ? e.message.card.status : null;
    if (!e || e.message.type !== type || status !== "pending") throw new GatewayError("STALE_REQUEST", "This request was already answered.", 409);
    return e;
  }

  async submitSecret(botId: string, entryId: string, sealed: string, valueHash: string): Promise<SecretRequestView["status"]> {
    const e = this.pendingEntry(botId, entryId, "secret-request");
    const view = (e.message as { secret: SecretRequestView }).secret;
    let status: SecretRequestView["status"];
    let where: string;
    try {
      if (view.destination === "env") {
        await this.d.vault.apply(botId, [{ name: view.field as string, description: view.label, sealed, valueHash }], []);
        status = "saved";
        where = `It's available to your shell as $${view.field}.`;
      } else if (view.destination === "connector") {
        const value = await this.d.vault.open(sealed);
        const dir = path.join(this.d.connectorDir, botId);
        const file = path.join(dir, `${(view.connector as string).replace(/[^a-z0-9_-]/gi, "_")}.json`);
        const cur = readJson<Record<string, string>>(file, {});
        writeJsonAtomic(file, { ...cur, [view.field ?? "value"]: value }, 0o600);
        status = "saved";
        where = `It was saved for the ${view.connector} connector.`;
      } else {
        const ok = await this.d.fill(botId, view.target ?? {}, view.url, await this.d.vault.open(sealed));
        status = ok ? "filled" : "fill_failed";
        where = "It was filled into the page.";
      }
    } catch {
      return "failed"; // the card stays pending; the UI shows "Couldn't save the secret. Please try again."
    }
    this.d.bots.updateEntry(botId, { ...e, message: { type: "secret-request", secret: { ...view, status } } });
    this.d.bots.setAwaiting(botId, null);
    this.d.acks.record(botId);
    this.d.enqueueHidden(botId, {
      source: "secret-provided", lane: "background", silenceAllowed: false, ackToken: this.d.acks.token(botId),
      text: status === "fill_failed"
        ? `[The user provided “${view.label}”, but it could not be filled into the page (the page changed or the field wasn't found). Take a fresh browser snapshot, then send the secret request again for the right field.]`
        : fillTemplate(loadPrompt("wakes/secret-provided.md"), { LABEL: view.label, WHERE: where }).trimEnd(),
    });
    return status;
  }

  async sendForm(botId: string, a: Record<string, unknown>, ctx?: SendDeliverCtx): Promise<BotToolResult> {
    const c = (a.card ?? {}) as { kind?: string; title?: string; url?: string; fields?: Partial<FormField>[] };
    if (c.kind !== "form") return err(`card.kind "${String(c.kind)}" isn't available. Use kind "form".`);
    const fields: FormField[] = (c.fields ?? []).map((f) => {
      // M8: a password field is always a hidden, page-filled secret field.
      const password = f.type === "password" || (f as { kind?: unknown }).kind === "password";
      return {
        name: String(f.name ?? ""), label: String(f.label ?? f.name ?? ""), type: (password || f.secret ? "password" : f.type ?? "text") as FormField["type"],
        secret: Boolean(f.secret) || password, required: f.required !== false, fillTarget: f.fillTarget ?? null,
      };
    });
    if (!c.title || !fields.length || fields.some((f) => !f.name)) return err("A form needs a title and at least one field with a name.");
    if ((c.fields ?? []).some((f) => !f.secret && (f.type === "password" || (f as { kind?: unknown }).kind === "password") && !f.fillTarget)) return err('Password fields are typed into a web page and need a fillTarget (ref or selector). To get a password or key for yourself, use SendMessage type "secret-request".');
    if (fields.some((f) => f.secret && !f.fillTarget)) return err("Secret fields need a fillTarget (ref or selector) so the app can fill them for you.");
    const card: FormCardView = { kind: "form", title: c.title, url: c.url ?? null, fields, status: "pending", answeredFields: [] };
    this.post(botId, { type: "card", card }, c.title, ctx, { status: "pending" }); // M8: an entry status keeps Phase 2's awaiting flag
    this.d.bots.setAwaiting(botId, { tabId: "widget", reason: c.title, since: this.d.now() });
    return { text: `Showed the form “${c.title}”. End your turn now; you'll be woken with the answers.` };
  }

  async submitForm(botId: string, entryId: string, answers: Record<string, string>, sealed: Record<string, string>): Promise<FormCardView["status"]> {
    const e = this.pendingEntry(botId, entryId, "card");
    const card = (e.message as { card: FormCardView }).card;
    const lines: string[] = [];
    let failed = false;
    for (const f of card.fields) {
      const value = f.secret ? (sealed[f.name] ? await this.d.vault.open(sealed[f.name] as string) : "") : answers[f.name] ?? "";
      if (f.fillTarget && value) {
        const ok = await this.d.fill(botId, f.fillTarget, card.url, value);
        failed ||= !ok;
        if (f.secret) lines.push(`${f.label}: ${ok ? "filled into the page (hidden from you)" : "could not be filled into the page"}`);
      }
      if (!f.secret) lines.push(`${f.label}: ${value || "(left empty)"}`);
    }
    const status: FormCardView["status"] = failed ? "fill_failed" : "submitted";
    this.d.bots.updateEntry(botId, { ...e, status: "answered", message: { type: "card", card: { ...card, status, answeredFields: card.fields.map((f) => f.name) } } });
    this.d.bots.setAwaiting(botId, null);
    this.d.acks.record(botId);
    this.d.enqueueHidden(botId, {
      source: "form-answer", lane: "user", silenceAllowed: false, ackToken: this.d.acks.token(botId),
      text: fillTemplate(loadPrompt("wakes/form-answer.md"), { TITLE: card.title, ANSWERS: lines.join("\n") }).trimEnd(),
    });
    return status;
  }
}
