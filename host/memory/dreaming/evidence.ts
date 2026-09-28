import { LIMITS5 } from "@synapse/shared";
import { isMemorable } from "../extractor";

/** MEM-06's memorability test, reused by dreaming. */
export { isMemorable };

const side = (s: string) => (s.length <= LIMITS5.dreamSideChars ? s : `${s.slice(0, LIMITS5.dreamSideChars / 2)} … ${s.slice(-LIMITS5.dreamSideChars / 2)}`);

export class EvidenceQueue {
  private q = new Map<string, { id: string; occurredAt: number; user: string; assistant: string }[]>();
  private seq = 0;

  add(botId: string, e: { user: string; assistant: string; occurredAt: number }): void {
    const list = this.q.get(botId) ?? [];
    list.push({ id: `e${++this.seq}`, occurredAt: e.occurredAt, user: side(e.user), assistant: side(e.assistant) });
    this.q.delete(botId);
    this.q.set(botId, list.slice(-LIMITS5.dreamEvidencePerBot));
    while (this.q.size > LIMITS5.dreamBots) this.q.delete(this.q.keys().next().value!);
  }

  take(botId: string): { id: string; occurredAt: number; user: string; assistant: string }[] {
    const list = this.q.get(botId) ?? [];
    this.q.delete(botId);
    return list;
  }

  size(botId: string): number { return this.q.get(botId)?.length ?? 0; }
}
