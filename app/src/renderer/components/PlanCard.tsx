import { useMemo } from "react";
import { STRL, type ToolCallEntry, type TranscriptEntry } from "@synapse/shared";
import { CheckIcon } from "./Icons";
import { useUi } from "../store";

const EMPTY: TranscriptEntry[] = [];
/** Enough to read at a glance in a 320px column; the whole run is in the transcript's steps card. */
const MOST = 6;

/** m:ss, the way the look study's plan draws a step's time. */
function took(s: ToolCallEntry): string {
  if (s.status === "running") return STRL.planNow;
  if (s.endedAt === undefined) return "";
  const secs = Math.max(0, Math.round((s.endedAt - s.startedAt) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/**
 * PLAN — the open run, step by step: what this Bot has done, what it is doing now, and how far
 * through it is. Read from the transcript the app already holds (the newest segment of tool calls,
 * the same steps the conversation's steps card expands), so it never asks the host for anything and
 * never claims a plan the run does not have.
 */
export function PlanCard({ botId }: { botId: string }) {
  const entries = useUi((s) => s.transcripts[botId] ?? EMPTY);
  const steps = useMemo(() => {
    const calls = entries.filter((e): e is ToolCallEntry => e.kind === "tool-call" && !e.hidden);
    const last = calls.at(-1);
    if (!last) return [];
    return calls.filter((c) => c.segmentId === last.segmentId).slice(-MOST);
  }, [entries]);
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <section className="pcard" aria-label={STRL.plan}>
      <h3 className="pcard-head">
        {STRL.plan}
        {steps.length > 0 && <span className="pcard-meta">{STRL.planProgress(done, steps.length)}</span>}
      </h3>
      <div className="pcard-body">
        {steps.length === 0 ? (
          <span className="pcard-empty">{STRL.planEmpty}</span>
        ) : (
          <>
            <ul className="plan-list">
              {steps.map((s) => {
                const state = s.status === "done" ? "done" : s.status === "running" ? "now" : "todo";
                return (
                  <li key={s.id} className={`plan-item ${state}`}>
                    <span className="plan-mark" aria-hidden="true">{state === "done" && <CheckIcon size={9} />}</span>
                    <span title={s.step}>{s.step}</span>
                    <span className="plan-time">{took(s)}</span>
                  </li>
                );
              })}
            </ul>
            <div className="plan-progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label={STRL.plan}>
              <i style={{ transform: `scaleX(${done / steps.length})` }} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
