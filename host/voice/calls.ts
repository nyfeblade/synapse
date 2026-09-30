import { LIMITS5, STR5, STRV, isAcpModelRef, type BotSummary, type TranscriptEntry, type VoiceCallView } from "@synapse/shared";
import { GatewayError } from "../gateway/errors";
import { roomBotName } from "../groups/member-prompt";
import type { CommandHandlers } from "../gateway/server";

/** 192400 → "3m 12s"; under a minute → "42s". */
export function callLength(ms: number): string {
  const s = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** "4m" for the joined-a-call note (compact: whole minutes, or seconds under a minute). */
function shortLength(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
}

/** What the registry needs from BotService (tests pass a stand-in). */
export interface CallBots {
  has(id: string): boolean;
  summary(id: string): BotSummary;
  tail(id: string, n: number): TranscriptEntry[];
  auxEntryIds(id: string, n: number): string[];
  appendEntry(id: string, e: TranscriptEntry): void;
}

interface Participant { botId: string; joinedAt: number; addedByUser: boolean; context?: string }
interface Call {
  callId: string;
  chatId: string;
  anchorId: string | null;
  startedAt: number;
  participants: Participant[];
  /** Everyone who was on the call at some point (the ended marker names them all). */
  everOn: string[];
}

let callSeq = 0;

/**
 * Bug 108: voice calls own their roster. Any call (1:1 or group) can take Bots added from a dropdown,
 * up to LIMITS5.callMaxBots in total — enforced HERE, not only in the UI. The call's record stays in
 * the chat it started in; a Bot added mid-call gets a short, redacted context block of the call so far
 * (delivered with its first turn), and a "Joined a call in <chat> · 4m" note in its own chat.
 */
/** 0.1.6: Bots on a coding CLI can't be on a call yet (ACP ruling 15). */
function noCalls(b: Pick<BotSummary, "profile">): boolean {
  return isAcpModelRef(b.profile.model);
}

export class CallRegistry {
  private calls = new Map<string, Call>();
  private byChat = new Map<string, string>();
  /** Bug 134: recently ended calls, so hang-up's wrap-up can read them after the ended marker. */
  private ended = new Map<string, Call & { durationMs: number }>();

  constructor(private d: { bots: CallBots; now(): number; redact?(botId: string, text: string): string; onRemoved?(chatId: string, botIds: string[]): void }) {}

  private name(id: string): string {
    return this.d.bots.has(id) ? this.d.bots.summary(id).profile.name : id;
  }

  private notice(chatId: string, text: string, link?: { botId: string }): void {
    if (!this.d.bots.has(chatId)) return;
    const [id] = this.d.bots.auxEntryIds(chatId, 1);
    this.d.bots.appendEntry(chatId, { kind: "notice", id: id!, text, createdAt: this.d.now(), ...(link ? { link } : {}) });
  }

  private view(c: Call): VoiceCallView {
    return { callId: c.callId, chatId: c.chatId, anchorId: c.anchorId, participantIds: c.participants.map((p) => p.botId) };
  }

  private get(callId: string): Call {
    const c = this.calls.get(callId);
    if (!c) throw new GatewayError("NOT_FOUND", "That call has ended.", 404);
    return c;
  }

  /** Calls in progress right now (TTFT war room: while any is live the host keeps fewer warm CLI processes). */
  liveCount(): number {
    return this.calls.size;
  }

  /** Starts (or rejoins) the call for a chat. A group starts with its members, the 6 most recently active first. */
  start(chatId: string): VoiceCallView {
    if (!this.d.bots.has(chatId)) throw new GatewayError("NOT_FOUND", "That chat doesn't exist.", 404);
    const live = this.byChat.get(chatId);
    if (live && this.calls.has(live)) return this.view(this.calls.get(live)!);
    const chat = this.d.bots.summary(chatId);
    // 0.1.6: a Bot on a coding CLI (ACP) has no voice yet: its call is refused up front, and a group call leaves it out.
    if (!chat.group && noCalls(chat)) throw new GatewayError("CALLS_UNAVAILABLE", STRV.callsNotAvailable(chat.profile.name));
    const now = this.d.now();
    let ids: string[];
    if (chat.group) {
      const members = chat.group.memberIds.filter((m) => this.d.bots.has(m) && !noCalls(this.d.bots.summary(m)));
      if (!members.length) throw new GatewayError("CALLS_UNAVAILABLE", STRV.callsNotAvailable(chat.profile.name));
      const recency = (m: string) => { const s = this.d.bots.summary(m); return Math.max(s.lastBotMessageAt ?? 0, s.updatedAt ?? 0); };
      ids = [...members].sort((a, b) => recency(b) - recency(a)).slice(0, LIMITS5.callMaxBots);
      ids = members.filter((m) => ids.includes(m)); // keep the group's own order on screen
    } else ids = [chatId];
    const c: Call = {
      callId: `call_${now.toString(36)}_${++callSeq}`, chatId, anchorId: chat.group ? null : chatId, startedAt: now,
      participants: ids.map((botId) => ({ botId, joinedAt: now, addedByUser: false })), everOn: [...ids],
    };
    this.calls.set(c.callId, c);
    this.byChat.set(chatId, c.callId);
    this.notice(chatId, STR5.callStartedWith(ids.map((i) => this.name(i)).join(", ")));
    return this.view(c);
  }

  /** Bots the user can add right now: real Bots (not groups, not archived) that aren't on the call. */
  eligible(callId: string, all: BotSummary[]): string[] {
    const c = this.get(callId);
    const on = new Set(c.participants.map((p) => p.botId));
    return all.filter((b) => !b.group && !b.archived && !on.has(b.id) && !noCalls(b)).map((b) => b.id);
  }

  add(callId: string, botId: string): VoiceCallView {
    const c = this.get(callId);
    if (!this.d.bots.has(botId)) throw new GatewayError("NOT_FOUND", "That Bot doesn't exist.", 404);
    const b = this.d.bots.summary(botId);
    if (b.group) throw new GatewayError("BAD_ARGS", "A group can't join a call as a Bot.");
    if (noCalls(b)) throw new GatewayError("CALLS_UNAVAILABLE", STRV.callsNotAvailable(b.profile.name));
    if (c.participants.some((p) => p.botId === botId)) return this.view(c);
    if (c.participants.length >= LIMITS5.callMaxBots) throw new GatewayError("CALL_FULL", STR5.callFull, 400);
    const now = this.d.now();
    c.participants.push({ botId, joinedAt: now, addedByUser: true, context: this.contextBlock(c, botId) });
    if (!c.everOn.includes(botId)) c.everOn.push(botId);
    this.notice(c.chatId, STR5.callJoined(b.profile.name));
    return this.view(c);
  }

  remove(callId: string, botId: string): VoiceCallView {
    const c = this.get(callId);
    const p = c.participants.find((x) => x.botId === botId);
    if (!p) return this.view(c);
    if (botId === c.anchorId) throw new GatewayError("BAD_ARGS", "The Bot you called can't leave its own call. Hang up instead.");
    if (c.participants.length <= 1) throw new GatewayError("BAD_ARGS", "A call needs at least one Bot. Hang up instead.");
    c.participants = c.participants.filter((x) => x !== p);
    this.notice(c.chatId, STR5.callLeft(this.name(botId)));
    this.noteJoined(c, p);
    this.d.onRemoved?.(c.chatId, [botId]);
    return this.view(c);
  }

  end(callId: string, durationMs?: number): void {
    const c = this.calls.get(callId);
    if (!c) return; // hanging up twice is harmless
    this.calls.delete(callId);
    if (this.byChat.get(c.chatId) === callId) this.byChat.delete(c.chatId);
    const ms = durationMs ?? this.d.now() - c.startedAt;
    this.ended.set(callId, { ...c, durationMs: ms });
    if (this.ended.size > 20) this.ended.delete(this.ended.keys().next().value!);
    this.notice(c.chatId, STR5.callEndedWith(callLength(ms), c.everOn.map((i) => this.name(i)).join(", ")));
    for (const p of c.participants) this.noteJoined(c, p);
  }

  /** "Joined a call in <chat> · 4m" in an added Bot's own chat, linking back to where the call lives. */
  private noteJoined(c: Call, p: Participant): void {
    if (!p.addedByUser || p.botId === c.chatId) return;
    this.notice(p.botId, STR5.callJoinedNote(this.name(c.chatId), shortLength(this.d.now() - p.joinedAt)), { botId: c.chatId });
  }

  /**
   * Bug 158: the live call this Bot is a participant of, or null. A Bot may only change the roster of
   * a call it is ON, so this — not a callId it could name — is what decides which call it may touch.
   */
  callFor(botId: string): VoiceCallView | null {
    for (const c of this.calls.values()) if (c.participants.some((p) => p.botId === botId)) return this.view(c);
    return null;
  }

  /** A live or recently ended call: where it lives, when it began, who was ever on it (bug 134's wrap-up). */
  info(callId: string): { chatId: string; startedAt: number; everOn: string[]; durationMs: number | null } | null {
    const c = this.calls.get(callId) ?? this.ended.get(callId);
    if (!c) return null;
    return { chatId: c.chatId, startedAt: c.startedAt, everOn: [...c.everOn], durationMs: "durationMs" in c ? (c as { durationMs: number }).durationMs : null };
  }

  // ---- what the room (orchestrator) reads ----

  /** The live call's Bots for a chat, or null when no call is live there. */
  roster(chatId: string): string[] | null {
    const id = this.byChat.get(chatId);
    const c = id ? this.calls.get(id) : undefined;
    return c ? c.participants.map((p) => p.botId) : null;
  }

  /** A 1:1 chat's call runs as a room only once a second Bot is on it. */
  isMulti(chatId: string): boolean {
    return (this.roster(chatId)?.length ?? 0) > 1;
  }

  /**
   * History a call member may see starts when it could hear: a 1:1 chat's call shows no member the
   * chat before the call; a Bot added mid-call sees only what came after it joined (the context block
   * covers the rest). null = no floor (a group member in its own group).
   */
  historyFloor(chatId: string, botId: string): number | null {
    const id = this.byChat.get(chatId);
    const c = id ? this.calls.get(id) : undefined;
    if (!c) return null;
    const p = c.participants.find((x) => x.botId === botId);
    if (p?.addedByUser) return p.joinedAt;
    return this.d.bots.summary(chatId).group ? null : c.startedAt;
  }

  /** The joiner's context block, handed over once, with its first turn in the call. */
  takeContext(chatId: string, botId: string): string | undefined {
    const id = this.byChat.get(chatId);
    const p = id ? this.calls.get(id)?.participants.find((x) => x.botId === botId) : undefined;
    const out = p?.context;
    if (p) delete p.context;
    return out;
  }

  /** The call so far, for a Bot added mid-call: who is on it, that the user added it, the last turns (≈2k tokens max), redacted. */
  contextBlock(c: Call, botId: string): string {
    const me = this.name(botId);
    const others = c.participants.map((p) => p.botId).filter((i) => i !== botId).map((i) => this.name(i));
    const scrub = (t: string) => (this.d.redact ? this.d.redact(botId, t) : t);
    const lines: string[] = [];
    for (const e of this.d.bots.tail(c.chatId, 300)) {
      if (!("createdAt" in e) || e.createdAt < c.startedAt) continue;
      let who: string | null = null;
      let text = "";
      if (e.kind === "message" && e.role === "user" && !("fromAgent" in e && e.fromAgent) && !("toAgent" in e && e.toAgent)) { who = "User"; text = e.content; }
      // Bug 434 follow-up: a Bot named like the user ("User", any case, width or look-alike) never reads as the user.
      else if (e.kind === "send-message" && e.message.type === "text") { who = roomBotName(e.author?.name ?? this.name(c.chatId)); text = e.message.content; }
      if (who && text.trim()) lines.push(`${who}: ${scrub(text.replace(/\s+/g, " ").trim()).slice(0, 600)}`);
    }
    const head = [
      `[You (${me}) were just added to a voice call by the user, in the chat "${this.name(c.chatId)}".]`,
      `On the call: the user${others.length ? `, ${others.join(", ")}` : ""}, and you.`,
      "Answer when you're addressed by name or have something useful to add; otherwise stay quiet. Don't greet or acknowledge being added.",
    ];
    const cap = LIMITS5.callJoinContextChars;
    let body = lines.slice(-LIMITS5.callJoinContextTurns);
    const size = () => head.join("\n").length + 30 + body.join("\n").length;
    while (body.length && size() > cap) body = body.slice(1);
    const out = [...head, body.length ? `The call so far:\n${body.join("\n")}` : "The call has only just started."].join("\n");
    return out.slice(0, cap);
  }
}

/**
 * Bug 158: the ONE way a Bot can change a call's roster — SendMessage's existing `call` parameter,
 * `call: "drop <Bot>"` (no new tool: the 28-tool ceiling, and no new schema field: `call` is already
 * there for "why" and "look"). Every rule is enforced HERE, never asked for in a prompt: the Bot must
 * be ON a live call, may only name someone else ON THAT call, can never take off the Bot the call
 * started with, and can never reach the user — who is not a participant, so the chat id, a group id
 * or "the user" simply is not on the roster it can name.
 */
export function dropFromCall(d: {
  calls: Pick<CallRegistry, "callFor" | "remove">;
  name(botId: string): string;
  /** The roster changed: the app's call screen and the voice fast path are told. */
  changed(view: VoiceCallView): void;
}): (botId: string, wanted: string) => { text: string; isError?: boolean } {
  const err = (text: string) => ({ text, isError: true });
  return (botId, raw) => {
    const wanted = raw.trim().replace(/^(?:the\s+)?/i, "").replace(/\s+(?:bot|from (?:the|this) call|off (?:the|this) call)$/i, "").trim();
    const call = d.calls.callFor(botId);
    if (!call) return err("You're not on a voice call, so there is no call to take anyone off.");
    if (!wanted) return err('call: "drop <Bot>" needs the name of a Bot on this call.');
    const key = wanted.toLowerCase();
    const on = call.participantIds.filter((id) => id !== botId);
    const target = on.find((id) => id === wanted) ?? on.find((id) => d.name(id).toLowerCase() === key) ?? on.find((id) => d.name(id).toLowerCase().split(" ")[0] === key);
    if (!target) {
      // Deliberately the same answer for "not on this call" and "not a Bot at all": a Bot learns who is
      // on the call with it, never who else exists — and the user is never a name it can resolve here.
      // (The call's own Bot IS on the roster, so it resolves and is refused by remove() below, by name.)
      const who = on.length ? on.map((id) => d.name(id)).join(", ") : "nobody else";
      return err(`"${wanted}" isn't another Bot on your call. On it with you: ${who}.`);
    }
    try {
      const view = d.calls.remove(call.callId, target);
      d.changed(view);
      return { text: `${d.name(target)} is off the call.` };
    } catch (e) {
      return err(e instanceof GatewayError ? e.message : `Couldn't take ${d.name(target)} off the call.`);
    }
  };
}

/** Gateway commands for calls (bug 108). */
export function callHandlers(calls: CallRegistry): Pick<CommandHandlers, "startCall" | "addToCall" | "removeFromCall" | "endCall"> {
  const str = (v: unknown, what: string) => { if (typeof v !== "string" || !v) throw new GatewayError("BAD_ARGS", `${what} is required.`); return v; };
  return {
    startCall: (a) => calls.start(str(a.id, "id")),
    addToCall: (a) => calls.add(str(a.callId, "callId"), str(a.botId, "botId")),
    removeFromCall: (a) => calls.remove(str(a.callId, "callId"), str(a.botId, "botId")),
    endCall: (a) => { calls.end(str(a.callId, "callId"), typeof a.durationMs === "number" ? a.durationMs : undefined); return {}; },
  };
}
