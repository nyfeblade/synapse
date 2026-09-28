import { LIMITS } from "@synapse/shared";
import { mentionedMembers } from "./addressing";
import type { RoomMessage } from "./member-prompt";

export interface MemberTurnResult { posts: string[]; failed: boolean }
export interface RoomTurnDeps {
  members(): { id: string; name: string }[];
  runMemberTurn(memberId: string, round: number): Promise<MemberTurnResult>;
  pickRound1?(): Promise<string[] | null>;
  pickLater?(roundMessages: RoomMessage[]): Promise<string[] | null>;
  /** Bug 108 (calls): who answers an utterance that names nobody when the floor manager doesn't pick. */
  pickDefault?(): string | null;
  cancelled(): boolean;
}
export interface RoomTurnOutcome { rounds: number; messages: number; spokeIds: string[]; turnGivenIds: string[]; passIds: string[]; cancelled: boolean }

function rotate<T>(xs: T[], offset: number): T[] {
  if (!xs.length) return xs;
  const k = offset % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}

/** GRP-04 bounded round-robin for one room turn. Pure: the orchestrator supplies member turns and cancellation. */
export async function runRoomTurn(trigger: { mentioned: string[] | "all"; maxFollowUps?: number; floorOnly?: boolean }, d: RoomTurnDeps): Promise<RoomTurnOutcome> {
  const members = d.members();
  const ids = members.map((m) => m.id);
  const base = trigger.mentioned === "all" ? ids : ids.filter((id) => trigger.mentioned.includes(id));
  const spoke: string[] = [];
  const given: string[] = [];
  let messages = 0;
  let rounds = 0;
  let cancelled = false;
  let prev: RoomMessage[] = [];
  // Voice calls: Bot-to-Bot follow-ups after the first answers are capped (they are spoken, one at a time).
  let followUps = 0;
  const followCap = trigger.maxFollowUps ?? Infinity;

  for (let round = 0; round < LIMITS.groupRounds; round++) {
    let responders: string[];
    if (round === 0) {
      const picked = trigger.mentioned === "all" && d.pickRound1 ? await d.pickRound1() : null;
      responders = picked ?? base;
      // Bug 108 (calls): only the Bot with the floor runs a model turn — the addressed Bot(s), else the
      // floor manager's top pick, else the default responder. The others don't run on every utterance.
      if (trigger.floorOnly && trigger.mentioned === "all") {
        const one = picked?.[0] ?? d.pickDefault?.() ?? ids[0];
        responders = one && ids.includes(one) ? [one] : ids.slice(0, 1);
      }
    } else if (trigger.floorOnly) {
      // Follow-ups only when a Bot names another (no model call), within what's left of the cap.
      const named = new Set<string>();
      for (const m of prev) {
        const hit = mentionedMembers(m.text, members.filter((x) => x.id !== m.from));
        if (hit !== "all") hit.forEach((h) => named.add(h));
      }
      responders = ids.filter((id) => named.has(id)).slice(0, Math.max(0, followCap - followUps));
    } else {
      const picked = d.pickLater ? await d.pickLater(prev) : null;
      if (picked) responders = picked;
      else {
        const named = new Set<string>();
        for (const m of prev) {
          const hit = mentionedMembers(m.text, members.filter((x) => x.id !== m.from));
          if (hit !== "all") hit.forEach((h) => named.add(h));
        }
        responders = named.size ? ids.filter((id) => named.has(id)) : base;
      }
    }
    const order = rotate(ids, round).filter((id) => responders.includes(id));
    if (!order.length) break;
    rounds += 1;
    const roundMsgs: RoomMessage[] = [];
    for (const id of order) {
      if (messages >= LIMITS.groupMessagesPerRoomTurn) break;
      if (round > 0 && followUps >= followCap) break;
      if (d.cancelled()) { cancelled = true; break; }
      if (!given.includes(id)) given.push(id);
      const res = await d.runMemberTurn(id, round);
      const posts = res.failed ? [] : res.posts.slice(0, Math.min(LIMITS.groupMessagesPerMemberTurn, LIMITS.groupMessagesPerRoomTurn - messages, round > 0 ? followCap - followUps : Infinity));
      messages += posts.length;
      if (round > 0) followUps += posts.length;
      if (posts.length && !spoke.includes(id)) spoke.push(id);
      const name = members.find((m) => m.id === id)?.name ?? id;
      for (const text of posts) roundMsgs.push({ from: id, fromName: name, text, at: Date.now() });
    }
    if (cancelled || roundMsgs.length === 0 || messages >= LIMITS.groupMessagesPerRoomTurn || followUps >= followCap) break;
    prev = roundMsgs;
  }
  return { rounds, messages, spokeIds: spoke, turnGivenIds: given, passIds: given.filter((id) => !spoke.includes(id)), cancelled };
}
