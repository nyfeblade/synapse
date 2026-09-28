import { LIMITS } from "@synapse/shared";
import type { ModelMessage } from "../brain/types";
import { fillTemplate, loadPrompt } from "../prompts/index";

export interface RoomMessage { from: string; fromName: string; text: string; at: number }

export function renderMemberTurn(p: { groupName: string; members: { id: string; name: string }[]; me: { id: string; name: string }; history: RoomMessage[]; redriveNote?: string; voiceCall?: boolean; joinContext?: string }): ModelMessage[] {
  const others = p.members.filter((m) => m.id !== p.me.id).map((m) => m.name);
  const lines = p.history.slice(-LIMITS.groupPromptHistory).map((m) => {
    const who = m.from === p.me.id ? `${m.fromName} (you)` : m.from === "user" ? "User" : m.fromName;
    return `${who}: ${m.text.replace(/\s+/g, " ").trim()}`;
  });
  const text = fillTemplate(loadPrompt("wakes/group-member.md"), {
    GROUP: p.groupName,
    WITH: others.join(", "),
    ME: p.me.name,
    REDRIVE: p.redriveNote ? `${p.redriveNote}\n` : "",
    HISTORY: lines.length ? lines.join("\n") : "(no new messages)",
  });
  // Voice calls: the post was spoken in a group call, so the answer is spoken too.
  // Bug 108: a Bot added mid-call gets the call so far once, ahead of its first turn.
  const join = p.joinContext ? [{ text: p.joinContext }] : [];
  if (!p.voiceCall) return [...join, { text: text.trim() }];
  // Bug 134 (item 6): on a group call a Bot can hand a part to a teammate by name, and the floor goes to them next.
  const handOff = others.length
    ? [{ text: `On this call you can hand a part of the answer to a teammate by name, e.g. "${others[0]}, can you take the calendar part?"; they speak next. Only hand off real work, never just to be polite.` }]
    : [];
  return [...join, { text: text.trim() }, { text: loadPrompt("wakes/voice-call.md").trim() }, ...handOff];
}
