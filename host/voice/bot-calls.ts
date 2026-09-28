import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BOT_CALL_LIMITS, CALL_FEEL, STRV, type BotCallAnswer, type BotCallsView, type BotSettings, type BotSummary, type IncomingCallView, type TranscriptEntry } from "@synapse/shared";
import type { BotToolDef, BotToolResult } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import type { SseHub } from "../gateway/sse-hub";
import type { HostModule } from "../phase5/types";

/** What the service needs from BotService (tests pass a stand-in). */
export interface CallingBots {
  has(id: string): boolean;
  summary(id: string): Pick<BotSummary, "profile" | "settings">;
  updateSettings(id: string, p: Partial<BotSettings>): unknown;
  auxEntryIds(id: string, n: number): string[];
  appendEntry(id: string, e: TranscriptEntry): void;
}

interface Ring extends IncomingCallView { timer: NodeJS.Timeout }

/**
 * A Bot calls the user (SendMessage `call`). The host owns the ring: the per-Bot permission (never
 * asked = the ring asks; accepting allows future calls; "don't allow" blocks), one ring per Bot, a
 * 30 s ring, and at most 3 placed an hour across all Bots. The Mac decides whether to show it
 * (quiet hours, Focus) and answers; anything but a pick-up leaves "Missed call from <Bot>: <reason>"
 * in the chat. Nothing here wakes the Bot: its reason is already its own message in the chat.
 */
export class BotCallService {
  private rings = new Map<string, Ring>();
  private placed: number[] = [];

  constructor(private d: { bots: CallingBots; hub: Pick<SseHub, "publish">; now(): number; ringMs?: number }) {}

  view(): BotCallsView {
    return { calls: [...this.rings.values()].map(({ timer: _t, ...v }) => v) };
  }

  private publish(): void {
    this.d.hub.publish({ channel: "bot-calls", payload: this.view() });
  }

  private name(botId: string): string {
    return this.d.bots.has(botId) ? this.d.bots.summary(botId).profile.name : botId;
  }

  private notice(botId: string, text: string, voicemail?: { text: string }): void {
    if (!this.d.bots.has(botId)) return;
    const [id] = this.d.bots.auxEntryIds(botId, 1);
    this.d.bots.appendEntry(botId, { kind: "notice", id: id!, text, createdAt: this.d.now(), ...(voicemail ? { voicemail } : {}) });
  }

  request(botId: string, rawReason: string): { placed: boolean; note: string } {
    if (!this.d.bots.has(botId)) return { placed: false, note: "Not placed: this Bot no longer exists." };
    const reason = rawReason.replace(/\s+/g, " ").trim().slice(0, BOT_CALL_LIMITS.reasonMax);
    const mayCall = this.d.bots.summary(botId).settings.mayCall;
    if (mayCall === false) return { placed: false, note: "Not placed: the user has turned off calls from you." };
    if ([...this.rings.values()].some((r) => r.botId === botId)) return { placed: false, note: "Not placed: you are already ringing the user." };
    const now = this.d.now();
    this.placed = this.placed.filter((t) => now - t < 60 * 60_000);
    if (this.placed.length >= BOT_CALL_LIMITS.perHour) {
      this.notice(botId, STRV.missedCall(this.name(botId), reason, STRV.callRateLimited));
      return { placed: false, note: "Not placed: the limit is 3 calls an hour." };
    }
    this.placed.push(now);
    const ringMs = this.d.ringMs ?? BOT_CALL_LIMITS.ringMs;
    const callId = `ring-${randomUUID()}`;
    const timer = setTimeout(() => { if (this.rings.has(callId)) this.answer(callId, "missed"); }, ringMs);
    timer.unref?.();
    this.rings.set(callId, { callId, botId, reason, since: now, expiresAt: now + ringMs, firstCall: mayCall !== true, timer });
    this.publish();
    return { placed: true, note: "Ringing the user. If they pick up, the call opens with your reason; if not, it shows as a missed call." };
  }

  answer(callId: string, answer: BotCallAnswer, o: { allow?: boolean; why?: string } = {}): { botId: string; reason: string } {
    const r = this.rings.get(callId);
    if (!r) throw new GatewayError("NOT_FOUND", "That call has ended.", 404);
    clearTimeout(r.timer);
    this.rings.delete(callId);
    const name = this.name(r.botId);
    if (this.d.bots.has(r.botId)) {
      if (o.allow === false) this.d.bots.updateSettings(r.botId, { mayCall: false });
      else if (answer === "accept" && r.firstCall) this.d.bots.updateSettings(r.botId, { mayCall: true });
    }
    const why = typeof o.why === "string" ? o.why.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    // Bug 134 (item 11): a declined or missed call leaves a voicemail. Its words are built here from the
    // Bot's own reason (no model call); the Mac renders the audio in the Bot's voice and keeps it 30 days.
    if (answer === "decline" || answer === "missed") {
      const text = STRV.voicemailText(null, name, r.reason).slice(0, CALL_FEEL.voicemailMaxChars);
      this.notice(r.botId, STRV.missedCall(name, r.reason, why || undefined), { text });
    }
    else if (answer === "message") this.notice(r.botId, STRV.callByMessage(name, r.reason));
    this.publish();
    return { botId: r.botId, reason: r.reason };
  }

  /** A Bot was deleted: its ring goes too. */
  forget(botId: string): void {
    let changed = false;
    for (const [id, r] of this.rings) if (r.botId === botId) { clearTimeout(r.timer); this.rings.delete(id); changed = true; }
    if (changed) this.publish();
  }

  stop(): void {
    for (const r of this.rings.values()) clearTimeout(r.timer);
    this.rings.clear();
  }
}

/** The extension of the existing SendMessage tool (a new tool would cost a slot under the 28-tool ceiling). */
export const CALL_PARAM_DESCRIPTION = ' call: "why" rings the user (task done, or decision needed); on a call, "look" sees their screen, "drop <Bot>" takes that Bot off.';

export function createBotCallsModule(
  ctx: { bots: CallingBots; hub: Pick<SseHub, "publish">; now(): number },
  o: { onLook?(botId: string): boolean; onDrop?(botId: string, name: string): { text: string; isError?: boolean } } = {},
): HostModule & { service: BotCallService } {
  const service = new BotCallService({ bots: ctx.bots, hub: ctx.hub, now: ctx.now });
  const ANSWERS: BotCallAnswer[] = ["accept", "decline", "message", "missed"];
  return {
    name: "bot-calls",
    service,
    handlers: {
      listBotCalls: () => service.view(),
      answerBotCall: (a) => {
        if (typeof a?.callId !== "string" || !ANSWERS.includes(a.answer)) throw new GatewayError("BAD_ARGS", "Unknown call answer.");
        if (a.allow !== undefined && typeof a.allow !== "boolean") throw new GatewayError("BAD_ARGS", "Bad allow.");
        return service.answer(a.callId, a.answer, { allow: a.allow, why: typeof a.why === "string" ? a.why : undefined });
      },
      setBotCallPermission: (a) => {
        if (!ctx.bots.has(a?.id)) throw new GatewayError("NOT_FOUND", "That Bot doesn't exist.", 404);
        if (a.mayCall !== null && typeof a.mayCall !== "boolean") throw new GatewayError("BAD_ARGS", "Bad permission.");
        ctx.bots.updateSettings(a.id, { mayCall: a.mayCall });
        return {};
      },
    },
    botTools: (botId, _slot, base) => {
      const send = base?.find((t) => t.name === "SendMessage");
      if (!send) return [];
      const wrapped: BotToolDef = {
        ...send,
        description: `${send.description}${CALL_PARAM_DESCRIPTION}`,
        schema: { ...send.schema, call: z.string().optional() },
        handler: async (a): Promise<BotToolResult> => {
          const call = typeof a.call === "string" ? a.call.trim() : "";
          if (!call) return send.handler(a);
          // Bug 158: "drop Otto" — the user asked a Bot ON the call to take another Bot off it. The
          // host decides whether it may (host/voice/calls.ts): its own call only, never the call's own
          // Bot, never the user. No message of its own unless the Bot wrote one.
          const drop = /^(?:drop|remove|hang up on)\b\s*(.*)$/i.exec(call);
          if (drop) {
            const r = o.onDrop?.(botId, drop[1] ?? "") ?? { text: "Calls can't change on this host.", isError: true };
            const hasContent = typeof a.content === "string" && a.content.trim() !== "";
            if (!hasContent || r.isError) return r;
            const sent = await send.handler(a);
            return sent.isError ? sent : { text: `${sent.text} ${r.text}`.trim() };
          }
          if (call.toLowerCase() === "look") {
            const asked = o.onLook?.(botId) ?? false;
            const hasContent = typeof a.content === "string" && a.content.trim() !== "";
            const r = hasContent ? await send.handler(a) : { text: "" };
            if (r.isError) return r;
            return { text: `${r.text ? `${r.text} ` : ""}${asked ? "Asked: if the user is sharing their screen, a snapshot arrives as their next message." : "Not on a 1:1 call; nothing to look at."}`.trim() };
          }
          // No message of its own: the reason is the message (it stays in the chat whatever happens to the ring).
          const args = typeof a.content === "string" && a.content.trim() ? a : { ...a, content: call };
          const r = await send.handler(args);
          if (r.isError) return r;
          const placed = service.request(botId, call);
          return { text: `${r.text} ${placed.note}` };
        },
      };
      return [wrapped];
    },
    stop: () => service.stop(),
  };
}
