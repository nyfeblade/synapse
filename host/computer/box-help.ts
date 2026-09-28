import { randomUUID } from "node:crypto";
import { STRC, sendEntryId, type BoxHelpReason, type BoxHelpView, type SendMessageEntry } from "@synapse/shared";
import { z } from "zod";
import type { BotService } from "../bots/bot-service";
import type { BotToolDef, BotToolResult } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import type { SseHub } from "../gateway/sse-hub";
import { fillTemplate, loadPrompt } from "../prompts";
import type { AckLedger } from "../runner/ack-ledger";
import type { HiddenSpec } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";

export interface BoxHelpDeps {
  bots: BotService; acks: AckLedger; hub: SseHub;
  capture(botId: string): Promise<string | null>;
  slot(botId: string): TurnSlot | null;
  enqueueHidden(botId: string, spec: HiddenSpec): void;
  now(): number;
}
interface Stored { view: BoxHelpView; entryId: string }
const KV = "boxHelp";

export class BoxHelpService {
  constructor(private d: BoxHelpDeps) {}

  pending(botId: string): BoxHelpView | null {
    return this.d.bots.require(botId).store.getKv<Stored | null>(KV, null)?.view ?? null;
  }

  private save(botId: string, s: Stored): void {
    this.d.bots.require(botId).store.setKv(KV, s);
    const e = this.d.bots.getEntry(botId, s.entryId) as SendMessageEntry | null;
    if (e) this.d.bots.updateEntry(botId, { ...e, message: { type: "box-help", request: s.view } });
    this.d.hub.publish({ channel: "box-help", payload: { request: s.view } });
  }

  async request(botId: string, a: { instruction: string; reason: BoxHelpReason; domain?: string; idp_domain?: string }): Promise<BotToolResult> {
    if (this.pending(botId)) return { text: STRC.boxHelpDuplicate };
    const instruction = String(a.instruction).replace(/\s+/g, " ").trim().slice(0, 300);
    if (!instruction) return { text: "instruction is required: one line telling the user what to do on the computer.", isError: true };
    const slot = this.d.slot(botId);
    const t = this.d.now();
    const view: BoxHelpView = {
      id: `bh_${randomUUID().slice(0, 8)}`, botId, instruction, reason: a.reason, domain: a.domain ?? null, idpDomain: a.idp_domain ?? null,
      screenshotDataUrl: await this.d.capture(botId).catch(() => null), status: "pending", inControl: false, createdAt: t, settledAt: null,
    };
    const turn = slot?.turnNo ?? this.d.bots.nextTurnNo(botId);
    const k = slot ? ++slot.nextSendK : 1;
    const entry: SendMessageEntry = { kind: "send-message", id: sendEntryId(turn, k), requestId: slot?.requestId ?? "", createdAt: t, message: { type: "box-help", request: view } };
    this.d.bots.appendEntry(botId, entry);
    this.save(botId, { view, entryId: entry.id });
    this.d.bots.setAwaiting(botId, { tabId: "box", reason: instruction, since: t });
    if (slot) {
      slot.awaitingUserSelection = true; // OUT-06: the runner interrupts right after this tool returns
      slot.sentMessageCount += 1;
      slot.segment += 1;
      if (slot.userSeqMax > 0) this.d.bots.confirmUserSeq(botId, slot.userSeqMax);
      if (slot.ackToken) this.d.acks.clear(botId, slot.ackToken);
    }
    return { text: STRC.boxHelpSent };
  }

  setInControl(botId: string, requestId: string, active: boolean): BoxHelpView {
    const s = this.current(botId, requestId);
    s.view = { ...s.view, inControl: active };
    this.save(botId, s);
    return s.view;
  }

  handBack(botId: string, requestId: string, outcome: "done" | "skip" | "viewer_closed"): BoxHelpView {
    const s = this.current(botId, requestId);
    const status = outcome === "done" ? "handed_back" : outcome === "skip" ? "dismissed" : "viewer_closed";
    s.view = { ...s.view, status, inControl: false, settledAt: this.d.now() };
    this.save(botId, s);
    this.d.bots.require(botId).store.deleteKv(KV);
    this.d.bots.setAwaiting(botId, null);
    const file = outcome === "done" ? "wakes/box-handback.md" : outcome === "skip" ? "wakes/box-dismissed.md" : "wakes/box-viewer-closed.md";
    this.d.acks.record(botId);
    this.d.enqueueHidden(botId, {
      source: "box-handback", lane: "background", silenceAllowed: false, ackToken: this.d.acks.token(botId),
      text: fillTemplate(loadPrompt(file), { INSTRUCTION: s.view.instruction }),
    });
    return s.view;
  }

  private current(botId: string, requestId: string): Stored {
    const s = this.d.bots.require(botId).store.getKv<Stored | null>(KV, null);
    if (!s || s.view.id !== requestId || s.view.status !== "pending") throw new GatewayError("STALE_BOX_HELP", "This request was already answered.", 409);
    return s;
  }
}

/** CMP-08: the only way a Bot hands a step (sign-in, CAPTCHA, payment) to the user. */
export function createBoxHelpTool(o: { botId: string; service: BoxHelpService }): BotToolDef {
  return {
    name: "request_box_help",
    description: "Ask the user to take over your screen for one step you must not or cannot do (sign-in, 2FA, CAPTCHA, payment). One line of instruction. This ends your turn; you'll be woken when they hand the computer back.",
    readOnly: false,
    schema: { instruction: z.string(), reason: z.enum(["auth", "captcha", "payment", "other"]), domain: z.string().optional(), idp_domain: z.string().optional() },
    handler: (a) => o.service.request(o.botId, a as { instruction: string; reason: BoxHelpReason; domain?: string; idp_domain?: string }),
  };
}
