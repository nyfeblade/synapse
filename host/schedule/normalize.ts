import { STR } from "@synapse/shared";
import type { OneShotModel } from "../helper-model/one-shot";
import { formatTime } from "./cron";
import { parseEnglish, whyFor } from "./english";
import { describeSchedule, effectiveZone, nextRuns, parseSchedule, rawSchedule } from "./schedule";
import { checkSpacing } from "./spacing";
import { ScheduleError, type ParsedSchedule } from "./types";
import { localParts } from "./zone";

export interface NormalizedSchedule { schedule: string; parsed: ParsedSchedule; description: string; raw: string; nextRuns: number[]; tz: string }

interface ModelOut { schedule: string; timezone: string | null; confidence: number; ambiguity: string | null }
const MODEL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    schedule: { type: "string" },
    timezone: { type: ["string", "null"] },
    confidence: { type: "number" },
    ambiguity: { type: ["string", "null"] },
  },
  required: ["schedule", "timezone", "confidence", "ambiguity"],
  additionalProperties: false,
};
const MODEL_TIMEOUT_MS = 15_000;
const MIN_CONFIDENCE = 0.8;
const FIELD = String.raw`(?:[\d*][\d*,/-]*|[A-Za-z]{3}(?:[-,][A-Za-z]{3})*)`;
const MACHINE = new RegExp(String.raw`^(?:(?:CRON_TZ|TZ)=\S+\s+)?(?:@|RRULE:|${FIELD}(?:\s+${FIELD}){4}$)`, "i");
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const invalid = () => new ScheduleError(STR.scheduleInvalid);

async function viaModel(text: string, o: { tz: string; nowMs: number; model: OneShotModel | null }): Promise<string> {
  if (!o.model) throw invalid();
  const l = localParts(o.nowMs, o.tz);
  const today = `${l.y}-${String(l.mo).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
  let out: ModelOut;
  try {
    out = await o.model.run<ModelOut>({ prompt: "orig/schedule-parser.md", vars: { today, tz: o.tz }, input: { text, today, tz: o.tz }, schema: MODEL_SCHEMA, timeoutMs: MODEL_TIMEOUT_MS });
  } catch {
    throw invalid();
  }
  if (out.ambiguity) throw new ScheduleError(STR.scheduleAmbiguous(text, whyFor(out.ambiguity), out.ambiguity));
  if (typeof out.schedule !== "string" || typeof out.confidence !== "number" || out.confidence < MIN_CONFIDENCE) throw invalid();
  const s = out.schedule.trim();
  const zoned = out.timezone && !/^(?:CRON_TZ|TZ)=/i.test(s) && !s.startsWith("@every") ? `CRON_TZ=${out.timezone} ${s}` : s;
  try {
    parseSchedule(zoned, { tz: o.tz, nowMs: o.nowMs });
  } catch {
    throw invalid();
  }
  return zoned;
}

/**
 * ORIG-03 §03.1: accepts cron, alias, @every, RRULE: or English; returns the stored form, the description, the raw
 * tooltip form (C4) and the next three runs. Throws ScheduleError with the exact RTN-06 / §03.1 messages; saves nothing.
 */
export async function normalizeSchedule(input: string, o: { tz: string; nowMs: number; model: OneShotModel | null }): Promise<NormalizedSchedule> {
  const text = input.trim().replace(/\s+/g, " ");
  if (!text) throw invalid();
  let candidate: string;
  if (MACHINE.test(text)) candidate = text;
  else {
    const g = parseEnglish(text, { tz: o.tz, nowMs: o.nowMs });
    if (g && "ambiguity" in g) throw new ScheduleError(STR.scheduleAmbiguous(text, whyFor(g.ambiguity), g.ambiguity));
    candidate = g ? g.schedule : await viaModel(text, o);
  }
  const parsed = parseSchedule(candidate, { tz: o.tz, nowMs: o.nowMs });
  checkSpacing(parsed, o.tz, o.nowMs);
  const runs = nextRuns(parsed, o.nowMs, o.tz, 3);
  if (!runs.length) throw invalid();
  if (parsed.kind === "once" && parsed.atMs <= o.nowMs) throw invalid();
  const schedule = (parsed.kind === "cron" || parsed.kind === "rrule") && parsed.tz ? `CRON_TZ=${parsed.tz} ${parsed.expr}` : parsed.expr;
  return { schedule, parsed, description: describeSchedule(parsed, o.tz), raw: rawSchedule(parsed, o.tz), nextRuns: runs, tz: effectiveZone(parsed, o.tz) };
}

/** The update_state tool result block of ORIG-03 §03.1. */
export function formatSavedResult(name: string, enabled: boolean, n: NormalizedSchedule): string {
  const zone = ` (${n.tz})`;
  const runs = n.description.endsWith(zone) ? n.description : `${n.description}${zone}`;
  const next = n.nextRuns
    .map((ms) => {
      const l = localParts(ms, n.tz);
      return `${WD[l.dow]} ${MON[l.mo - 1]} ${l.d} ${formatTime(l.h, l.mi)}`;
    })
    .join(" · ");
  return [
    `Saved routine "${name}" (${enabled ? "active" : "paused"}).`,
    `Schedule: ${n.schedule.replace(/;X-DTSTART=[^;\s]*/, "")}`,
    `Runs: ${runs}`,
    `Next runs: ${next}`,
  ].join("\n");
}
