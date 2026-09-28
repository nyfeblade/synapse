import { STR, type RoutineView } from "@synapse/shared";

/** C4: plain English on the row; the raw expression (CRON_TZ=…) is the tooltip. */
export function ScheduleLabel({ routine }: { routine: RoutineView }) {
  return (
    <span className="routine-when" title={routine.scheduleRaw ?? undefined}>
      {routine.enabled ? routine.description : STR.paused}
    </span>
  );
}
