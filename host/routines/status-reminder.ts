import { LIMITS } from "@synapse/shared";
import type { PromptDecorator } from "../runner/turn-runner";
import { PROBLEM_RUN_PREFIX } from "./routine-health";
import { formatWhen } from "./routine-turn";
import type { RoutineStore } from "./routine-store";

const HEADER = "Routine status as of now. Trust this snapshot over any earlier status and over your own recollection of it.";
const wrap = (body: string) => `<system_reminder><automation_status>\n${body}\n</automation_status></system_reminder>`;

const GUIDANCE = [
  "Routine guidance:",
  "- A routine runs as a hidden [routine] turn in this conversation. The user sees only what you post with SendMessage.",
  "- Before creating a routine, confirm with the user: who it is for, the schedule and time zone, where the input comes from, the result they expect, what needs their approval, and what to do if the source is missing. Then create it with update_state target \"routine\" action \"create\" and tell the user its next run.",
  "- When the user asks for the same thing repeatedly, offer to make it a routine.",
  "- A watch with no end date the user named lasts 7 days; after that, delete it and tell the user.",
  "- Temporary watchers delete themselves (action \"delete\") as soon as their condition is met.",
  "- If a run fails because a sign-in or permission is missing, pause the routine (action \"pause\") and tell the user once instead of failing every run.",
  "- You can only manage your own routines. Ask another Bot to change its routines.",
].join("\n");

/** RTN-21 / EVT-12: the authoritative snapshot, sent only when it changed or after compaction; "No current routines." once. */
export class StatusReminder {
  private lastSent = new Map<string, string>();

  constructor(private d: { store: RoutineStore; nextRunAt(botId: string, id: string): number | null; botTz(botId: string): string; now(): number }) {}

  private lines(botId: string): string[] {
    const tz = this.d.botTz(botId);
    return this.d.store.list(botId).slice(0, LIMITS.routinesInPrompt).map((r) => {
      const who = `- "${r.def.name}" (id ${r.id}): `;
      const last = this.d.store.runs(botId, r.id)[0];
      // Bug 44(a): a routine the HOST turned off because it could never run must not read to the Bot
      // like one the user paused — it would helpfully switch it back on, unfixed.
      const turnedOff = last?.id.startsWith(PROBLEM_RUN_PREFIX) ? last.detail : null;
      if (!r.def.enabled) return `${who}${turnedOff || "paused"}`;
      if (last?.status === "running") return `${who}running now`;
      const next = this.d.nextRunAt(botId, r.id);
      const nextText = next === null ? "runs when its trigger fires" : `next run ${formatWhen(next, tz)}`;
      const lastText = last ? `last run ${formatWhen(last.startedAt, tz)} (${last.status === "ok" ? "succeeded" : "failed"})` : "never run";
      return `${who}${nextText}; ${lastText}`;
    });
  }

  decorate: PromptDecorator = (botId) => {
    const lines = this.lines(botId);
    const prev = this.lastSent.get(botId);
    if (!lines.length) {
      if (prev === undefined || prev === "") return null;
      this.lastSent.set(botId, "");
      return { text: wrap("No current routines.") };
    }
    const body = `${HEADER}\n${lines.join("\n")}`;
    if (prev === body) return null;
    this.lastSent.set(botId, body);
    return { text: wrap(body) };
  };

  markCompacted(botId: string): void {
    this.lastSent.delete(botId);
  }

  /** The system-prompt part of RTN-21: ≤ 100 routines plus the guidance. */
  systemSection(botId: string): string {
    const list = this.d.store.list(botId).slice(0, LIMITS.routinesInPrompt).map((r) => `- "${r.def.name}" (id ${r.id})${r.def.enabled ? "" : " — paused"}`);
    return `Your routines:\n${list.length ? list.join("\n") : "(none)"}\n\n${GUIDANCE}`;
  }
}
