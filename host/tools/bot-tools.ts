import { LIMITS, STR, activityEntryId, isModelId, isPageFormCardArgs, sendEntryId, type ModelId, type SendMessageEntry, type SendMessagePayload } from "@synapse/shared";
import { z } from "zod";
import type { BotService } from "../bots/bot-service";
import type { BotToolDef, BotToolResult } from "../brain/types";
import type { AckLedger } from "../runner/ack-ledger";
import type { CreationLedger } from "../runner/creation-ledger";
import type { SendRouter, StateTargetHandler } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";
import type { BotToolExtensions, SendType, UpdateTarget } from "./registry";
import { avatarAnimTarget } from "./avatar-anim-target";

export interface BotToolDeps {
  botId: string;
  slot(): TurnSlot | null;
  bots: BotService;
  acks: AckLedger;
  creations: CreationLedger;
  now(): number;
  createBot(a: { name: string; description?: string; model?: ModelId }): string;
  /** Phase 3 (SEC-02, SEC-04): handlers for SendMessage types other than text. ctx.deliver is Phase 2's delivery (M8). */
  sendHandlers?: Partial<Record<"secret-request" | "card", (a: Record<string, unknown>, ctx?: SendDeliverCtx) => Promise<BotToolResult>>>;
  ext?: BotToolExtensions;
  /** Phase 4: update_state targets registered on the TurnRunner (RTN-*, GRP-*, control plane, …). */
  stateTargets?: () => Record<string, StateTargetHandler>;
  /** Phase 4: SendMessage routers registered on the TurnRunner (widgets, group posting, …). */
  sendRouters?: () => SendRouter[];
}

/** M8: Phase 2's delivery bookkeeping (entry id, reply_to, typing, noteBotMessage, ack, userSeq) for Phase 3 cards. */
export interface SendDeliverCtx { deliver(message: SendMessagePayload, extra?: Partial<SendMessageEntry>, preview?: string): SendMessageEntry }

const AWAITING = "You're already waiting for the user's answer in this turn, so this message wasn't sent. End the turn now.";
const err = (text: string): BotToolResult => ({ text, isError: true });
export const OWN_DESCRIPTION = "Not saved: you can't change your own description (your standing instructions). Only the user can edit it, in Bot Settings.";

export function createBotTools(d: BotToolDeps): BotToolDef[] {
  // Turn-counter side effects of "something was shown to the user" (sentMessageCount, segment,
  // confirmUserSeq, ackToken.clear, publishTyping, …): OUT-07's discipline (stop-hook nudges, silence
  // reminders) reads these. The SendMessage handler below calls markSent() itself, automatically, once
  // for every non-error SendRouter result (see the routing loop) — a router (Task 6's widget router,
  // Task 37/38's group poster / control plane, …) must NOT also touch these fields; the wrapper already
  // satisfies them exactly like a base deliver() would. Only set state markSent doesn't know about (e.g.
  // widgets.ts sets slot.awaitingUserSelection). (Fix round 1, finding 1: the old runner widget service's
  // post() used to repeat this bookkeeping itself, double-firing it on every widget send — this comment
  // previously read the other way and told router authors to self-manage it, which is what caused that.)
  // Deliberately does NOT call bots.noteBotMessage() (last-bot-message/preview + unread tracking) the
  // way deliver() does below: a routed send isn't necessarily a "message" a preview should reflect, and
  // only the router itself (Task 37's GroupPoster, Task 38's control plane, …) knows whether it is. A
  // router that wants that tracking updated must call bots.noteBotMessage(botId, text) itself. (Fix
  // round 1, finding 2 — flagged for Tasks 37/38 to confirm they account for this asymmetry.)
  const markSent = (slot: TurnSlot): void => {
    slot.partialJson = "";
    slot.sentMessageCount += 1;
    slot.sentTextThisTurn = true;
    slot.toolCallsSinceSend = 0;
    slot.lastSendAt = d.now(); // OUT-05's wall-clock arm times the next progress nudge from here
    slot.earlyResultReminded = false;
    slot.segment += 1;
    if (slot.userSeqMax > 0) d.bots.confirmUserSeq(d.botId, slot.userSeqMax);
    if (slot.ackToken) d.acks.clear(d.botId, slot.ackToken);
    d.bots.publishTyping(d.botId, false, null);
  };
  const deliver = (slot: TurnSlot, message: SendMessagePayload, extra: Partial<SendMessageEntry> = {}, preview?: string): SendMessageEntry => {
    slot.nextSendK += 1;
    const replyTo = (extra.replyToId ?? slot.replyTo) || undefined;
    const entry: SendMessageEntry = {
      kind: "send-message", id: sendEntryId(slot.turnNo, slot.nextSendK), requestId: slot.requestId, createdAt: d.now(), message,
      ...(replyTo ? { replyToId: replyTo, branched: true } : {}), ...extra,
    };
    d.bots.appendEntry(d.botId, entry);
    markSent(slot);
    // A scheduled or triggered run posts quietly unless the Bot said this one is worth a notification.
    d.bots.noteBotMessage(d.botId, preview ?? (message.type === "text" ? message.content : ""), { quiet: slot.context.routineRun !== null && slot.notifyRequested !== true });
    return entry;
  };
  const replyTarget = (a: Record<string, unknown>): { id?: string; error?: string } => {
    if (a.reply_to === undefined) return {};
    const id = String(a.reply_to);
    return d.bots.getEntry(d.botId, id) ? { id } : { error: `reply_to "${id}" is not a message address in this conversation.` };
  };

  const sendMessage: BotToolDef = {
    name: "SendMessage",
    description: 'The ONLY way to reach the user. type "text" (default, Markdown), "attachment" (url: file:///workspace/… or https), "widget" (a question, 1–6 options), "card" (email-draft, form, link, table; a form with url, fillTarget or secret fills a page), "secret-request" (a password or key; you never see it). reply_to threads under a message. end_turn: true on your last message ends your turn.',
    readOnly: false,
    schema: {
      type: z.enum(["text", "attachment", "widget", "secret-request", "card", "coding-agent"]).optional(),
      content: z.string().optional(),
      url: z.string().optional(),
      // No `images`: no SendMessage path ever read it, so it cost ~150 chars
      // on every model call for nothing. Its budget went to `call` (voice wave 3, decisions.md).
      alt: z.string().optional(),
      reply_to: z.string().optional(),
      // Free-form objects are z.looseObject({}), never z.record(): the Agent SDK's bundled JSON-schema
      // driver crashes on zod 4.6's record processor, which fails the "bot" server's whole tools/list and
      // leaves the real CLI with no mcp__bot__* tools at all ("No such tool available", mcpfix).
      widget: z.looseObject({}).optional(),
      secret: z.looseObject({}).optional(),
      card: z.looseObject({}).optional(),
      end_turn: z.boolean().optional(),
      notify: z.boolean().optional(),
    },
    handler: async (a) => {
      const slot = d.slot();
      if (!slot) return err("No active turn.");
      if (slot.awaitingUserSelection) return err(AWAITING);
      slot.notifyRequested = a.notify === true;
      const r = await send(slot, a);
      // Token diet (1): the PostToolBatch hook ends the turn here (onToolBatch), saving the model call
      // that would only have said "Sent.". A failed send never ends a turn.
      if (!r.isError && a.end_turn === true) slot.endTurnRequested = true;
      return r;
    },
  };
  async function send(slot: TurnSlot, a: Record<string, unknown>): Promise<BotToolResult> {
    for (const route of d.sendRouters?.() ?? []) {
      const attempt = route(d.botId, slot, a);
      if (!attempt) continue;
      const routed = await attempt;
      if (!routed.isError) markSent(slot);
      return routed;
    }
    const type = (a.type as string | undefined) ?? "text";
    const rt = replyTarget(a);
    if (rt.error) return err(rt.error);
    if (type !== "text") {
      // Phase 3 handlers own "secret-request" and the SEC-04 page-fill "form" card; Phase 2 owns every other type.
      const p3 = d.sendHandlers?.[type as "secret-request" | "card"];
      const p2 = d.ext?.sendTypes?.[type as SendType];
      if (p3 && (!p2 || type !== "card" || isPageFormCardArgs(a.card))) {
        return p3(a, { deliver: (m, extra, preview) => deliver(slot, m, { ...(rt.id ? { replyToId: rt.id } : {}), ...extra }, preview) });
      }
      if (!p2) return err(`SendMessage type "${type}" isn't available yet. Send plain text instead.`);
      return p2({ botId: d.botId, slot, args: a, now: d.now, deliver: (m, extra, preview) => deliver(slot, m, { ...(rt.id ? { replyToId: rt.id } : {}), ...extra }, preview) });
    }
    const content = String(a.content ?? "").trim();
    if (!content) return err("content is required for a text message.");
    deliver(slot, { type: "text", content }, rt.id ? { replyToId: rt.id } : {});
    return { text: "Message sent." };
  }

  const updateState: BotToolDef = {
    name: "update_state",
    description: 'Edit your profile (profile: name, title = short sidebar label; description is user-only), settings (model), avatar animations (avatar; action "help").',
    readOnly: false,
    schema: {
      target: z.enum(["memory", "routine", "workflow", "profile", "settings", "project", "avatar", "account_settings", "secret", "followup"]),
      action: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      prompt: z.string().optional(),
      schedule: z.string().optional(),
      // Free-form objects are z.looseObject({}), never z.record(): the Agent SDK's bundled JSON-schema
      // driver crashes on zod 4.6's record processor (mcpfix).
      trigger: z.looseObject({}).optional(),
      enabled: z.boolean().optional(),
      model: z.string().optional(),
      voice: z.string().optional(),
      speech_rate: z.number().optional(),
      spoken_language: z.string().optional(),
      pinned: z.boolean().optional(),
      hidden_from_sidebar: z.boolean().optional(),
      notify_on_updates: z.boolean().optional(),
      user_time_zone: z.string().optional(),
      confirm: z.boolean().optional(),
      content: z.string().optional(),
      fact: z.string().optional(),
      tier: z.enum(["profile", "log", "note"]).optional(),
      scope: z.enum(["agent", "user", "team", "project"]).optional(),
      project: z.string().optional(),
      body: z.string().optional(),
      workflow_id: z.string().optional(),
    },
    handler: async (a) => {
      const target = String(a.target);
      const delegated = d.stateTargets?.()[target];
      if (delegated) return delegated(d.botId, d.slot(), a);
      const custom = d.ext?.updateState?.[target as UpdateTarget];
      if (custom) return custom({ botId: d.botId, slot: d.slot(), args: a, now: d.now });
      if (target === "avatar") return avatarAnimTarget(d.bots, d.botId, a);
      if (target === "profile" && a.action === "set") {
        if (a.name !== undefined && !String(a.name).trim()) return err("Not saved — the name can't be blank.");
        // I7 ruling: the description is the Bot's standing instructions; only the user edits it.
        if (a.description !== undefined && String(a.description).trim()) return err(OWN_DESCRIPTION);
        const before = d.bots.summary(d.botId).profile.name;
        const s = d.bots.update(d.botId, { name: a.name as string | undefined, title: a.title as string | undefined });
        if (s.profile.name !== before) {
          const slot = d.slot();
          const turn = slot?.turnNo ?? "b";
          const k = slot ? ++slot.nextActK : 1;
          d.bots.appendEntry(d.botId, { kind: "event", id: activityEntryId(turn, k), createdAt: d.now(), event: { type: "renamed", name: s.profile.name } });
          if (slot) slot.segment += 1;
        }
        return { text: "Updated your profile." };
      }
      if (target === "settings" && a.action === "set") {
        if (a.model !== undefined) {
          if (!isModelId(a.model)) return err(`Not saved — unknown model "${String(a.model)}".`);
          d.bots.update(d.botId, { model: a.model });
        }
        if (a.hidden_from_sidebar !== undefined || a.notify_on_updates !== undefined) return err("Not saved — hiding and notification settings aren't available yet.");
        return { text: "Updated your settings." };
      }
      return err(`Not available yet: update_state target "${target}".`);
    },
  };

  const createAgent: BotToolDef = {
    name: "CreateAgent",
    description: "Create a new Bot with a name and standing instructions. Ask the user before creating several Bots.",
    readOnly: false,
    schema: { name: z.string(), description: z.string().optional(), model: z.string().optional() },
    handler: async (a) => {
      if (d.creations.countSince(d.botId, 3_600_000) >= LIMITS.botCreatedBotsPerHour) return err(STR.botCreateHourCap);
      if (d.creations.countSince(d.botId, 86_400_000) >= LIMITS.botCreatedBotsPerDay) return err(STR.botCreateDayCap);
      const name = String(a.name ?? "").trim();
      if (!name) return err("name is required.");
      const model = isModelId(a.model) ? a.model : undefined;
      let id: string;
      try {
        id = d.createBot({ name, description: a.description as string | undefined, model });
      } catch (e) {
        return err((e as Error).message);
      }
      // The Bot now exists and counts against the cap regardless of anything below.
      d.creations.record(d.botId);
      // Redundant once the real createBot wiring forwards description/model straight into
      // BotService.create — kept so callers (including tests) that only forward `name` to
      // createBot still get them persisted. Intentionally outside the try above: a failure
      // here must not be reported as "creation failed" for a Bot that was already created
      // and already counted against the cap.
      const patch: { description?: string; model?: ModelId } = {};
      if (a.description !== undefined) patch.description = String(a.description);
      if (model !== undefined) patch.model = model;
      if (Object.keys(patch).length) d.bots.update(id, patch);
      return { text: `Created agent "${name}" (id: ${id}). Message it with SendToAgent` };
    },
  };

  const updateAgent: BotToolDef = {
    name: "UpdateAgent",
    description: "Update another Bot's name or description. Empty fields are left unchanged.",
    readOnly: false,
    schema: { agent_id: z.string(), name: z.string().optional(), description: z.string().optional() },
    handler: async (a) => {
      const id = String(a.agent_id);
      if (!d.bots.has(id)) return err(`No Bot with id ${id}.`);
      // I7 ruling: standing instructions stay user-authored; a Bot can't rewrite its own through UpdateAgent.
      if (id === d.botId && a.description && String(a.description).trim()) return err(OWN_DESCRIPTION);
      const patch: { name?: string; description?: string } = {};
      if (a.name && String(a.name).trim()) patch.name = String(a.name);
      if (a.description && String(a.description).trim()) patch.description = String(a.description);
      const s = d.bots.update(id, patch);
      return { text: `Updated agent "${s.profile.name}".` };
    },
  };

  return [sendMessage, updateState, createAgent, updateAgent, ...(d.ext?.extraTools?.(d.botId, d.slot) ?? [])];
}
