import { LIMITS, sendEntryId, userEntryId, type SendMessageEntry, type UserMessageEntry } from "@synapse/shared";
import { gatePost } from "../b2b/gate";
import type { ChainStore } from "../b2b/chains";
import type { BotService } from "../bots/bot-service";
import type { BotToolResult, Lane, TurnResult } from "../brain/types";
import { GatewayError } from "../gateway/errors";
import type { CommandHandlers } from "../gateway/server";
import type { RuntimeMetrics } from "../metrics/runtime-metrics";
import { attachmentMessages } from "../files/attachment-hooks";
import type { AttachmentInput, TurnRunner } from "../runner/turn-runner";
import type { TurnSlot } from "../runner/turn-slot";
import { log } from "../util/log";
import { isPass, mentionedMembers } from "./addressing";
import { lastUserPost, pickCallResponder } from "./call-routing";
import type { FloorManager } from "./floor";
import type { GroupService } from "./group-service";
import { renderMemberTurn, roomReviewOf, type RoomMessage, type RoomReview } from "./member-prompt";
import { runRoomTurn, type MemberTurnResult, type RoomTurnOutcome } from "./room-turn";

interface RoomState {
  groupId: string;
  roomTurnId: string;
  epoch: number;
  chainId: string;
  lane: Lane;
  total: number;
  startIndex: number;                // roomHistory length when this room turn began (GRP-09 race fix, see historyForTurn)
  posts: Map<string, string[]>;      // `${memberId}:${round}:${attempt}` → delivered posts
  current: Map<string, string>;      // memberId → key of its running member turn
  usage: { inputTokens: number; outputTokens: number; costUsd: number }; // I6: summed member-turn usage
  /** Voice calls: this room turn answers a spoken post. */
  voiceCall?: boolean;
  /** Bug 126: what the user's post attached (a shared screen's still); each member's first turn in the room turn sees it. */
  attachments?: AttachmentInput[];
  shown?: Set<string>;
  done: Promise<RoomTurnOutcome>;
}

const err = (text: string): BotToolResult => ({ text, isError: true });
/** Voice calls: Bot-to-Bot follow-ups per spoken user post (the first answers don't count). */
const VOICE_FOLLOW_UPS = 2;
const REDRIVE = (n: number) => `[Your previous turn in this group was interrupted by a direct message. This is attempt ${n} of ${LIMITS.groupRedriveMax + 1}; take your turn in the group now.]`;
let roomSeq = 0;

/** Bug 108: what the room reads from the live voice calls (host/voice/calls.ts CallRegistry). */
export interface CallRooms {
  roster(chatId: string): string[] | null;
  isMulti(chatId: string): boolean;
  historyFloor(chatId: string, botId: string): number | null;
  takeContext(chatId: string, botId: string): string | undefined;
}

export class GroupOrchestrator {
  private epochs = new Map<string, number>();
  private rooms = new Map<string, RoomState>();
  private nonces = new Map<string, string>();

  constructor(private d: { groups: GroupService; bots: BotService; runner: TurnRunner; chains: ChainStore; floor: FloorManager | null; smartTurns(): boolean; now(): number; metrics?: RuntimeMetrics | null; calls?: CallRooms | null }) {
    d.runner.registerSendRouter((_botId, slot, args) => {
      if (!slot.context.group) return null;
      const type = (args.type as string | undefined) ?? "text";
      if (type !== "text") return Promise.resolve(err("Group posts are text only. Send plain text."));
      return Promise.resolve(this.memberSend(slot, String(args.content ?? "")));
    });
    // A member change mid-turn cancels the room turn, so a removed member's in-flight turn can't post (Task 50 fuzz).
    d.groups.onMembersChanged((groupId, previous) => this.cancelRunning(groupId, previous));
  }

  epoch(groupId: string): number {
    return this.epochs.get(groupId) ?? 0;
  }

  isActive(groupId: string): boolean {
    return this.rooms.has(groupId);
  }

  async whenIdle(groupId: string): Promise<void> {
    for (let r = this.rooms.get(groupId); r; r = this.rooms.get(groupId)) await r.done.catch(() => undefined);
  }

  /** A room: a group chat, or a chat whose live voice call has more than one Bot (bug 108). */
  isRoom(chatId: string): boolean {
    return this.d.groups.isGroup(chatId) || Boolean(this.d.calls?.isMulti(chatId));
  }

  /** Who is in the room: the live call's Bots when a call is on (bug 108), else the group's members. */
  private roster(chatId: string): string[] {
    return this.d.calls?.roster(chatId) ?? (this.d.groups.isGroup(chatId) ? this.d.groups.members(chatId) : []);
  }

  private memberRefs(groupId: string, exclude: string[] = []): { id: string; name: string }[] {
    return this.roster(groupId).filter((id) => this.d.bots.has(id) && !exclude.includes(id)).map((id) => ({ id, name: this.d.bots.summary(id).profile.name }));
  }

  /** GRP-04: a new message (or a member change, which also reaches members just removed) cancels the running room turn (room epoch),
   *  dropping its queued member wakes and interrupting the active one. */
  private cancelRunning(groupId: string, alsoMembers: string[] = []): void {
    this.epochs.set(groupId, this.epoch(groupId) + 1);
    for (const m of new Set([...this.roster(groupId), ...alsoMembers])) {
      if (!this.d.bots.has(m)) continue;
      this.d.runner.dropQueued(m, (t) => t.id.startsWith(`grp:${groupId}:`));
      if (this.d.runner.slot(m)?.context.group?.groupId === groupId) {
        void this.d.runner.interruptActive(m, "superseded by a new group message").catch((e) =>
          log.error("group interruptActive failed", { groupId, memberId: m, error: e instanceof Error ? e.message : String(e) }),
        );
      }
    }
  }

  userPost(groupId: string, text: string, clientNonce: string, voice?: { durationMs?: number; call?: boolean }, attachments: AttachmentInput[] = []): { entryId: string } {
    if (!this.isRoom(groupId)) throw new GatewayError("NOT_A_GROUP", "Not a group.", 400);
    if (!text.trim() && !attachments.length) throw new GatewayError("EMPTY_MESSAGE", "The message is empty.");
    const dup = this.nonces.get(`${groupId}:${clientNonce}`);
    if (dup) return { entryId: dup };
    const seq = this.d.bots.nextUserSeq(groupId);
    const entry: UserMessageEntry = {
      kind: "message", id: userEntryId(seq), role: "user", content: text, clientNonce, createdAt: this.d.now(),
      ...(attachments.length ? { attachmentEntryIds: attachments.map((_, k) => `${userEntryId(seq)}a${k + 1}`) } : {}),
      ...(voice && (voice.durationMs || voice.call) ? { voice: { durationMs: Math.round(voice.durationMs ?? 0), ...(voice.call ? { call: true as const } : {}) } } : {}),
    };
    this.d.bots.appendEntry(groupId, entry);
    // Bug 126: the post's attachments are recorded like a 1:1 message's (the chat shows them; the room turn carries them).
    attachments.forEach((a, k) => this.d.bots.appendEntry(groupId, { kind: "user-attachment", ...a, id: `${entry.id}a${k + 1}`, batchId: entry.id, createdAt: entry.createdAt }));
    this.nonces.set(`${groupId}:${clientNonce}`, entry.id);
    this.d.groups.notePost(groupId, "You", text);
    this.cancelRunning(groupId);
    const chain = this.d.chains.start("user", groupId, { groupId });
    void this.startRoomTurn(groupId, { mentioned: mentionedMembers(text, this.memberRefs(groupId)), chainId: chain.chainId, lane: "user", fromUser: true, ...(voice?.call ? { voiceCall: true } : {}), ...(attachments.length ? { attachments } : {}) }).catch((e) =>
      log.error("group room turn failed", { groupId, error: e instanceof Error ? e.message : String(e) }),
    );
    return { entryId: entry.id };
  }

  /** I6: stop the running room turn (the routine hard limit). */
  cancelRoom(groupId: string, alsoMembers: string[] = []): void {
    this.cancelRunning(groupId, alsoMembers);
  }

  async seedRoutine(groupId: string, routineName: string, text: string): Promise<RoomTurnOutcome & { usage: RoomState["usage"] }> {
    await this.whenIdle(groupId);
    const [id] = this.d.bots.auxEntryIds(groupId, 1);
    this.d.bots.appendEntry(groupId, { kind: "notice", id: id!, text: `Triggered by: ${routineName}\n${text}`, createdAt: this.d.now() });
    const chain = this.d.chains.start("routine", groupId, { groupId });
    const out = await this.startRoomTurn(groupId, { mentioned: mentionedMembers(text, this.memberRefs(groupId)), chainId: chain.chainId, lane: "background" });
    return { ...out, usage: this.lastUsage.get(groupId) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }

  private lastUsage = new Map<string, RoomState["usage"]>();

  startRoomTurn(groupId: string, trigger: { mentioned: string[] | "all"; chainId: string; lane?: Lane; exclude?: string[]; fromUser?: boolean; voiceCall?: boolean; attachments?: AttachmentInput[] }): Promise<RoomTurnOutcome> {
    const epoch = this.epoch(groupId);
    const lane = trigger.lane ?? "user";
    const room = {
      groupId, roomTurnId: `rt_${this.d.now().toString(36)}_${++roomSeq}`, epoch, chainId: trigger.chainId, lane, total: 0,
      startIndex: this.roomHistory(groupId).length, posts: new Map(), current: new Map(), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      ...(trigger.voiceCall ? { voiceCall: true } : {}),
      ...(trigger.attachments?.length ? { attachments: trigger.attachments, shown: new Set<string>() } : {}),
    } as Omit<RoomState, "done"> as RoomState;
    const members = () => this.memberRefs(groupId, trigger.exclude ?? []);
    const floorOn = Boolean(this.d.floor) && this.d.smartTurns() && trigger.fromUser === true && trigger.mentioned === "all" && members().length >= LIMITS.floorMinMembers;
    const groupName = this.roomName(groupId);
    const withDesc = () => members().map((m) => ({ ...m, description: this.d.bots.summary(m.id).profile.description.slice(0, 300) }));
    const call = trigger.voiceCall === true;
    room.done = (async () => {
      const out = await runRoomTurn({ mentioned: trigger.mentioned, ...(call ? { maxFollowUps: VOICE_FOLLOW_UPS, floorOnly: true } : {}) }, {
        members,
        cancelled: () => this.epoch(groupId) !== epoch,
        runMemberTurn: (id, round) => this.memberTurn(room, id, round),
        // Bug 108: an utterance that names nobody goes to the Bot that spoke last (else the first on the call).
        // Call-behaviour (decision D4, bug 249): on a call it is decided in code — continuity, then a local relevance
        // score over the Bots' descriptions, then the last speaker (call-routing.ts). No floor-manager model call.
        pickDefault: () => call
          ? pickCallResponder({ post: lastUserPost(this.roomHistory(groupId)), members: withDesc().map((m) => ({ ...m, description: `${this.d.bots.summary(m.id).profile.title ?? ""}. ${m.description}` })), history: this.roomHistory(groupId) })
          : this.lastSpeaker(groupId, members().map((m) => m.id)),
        pickRound1: floorOn && !call
          ? () => {
              const hist = this.roomHistory(groupId);
              const post = hist.at(-1) ?? { from: "user", fromName: "You", text: "", at: this.d.now() };
              return this.d.floor!.pickRound1({ group: groupName, members: withDesc(), recent: hist.slice(-7, -1), post });
            }
          : undefined,
        // Calls: follow-ups go by name only (no scoring call per round); see runRoomTurn floorOnly.
        pickLater: floorOn && !call ? (roundMessages) => this.d.floor!.pickLater({ group: groupName, members: withDesc(), roundMessages }) : undefined,
      });
      if (!out.cancelled && out.passIds.length && this.d.bots.has(groupId)) {
        const [id] = this.d.bots.auxEntryIds(groupId, 1);
        this.d.bots.appendEntry(groupId, { kind: "event", id: id!, createdAt: this.d.now(), event: { type: "member-pass", botIds: out.passIds, roomTurnId: room.roomTurnId } });
      }
      return out;
    })().finally(() => {
      this.lastUsage.set(groupId, room.usage);
      if (this.rooms.get(groupId) === room) this.rooms.delete(groupId);
    });
    this.rooms.set(groupId, room);
    return room.done;
  }

  private async memberTurn(room: RoomState, memberId: string, round: number): Promise<MemberTurnResult> {
    for (let attempt = 0; attempt <= LIMITS.groupRedriveMax; attempt++) {
      if (this.epoch(room.groupId) !== room.epoch || !this.d.bots.has(memberId)) return { posts: [], failed: true };
      const key = `${memberId}:${round}:${attempt}`;
      room.posts.set(key, []);
      room.current.set(memberId, key);
      const result = await this.runOnce(room, memberId, key, attempt);
      const posts = room.posts.get(key) ?? [];
      const preempted = result !== null && result.aborted && !result.error && posts.length === 0;
      if (preempted && attempt < LIMITS.groupRedriveMax && this.epoch(room.groupId) === room.epoch) continue;
      return { posts, failed: result === null || Boolean(result.error) || (result.aborted && posts.length === 0) };
    }
    return { posts: [], failed: true };
  }

  private runOnce(room: RoomState, memberId: string, key: string, attempt: number): Promise<TurnResult | null> {
    return new Promise((resolve) => {
      let started = false;
      let settled = false;
      let idleChecks = 0;
      const id = `grp:${room.groupId}:${room.roomTurnId}:${key}`;
      let review: RoomReview | null = null;
      const finish = (r: TurnResult | null) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        resolve(r);
      };
      this.d.runner.enqueueWake(memberId, {
        id,
        source: "group-member",
        lane: room.lane,
        groupMember: room.lane === "user",
        ...(room.voiceCall ? { voiceCall: true } : {}),
        silenceAllowed: true,
        hidden: true,
        context: { group: { groupId: room.groupId, roomTurnId: room.roomTurnId, epoch: room.epoch }, chainId: room.chainId },
        prompt: () => {
          const joinContext = this.d.calls?.takeContext(room.groupId, memberId);
          const history = this.historyForTurn(room, memberId);
          const me = { id: memberId, name: this.d.bots.summary(memberId).profile.name };
          // Bug 434 follow-up: the reviewer's trust comes from these structured authors, never from display names.
          review = roomReviewOf({ me, history, joinContext });
          return [
            ...renderMemberTurn({
              groupName: this.roomName(room.groupId), joinContext, members: this.memberRefs(room.groupId), me, history,
              redriveNote: attempt > 0 ? REDRIVE(attempt + 1) : undefined, voiceCall: room.voiceCall,
            }),
            ...this.takeAttachments(room, memberId),
          ];
        },
        onStart: (slot) => { started = true; if (review) slot.roomReview = review; },
        onSettle: (_slot, result) => {
          if (result) {
            // I6: every member turn is charged to the room's chain budget and summed for routine spend accounting.
            if (this.d.chains.get(room.chainId)) this.d.chains.addPeerTurn(room.chainId, result.usage);
            room.usage.inputTokens += result.usage.inputTokens;
            room.usage.outputTokens += result.usage.outputTokens;
            room.usage.costUsd += result.usage.costUsd ?? 0;
          }
          finish(result);
        },
      });
      // A wake dropped from the queue never settles; once the member is idle without having started it, count a pass.
      const watch = setInterval(() => {
        if (started || this.d.runner.queued(memberId, (t) => t.id === id) > 0 || this.d.runner.recipientState(memberId) !== "idle") { idleChecks = 0; return; }
        if (++idleChecks >= 3) finish(null);
      }, 250);
    });
  }

  /** Bug 126: the post's attachments, once per member per room turn (a later round's turn already has them in its session). */
  private takeAttachments(room: RoomState, memberId: string): ReturnType<typeof attachmentMessages> {
    if (!room.attachments?.length || room.shown?.has(memberId)) return [];
    room.shown?.add(memberId);
    try {
      return attachmentMessages(room.attachments);
    } catch (e) {
      log.warn("room attachment unreadable", { groupId: room.groupId, error: e instanceof Error ? e.message : String(e) });
      return [{ text: "[The user attached a file to this post, but it couldn't be read. Ask them to send it again.]" }];
    }
  }

  /** SendMessage in a member turn (GRP-06): posts to the group as the member, after the pass check, caps and gate G3–G5. */
  memberSend(slot: TurnSlot, content: string): BotToolResult {
    const g = slot.context.group;
    if (!g) return err("No group turn is active.");
    const room = this.rooms.get(g.groupId);
    if (!room || room.roomTurnId !== g.roomTurnId || this.epoch(g.groupId) !== g.epoch) return err("The group conversation moved on. End your turn now.");
    const text = content.trim();
    if (!text) return err("content is required for a text message.");
    if (isPass(text)) return { text: "Passed. End your turn now." };
    const key = room.current.get(slot.botId);
    const mine = key ? room.posts.get(key) : undefined;
    if (!mine) return err("It isn't your turn in this group. End your turn now.");
    if (mine.length >= LIMITS.groupMessagesPerMemberTurn) return err("You already posted twice this turn. End your turn now.");
    if (room.total >= LIMITS.groupMessagesPerRoomTurn) return err("The group has reached its reply limit for now. End your turn now.");
    const history = this.roomHistory(g.groupId, slot.botId);
    const lastOwn = [...history].reverse().find((m) => m.from === slot.botId)?.text ?? null;
    const gate = gatePost({ text, history: history.filter((m) => m.from !== slot.botId).map((m) => m.text), lastOwnPost: lastOwn, now: this.d.now() });
    if (gate.verdict === "drop") {
      this.d.metrics?.bump(slot.botId, "dropped");
      return { text: "Not posted: it adds nothing new to the room, so it counts as a pass. End your turn now." };
    }
    const name = this.d.bots.summary(slot.botId).profile.name;
    const entry: SendMessageEntry = {
      kind: "send-message", id: sendEntryId(this.d.bots.nextTurnNo(g.groupId), 1), requestId: slot.requestId, createdAt: this.d.now(),
      message: { type: "text", content: text }, author: { id: slot.botId, name },
    };
    this.d.bots.appendEntry(g.groupId, entry);
    this.d.groups.notePost(g.groupId, name, text);
    mine.push(text);
    room.total += 1;
    slot.sentMessageCount += 1;
    slot.segment += 1;
    return { text: "Posted to the group." };
  }

  /** The room history members see (GRP-05): user posts, member posts and routine seeds. Pass rows and events never appear. */
  roomHistory(groupId: string, sinceForMember?: string): RoomMessage[] {
    const out: RoomMessage[] = [];
    for (const e of this.d.bots.tail(groupId, 300)) {
      if (e.kind === "message" && e.role === "user" && !("fromAgent" in e && e.fromAgent) && !("toAgent" in e && e.toAgent)) out.push({ from: "user", fromName: "You", text: e.content.trim() || ("attachmentEntryIds" in e && e.attachmentEntryIds?.length ? "(sent an attachment)" : e.content), at: e.createdAt });
      else if (e.kind === "send-message" && e.author && e.message.type === "text") out.push({ from: e.author.id, fromName: e.author.name, text: e.message.content, at: e.createdAt });
      // Bug 108: a 1:1 chat's call room — the Bot's own replies there carry no author.
      else if (e.kind === "send-message" && !e.author && e.message.type === "text" && !this.d.groups.isGroup(groupId)) out.push({ from: groupId, fromName: this.d.bots.summary(groupId).profile.name, text: e.message.content, at: e.createdAt });
      else if (e.kind === "notice" && e.text.startsWith("Triggered by:")) out.push({ from: "system", fromName: "Routine", text: e.text, at: e.createdAt });
    }
    if (!sinceForMember) return out;
    let last = -1;
    out.forEach((m, i) => { if (m.from === sinceForMember) last = i; });
    return last < 0 ? out : out.slice(last);
  }

  /**
   * The slice of room history a member's turn prompt should show: same as `roomHistory(groupId, memberId)`
   * ("since my last own post", so a member who keeps passing sees the whole conversation build up), but
   * never trimmed past when the current room turn began. Without that floor, a message another member
   * posts into the room mid-turn (SendToAgent while `isActive`) can land, in append order, *before* this
   * member's own reply from earlier in the same turn — "since my last own post" would then cut it out of
   * every future prompt, silently dropping it. Clamping to the turn's start ensures anything posted since
   * this room turn began is always visible, regardless of where it falls relative to the member's own posts.
   */
  private historyForTurn(room: RoomState, memberId: string): RoomMessage[] {
    // Bug 108: a call member sees the room only from when it could hear it (a 1:1 chat before the
    // call, or the call before an added Bot joined, stays out; its context block covers the call).
    const since = this.d.calls?.historyFloor(room.groupId, memberId) ?? null;
    const all = this.roomHistory(room.groupId);
    const full = since === null ? all : all.filter((m) => m.at >= since);
    let lastOwn = -1;
    full.forEach((m, i) => { if (m.from === memberId) lastOwn = i; });
    const start = Math.max(0, room.startIndex - (all.length - full.length)); // the floor only trims the front
    return lastOwn < 0 ? full : full.slice(Math.min(lastOwn, start));
  }

  /** The room's name in member prompts: the group's, or "Voice call with <Bot>" for a 1:1 chat's call (bug 108). */
  private roomName(chatId: string): string {
    const name = this.d.bots.summary(chatId).profile.name;
    return this.d.groups.isGroup(chatId) ? name : `Voice call with ${name}`;
  }

  /** Bug 108: the default responder — the room member that spoke last, else the first one. */
  private lastSpeaker(chatId: string, ids: string[]): string | null {
    const last = [...this.roomHistory(chatId)].reverse().find((m) => ids.includes(m.from));
    return last?.from ?? ids[0] ?? null;
  }
}

/** Bug 108: a spoken post in a 1:1 chat whose call has more than one Bot is a room post. */
export function isCallRoomPost(calls: CallRooms | null | undefined, a: { id: string; voice?: { call?: boolean } }): boolean {
  return a.voice?.call === true && Boolean(calls?.isMulti(a.id));
}

/** Gateway `sendPrompt`: group ids (and multi-Bot call rooms) go to the orchestrator, Bot ids to the TurnRunner. */
/** Bug 126: a room post's attachmentIds are resolved in the chat they were uploaded to and go to every Bot that answers;
 *  without a resolver they are refused, never dropped. */
export function routeSendPrompt(groups: GroupService, orch: GroupOrchestrator, runner: TurnRunner, calls?: CallRooms | null, resolveAttachments?: (chatId: string, ids: string[]) => AttachmentInput[]): NonNullable<CommandHandlers["sendPrompt"]> {
  return (a) => {
    const ids = a.attachmentIds?.length ? a.attachmentIds : null;
    if (ids && !resolveAttachments) throw new GatewayError("NO_ATTACHMENTS", "Attachments can't be sent here.", 400);
    const atts = ids && resolveAttachments ? resolveAttachments(a.id, ids) : undefined;
    if (groups.isGroup(a.id) || isCallRoomPost(calls, a)) return orch.userPost(a.id, a.text, a.clientNonce, a.voice, atts);
    return runner.sendPrompt(a.id, a.text, a.clientNonce, atts ? { attachmentEntries: atts } : {});
  };
}
