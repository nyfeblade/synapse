import { STR_COST } from "@synapse/shared";
import { openUsageFor } from "../usage/dashboard-store";
import { useSpendMeter } from "../usage/meter-store";

/**
 * 5.7: the header's spend meter. A number in neutral grey (today's or this month's API spend, from the same totals as
 * Usage, moving live while a turn runs); the warning colour only near the monthly budget. While this chat's Bot is
 * working, what its turn has cost so far rides beside it. Opens Usage.
 */
export function SpendMeter({ botId }: { botId: string }) {
  const view = useSpendMeter((s) => s.view);
  if (!view || view.mode === "off") return null;
  const label = view.mode === "month" ? STR_COST.meterMonth : STR_COST.meterToday;
  const total = view.mode === "month" ? view.monthUsd : view.todayUsd;
  const turn = view.turns[botId];
  const name = [`${label} ${STR_COST.money(total)}`, turn !== undefined ? `${STR_COST.meterTurn} ${STR_COST.money(turn)}` : ""].filter(Boolean).join(", ");
  return (
    <button type="button" className={`spend-meter${view.warn ? " warn" : ""}`} aria-label={name} title={name} onClick={() => openUsageFor(null)}>
      <span className="spend-meter-label">{label}</span>
      <span className="spend-meter-value">{STR_COST.money(total)}</span>
      {turn !== undefined && (
        <>
          <span className="spend-meter-sep" aria-hidden="true" />
          <span className="spend-meter-label">{STR_COST.meterTurn}</span>
          <span className="spend-meter-value">{STR_COST.money(turn)}</span>
        </>
      )}
    </button>
  );
}
