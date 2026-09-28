import { LIMITS } from "@synapse/shared";
import type { OneShotModel } from "../helper-model/one-shot";
import { mentionedMembers } from "./addressing";
import type { RoomMessage } from "./member-prompt";

type Member = { id: string; name: string; description: string };
interface Scores { scores: { id: string; relevance: number; why: string }[] }

const SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, relevance: { type: "number", minimum: 0, maximum: 1 }, why: { type: "string", maxLength: 80 } },
        required: ["id", "relevance", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores"],
  additionalProperties: false,
} as const;

const msg = (m: RoomMessage) => ({ from: m.fromName, text: m.text });

export class FloorManager {
  constructor(private d: { model: OneShotModel; timeoutMs?: number }) {}

  private async score(group: string, members: Member[], recent: RoomMessage[], post: RoomMessage): Promise<Map<string, number> | null> {
    const ms = this.d.timeoutMs ?? LIMITS.floorTimeoutMs;
    try {
      const call = this.d.model.run<Scores>({
        prompt: "orig/group-floor.md",
        input: { group, members: members.map((m) => ({ id: m.id, name: m.name, description: m.description.slice(0, 300) })), recent: recent.slice(-6).map(msg), post: msg(post) },
        schema: SCHEMA,
        timeoutMs: ms,
      });
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), ms));
      const out = await Promise.race([call, timeout]);
      if (!out || !Array.isArray(out.scores)) return null;
      const known = new Set(members.map((m) => m.id));
      const map = new Map<string, number>();
      for (const s of out.scores) if (known.has(s.id) && typeof s.relevance === "number") map.set(s.id, s.relevance);
      return map;
    } catch {
      return null;
    }
  }

  async pickRound1(p: { group: string; members: Member[]; recent: RoomMessage[]; post: RoomMessage }): Promise<string[] | null> {
    const s = await this.score(p.group, p.members, p.recent, p.post);
    if (!s || s.size === 0) return null;
    const ranked = [...s.entries()].sort((a, b) => b[1] - a[1]);
    const over = ranked.filter(([, r]) => r >= LIMITS.floorRelevance).slice(0, LIMITS.floorRound1Max).map(([id]) => id);
    return over.length ? over : [ranked[0]![0]];
  }

  async pickLater(p: { group: string; members: Member[]; roundMessages: RoomMessage[] }): Promise<string[] | null> {
    if (!p.roundMessages.length) return [];
    const authors = new Set(p.roundMessages.map((m) => m.from));
    const named: string[] = [];
    for (const m of p.roundMessages) {
      const hit = mentionedMembers(m.text, p.members.filter((x) => x.id !== m.from));
      if (hit !== "all") for (const id of hit) if (!authors.has(id) && !named.includes(id)) named.push(id);
    }
    const last = p.roundMessages[p.roundMessages.length - 1]!;
    const s = await this.score(p.group, p.members, p.roundMessages.slice(0, -1), last);
    if (!s) return named.length ? named.slice(0, LIMITS.floorLaterMax) : null;
    const scored = [...s.entries()].filter(([id, r]) => r >= LIMITS.floorRelevance && !authors.has(id) && !named.includes(id)).sort((a, b) => b[1] - a[1]).map(([id]) => id);
    return [...named, ...scored].slice(0, LIMITS.floorLaterMax);
  }
}
