import type { ToolCall } from "../brain/types";
import type { TurnSlot } from "../runner/turn-slot";

/** ORIG-08 §08.3: children launched with `rehearsal: true`; their reviewed actions are denied at tier ≥ 2 or on any floor hit. */
export class RehearsalRegistry {
  private byChild = new Map<string, string>(); // childTaskId → botId

  start(botId: string, childTaskId: string): void {
    this.byChild.set(childTaskId, botId);
  }
  end(childTaskId: string): void {
    this.byChild.delete(childTaskId);
  }
  active(botId: string, call: ToolCall, slot: TurnSlot | null): boolean {
    if (slot?.context.rehearsal) return true;
    return call.childTaskId !== undefined && this.byChild.get(call.childTaskId) === botId;
  }
}
