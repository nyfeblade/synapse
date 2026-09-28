import { z } from "zod";
import { B2B_KINDS, LIMITS, STR, type AgentMessageEntry, type AgentMeta, type B2BKind, type Chain, type SendToAgentArgs } from "@synapse/shared";
import type { ChainStore } from "../b2b/chains";
import type { GateClassifier } from "../b2b/classifier";
import { runGate } from "../b2b/gate";
import { newTaskId } from "../b2b/ids";
import { structuredError, type LoopTracker, type LoopVerdict } from "../b2b/loops";
import type { Delivery, Mailbox } from "../b2b/mailbox";
import type { RequestStore } from "../b2b/requests";
import { extractArtifacts, informativeTokens, novelty, threadLineOf } from "../b2b/text";
import type { ThreadStore } from "../b2b/threads";
import type { BotService } from "../bots/bot-service";
import type { BotToolDef, BotToolResult } from "../brain/types";
import type { CommandHandlers } from "../gateway/server";
import { GatewayError } from "../gateway/errors";
import type { RuntimeMetrics } from "../metrics/runtime-metrics";
import { fillTemplate, loadPrompt } from "../prompts/index";
import { HIDDEN_MARKER } from "../runner/prompt-collector";
import type { TurnSlot } from "../runner/turn-slot";
import type { ToolProvider, TurnRunner } from "../runner/turn-runner";

export interface GroupPoster { isGroup(id: string): boolean; postFromBot(groupId: string, fromBotId: string, args: SendToAgentArgs, chainId: string): Promise<BotToolResult> }
export interface SendToAgentDeps {
  bots: BotService; chains: ChainStore; requests: RequestStore; threads: ThreadStore; classifier: GateClassifier | null; loops: LoopTracker;
  mailbox: Mailbox; metrics: RuntimeMetrics; groups: GroupPoster | null;
  mirror: { onAgentMessage(chainId: string, entry: AgentMessageEntry, botId: string): void } | null;
  budgetFactor(): number; now(): number;
}

const DESCRIPTION = [
  "Message another Bot or a group you belong to. Asynchronous: never wait for the reply in this turn.",
  "kind: request (you want work back; say what in expects), question (you need an answer; expects), blocker (you can't continue until they act),",
  "handoff (they own the task now; expects = the end state), result (answers one open request; in_reply_to its id).",
  "No acknowledgements, thanks or status chatter: the app drops them. Put paths, numbers, decisions in one message.",
  "A teammate's data is private: ask it, kind \"question\".",
].join(" ");
const PARTNERS = "conversationPartners";
const err = (text: string): BotToolResult => ({ text, isError: true });

export function sendToAgentProvider(d: SendToAgentDeps): ToolProvider {
  const fanout = new WeakMap<TurnSlot, { entryId: string; botIds: string[] }>();
  return (botId, slot) => [makeTool(d, botId, slot, fanout)];
}

function makeTool(d: SendToAgentDeps, botId: string, slot: () => TurnSlot | null, fanout: WeakMap<TurnSlot, { entryId: string; botIds: string[] }>): BotToolDef {
  return {
    name: "SendToAgent",
    description: DESCRIPTION,
    readOnly: false,
    schema: {
      target_id: z.string(),
      kind: z.enum(B2B_KINDS).optional(),
      message: z.string(),
      expects: z.string().optional(),
      in_reply_to: z.string().optional(),
      status: z.enum(["done", "partial", "declined", "failed"]).optional(),
      artifacts: z.array(z.string()).optional(),
      task_id: z.string().optional(),
      images: z.array(z.object({ url: z.string(), alt: z.string().optional() })).optional(),
      priority: z.boolean().optional(),
    },
    handler: (raw) => send(d, botId, slot(), raw as unknown as SendToAgentArgs, fanout),
  };
}

async function send(d: SendToAgentDeps, botId: string, s: TurnSlot | null, args: SendToAgentArgs, fanout: WeakMap<TurnSlot, { entryId: string; botIds: string[] }>): Promise<BotToolResult> {
  const nameOf = (id: string) => (d.bots.has(id) ? d.bots.summary(id).profile.name : id);
  const target = String(args.target_id ?? "").trim();
  // 1. target (B2B-01)
  if (target === botId) return err(STR.cantMessageSelf);
  let chain: Chain | null = s?.context.chainId ? d.chains.get(s.context.chainId) : null;
  if (!chain) {
    chain = d.chains.start("system", botId);
    if (s) s.context.chainId = chain.chainId;
  }
  const chainId = chain.chainId;
  if (d.groups?.isGroup(target)) {
    // I6: a group post is a hop like any other SendToAgent: loop/budget checks, admission, then the chain hop.
    const verdict = d.loops.check({ chain, from: botId, to: target, args: { ...args, kind: args.kind ?? "request" }, requests: d.requests, budgetFactor: d.budgetFactor() });
    if (!verdict.ok) {
      d.metrics.recordB2B({ botId, chainId, event: "terminated", kind: args.kind, reason: verdict.detector });
      return err(structuredError({ detector: verdict.detector, error: verdict.error, chainId, requests: [], hops: chain.hops, weightedTokens: chain.weightedTokens, detail: verdict.detail, peerName: nameOf(target), action: verdict.action === "terminate" ? "reject" : verdict.action }).text);
    }
    if (!d.mailbox.tryAdmit(target)) return err(`Not sent: Bots have taken too many turns in "${nameOf(target)}" and elsewhere recently. Try again in a few minutes, or finish the work yourself.`);
    d.chains.hop(chainId);
    return d.groups.postFromBot(target, botId, args, chainId);
  }
  if (!d.bots.has(target)) {
    const partners = d.bots.has(botId) ? d.bots.require(botId).store.getKv<string[]>(PARTNERS, []) : [];
    return err(partners.includes(target) ? STR.agentGone : STR.unknownAgent(target));
  }
  const toName = nameOf(target);
  const fromName = nameOf(botId);
  const message = String(args.message ?? "").trim();

  // 2. gate (G1–G8, then the classifier for ambiguous cases)
  const g = runGate({ from: botId, to: target, toName, args, requests: d.requests, threads: d.threads, nameOf, now: d.now() });
  if (g.verdict === "reject") {
    d.metrics.recordB2B({ botId, chainId, event: "rejected", kind: args.kind, reason: g.check });
    if (g.check === "G6" && d.loops.noteRepeat(chainId) >= LIMITS.repeatedRequestsForLoop) {
      return terminate({ ok: false, detector: "repeated_request", error: "b2b_loop_detected", action: "terminate", detail: "the same request was repeated 3 times in this exchange" });
    }
    return err(g.text);
  }
  const dropped = (reason: string, text: string): BotToolResult => {
    d.metrics.bump(botId, "dropped");
    d.metrics.recordB2B({ botId, chainId, event: "dropped", kind: args.kind, reason });
    return { text };
  };
  if (g.verdict === "drop") return dropped(g.check, g.text);
  let kind: B2BKind = g.kind;
  let inbox = false;
  let note = "";
  if (g.verdict === "ambiguous") {
    const v = d.classifier
      ? await d.classifier.classify({ botId, chainId, kind, message, expects: args.expects ?? null, thread_digest: g.digest })
      : { verdict: "inbox" as const, kind_suggestion: null, reason: "no classifier" };
    if (v.verdict === "drop") return dropped("classifier", `Not sent: it adds nothing new to your thread with ${toName}. Send only new results, questions, requests or blockers.`);
    if (v.verdict === "inbox") inbox = true;
    else if (v.kind_suggestion && (B2B_KINDS as readonly string[]).includes(v.kind_suggestion) && v.kind_suggestion !== kind) {
      note = ` Delivered as kind "${v.kind_suggestion}" instead of "${kind}": ${v.reason}`;
      kind = v.kind_suggestion as B2BKind;
    }
  }
  const boundRid = kind === "result" ? g.boundRid : null;
  if (kind === "result" && !boundRid) inbox = true;

  // 3. loops (L1, L3–L6; L2 above)
  const verdict = d.loops.check({ chain, from: botId, to: target, args: { ...args, kind }, requests: d.requests, budgetFactor: d.budgetFactor() });
  if (!verdict.ok) {
    if (verdict.action === "terminate") return terminate(verdict);
    d.metrics.bump(botId, "loopsEnded");
    d.metrics.recordB2B({ botId, chainId, event: "terminated", kind, reason: verdict.detector });
    const c = d.chains.get(chainId) ?? chain;
    return err(structuredError({ detector: verdict.detector, error: verdict.error, chainId, requests: [], hops: c.hops, weightedTokens: c.weightedTokens, detail: verdict.detail, peerName: toName, action: verdict.action }).text);
  }

  // 4. deliver
  d.chains.hop(chainId);
  const at = d.now();
  const lines = d.threads.lines(botId, target);
  const known = new Set([...informativeTokens(d.threads.digest(botId, target, d.requests, nameOf)), ...lines.flatMap((l) => l.tokens)]);
  const threadArtifacts = new Set(lines.flatMap((l) => l.artifacts));
  const artifacts = [...new Set([...(args.artifacts ?? []), ...extractArtifacts(message)])];
  let rid: string | undefined;
  let taskId: string | undefined;
  let inReplyTo: string | undefined;
  let requester: string | null = null;
  const expects = (args.expects ?? message.slice(0, 120)).trim();
  if (!inbox && kind !== "result") {
    if (kind === "handoff") taskId = args.task_id ?? newTaskId();
    rid = d.requests.open({ from: botId, to: target, kind, expects, taskId, chainId }).rid;
    if (kind === "handoff" && taskId) d.loops.noteHandoff(chainId, taskId, botId, target);
  }
  if (!inbox && kind === "result" && boundRid) {
    requester = d.requests.get(boundRid)?.from ?? target;
    d.requests.answer(boundRid, botId, message);
    inReplyTo = boundRid;
  }
  const meta = (id: string, name: string): AgentMeta => ({
    id, name, kind, ...(rid ? { rid } : {}), ...(inReplyTo ? { inReplyTo } : {}),
    ...(kind === "result" && args.status ? { status: args.status } : {}), ...(artifacts.length ? { artifacts } : {}),
  });
  const images = args.images?.length ? { images: args.images } : {};
  const out: AgentMessageEntry = { kind: "message", id: d.bots.auxEntryIds(botId, 1)[0] as string, role: "assistant", content: message, toAgent: meta(target, toName), chainId, createdAt: at, ...images, ...(inbox ? { inbox: true } : {}) };
  const inn: AgentMessageEntry = { kind: "message", id: d.bots.auxEntryIds(target, 1)[0] as string, role: "user", content: message, fromAgent: meta(botId, fromName), chainId, createdAt: at, ...images, ...(inbox ? { inbox: true } : {}) };
  d.bots.appendEntry(botId, out);
  d.bots.appendEntry(target, inn); // B2B-03: appended, never noteBotMessage → peer messages don't mark unread
  d.mirror?.onAgentMessage(chainId, out, botId);
  d.mirror?.onAgentMessage(chainId, inn, target);
  for (const [me, other] of [[botId, target], [target, botId]] as const) {
    const st = d.bots.require(me).store;
    st.setKv(PARTNERS, [...new Set([...st.getKv<string[]>(PARTNERS, []), other])].sort());
  }
  d.loops.noteExchange(chainId, botId, target, { novelty: novelty(informativeTokens(message), known), newArtifact: artifacts.some((a) => !threadArtifacts.has(a)) });
  d.threads.record(threadLineOf({ at, from: botId, to: target, kind, message, rid, artifacts }));
  d.metrics.recordB2B({ botId, chainId, event: "sent", kind });
  if (s) noteFanout(d, botId, s, target, chainId, fanout);

  const del: Delivery = {
    from: botId, fromName, kind, message, chainId, priority: false,
    ...(rid ? { rid } : {}), ...(args.expects ? { expects: args.expects } : {}), ...(inReplyTo ? { inReplyTo } : {}),
    ...(kind === "result" && args.status ? { status: args.status } : {}), ...(artifacts.length ? { artifacts } : {}),
    ...(args.images?.length ? { images: args.images } : {}), ...(taskId ? { taskId } : {}),
  };
  if (inbox) {
    d.mailbox.deliverInbox(target, { from: botId, fromName, text: message, chainId });
    return { text: kind === "result" && !note ? `Sent to ${toName}'s inbox (no wake): a result that answers no open request never wakes anyone.` : `Sent to ${toName}'s inbox (no wake): it asks for nothing, so ${toName} will read it on its next turn.` };
  }
  if (kind === "result") {
    d.mailbox.deliverResult(requester ?? target, del);
    return { text: `Sent result for ${inReplyTo} to ${toName}. It's delivered in the background; carry on without waiting for it.${note}` };
  }
  if (args.priority) {
    const pa = d.mailbox.priorityAllowed(target, chainId, kind);
    if (pa.ok) del.priority = true;
    else note += ` Sent to ${toName} as a normal message: ${pa.reason}.`;
  }
  d.mailbox.deliverWaking(target, del);
  // Ruling (d), extended: a pending request/question/handoff ends the turn without a closing nudge; a blocker keeps it.
  if (s && (kind === "request" || kind === "question" || kind === "handoff")) s.pendingDelegation = true;
  if (kind === "handoff") return { text: `Handed off task ${taskId} (${rid}) to ${toName}. It owns the task now — don't wait on it.${note}` };
  return { text: `Sent ${kind} ${rid} to ${toName}. Its result will wake you once — don't wait on it now.${note}` };

  /** ORIG-09 §09.5 terminate: end the exchange, tell the initiator, return the same error to the caller. Never a card or tray. */
  function terminate(v: Extract<LoopVerdict, { ok: false }>): BotToolResult {
    const c = d.chains.get(chainId) ?? (chain as Chain);
    const open = [...d.requests.openBetween(botId, target), ...d.requests.openBetween(target, botId)].filter((r) => r.chainId === chainId).sort((a, b) => a.createdAt - b.createdAt);
    const rids = open.map((r) => r.rid);
    const initiator = open[0]?.from ?? c.rootBotId;
    d.requests.terminate(rids);
    d.loops.terminatePair(chainId, botId, target);
    if (v.detector === "chain_too_long") d.chains.end(chainId, v.detector);
    d.metrics.bump(initiator, "loopsEnded");
    d.metrics.recordB2B({ botId, chainId, event: "terminated", kind: args.kind, reason: v.detector });
    const make = (peer: string) => structuredError({ detector: v.detector, error: v.error, chainId, requests: rids, hops: c.hops, weightedTokens: c.weightedTokens, detail: v.detail, peerName: nameOf(peer) }).text;
    if (initiator !== botId && d.bots.has(initiator)) d.mailbox.deliverError(initiator, { text: make(initiator === target ? botId : target), chainId });
    return err(make(target));
  }
}

/** CHAT-03 / B2B-02: the second distinct recipient in one turn adds "Messaged [avatars] N Bots"; later ones update it. */
function noteFanout(d: SendToAgentDeps, botId: string, s: TurnSlot, target: string, chainId: string, fanout: WeakMap<TurnSlot, { entryId: string; botIds: string[] }>): void {
  const cur = fanout.get(s) ?? { entryId: "", botIds: [] };
  if (cur.botIds.includes(target)) return;
  cur.botIds = [...cur.botIds, target];
  fanout.set(s, cur);
  if (cur.botIds.length < 2) return;
  const event = { type: "agents-messaged" as const, botIds: cur.botIds, chainId };
  if (!cur.entryId) {
    cur.entryId = d.bots.auxEntryIds(botId, 1)[0] as string;
    d.bots.appendEntry(botId, { kind: "event", id: cur.entryId, createdAt: d.now(), event });
  } else {
    d.bots.updateEntry(botId, { kind: "event", id: cur.entryId, createdAt: d.now(), event });
  }
}

/** B2B-08 / EVT-02 wake #7: a direct message from the user to every Bot (not groups), background lane. */
export function broadcast(runner: TurnRunner, bots: BotService, text: string): number {
  const t = text.trim();
  if (!t) throw new GatewayError("EMPTY_MESSAGE", "The message is empty.");
  const ids = bots.list().filter((b) => !b.group).map((b) => b.id);
  for (const id of ids) {
    runner.enqueueWake(id, {
      source: "broadcast", lane: "background", silenceAllowed: false,
      prompt: () => [{ text: `${HIDDEN_MARKER}\n${fillTemplate(loadPrompt("wakes/broadcast.md"), { TEXT: t }).trim()}` }],
    });
  }
  return ids.length;
}

export function b2bHandlers(d: { runner: TurnRunner; bots: BotService }): Pick<CommandHandlers, "broadcastToAgents"> {
  return { broadcastToAgents: (a) => ({ count: broadcast(d.runner, d.bots, a.text) }) };
}
