import { useEffect } from "react";
import { create } from "zustand";
import { STRF } from "@synapse/shared";
import { nativeCall } from "../native";

/**
 * 👍/👎 on a Bot's replies and finished tasks, and the count in the Bot's settings. Kept in the app's
 * data folder by main (ratings.get / ratings.set). Never sent anywhere.
 */
type Rating = 1 | -1;
interface BotRatings { ratings: Record<string, Rating>; up: number; down: number }
const useRatings = create<{ byBot: Record<string, BotRatings | undefined> }>(() => ({ byBot: {} }));
const loading = new Set<string>();
/** Whatever came back, as a well-formed count (a bridge that doesn't know ratings answers something else). */
const norm = (r: Partial<BotRatings> | null | undefined): BotRatings => ({
  ratings: r?.ratings && typeof r.ratings === "object" ? r.ratings : {},
  up: Number(r?.up) || 0, down: Number(r?.down) || 0,
});

function load(botId: string): void {
  if (useRatings.getState().byBot[botId] || loading.has(botId)) return;
  loading.add(botId);
  // Deferred, so a window without the native bridge (a unit test, a preview) just shows no ratings.
  void Promise.resolve().then(() => nativeCall<BotRatings>("ratings.get", { botId })).then(
    (r) => useRatings.setState((s) => ({ byBot: { ...s.byBot, [botId]: norm(r) } })),
    () => {},
  ).finally(() => loading.delete(botId));
}

export function rate(botId: string, entryId: string, kind: "reply" | "task", value: Rating): void {
  const cur = useRatings.getState().byBot[botId]?.ratings[entryId];
  const next = cur === value ? 0 : value;
  void Promise.resolve().then(() => nativeCall<BotRatings>("ratings.set", { botId, entryId, kind, value: next })).then(
    (r) => useRatings.setState((s) => ({ byBot: { ...s.byBot, [botId]: norm(r) } })),
    () => {},
  );
}

const svg = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const Up = () => <svg {...svg}><path d="M7 11v9H4v-9h3zM7 11l4-7a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7" /></svg>;
const Down = () => <svg {...svg}><path d="M17 13V4h3v9h-3zM17 13l-4 7a2 2 0 0 1-2-2v-4H5.5a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.7 4H17" /></svg>;

export function RateButtons({ botId, entryId, kind }: { botId: string; entryId: string; kind: "reply" | "task" }) {
  useEffect(() => load(botId), [botId]);
  const cur = useRatings((s) => s.byBot[botId]?.ratings[entryId]);
  return (
    <span className={`rate${cur ? " rated" : ""}`}>
      <button type="button" className="icon-btn small rate-btn" aria-label={STRF.rateUp} aria-pressed={cur === 1} onClick={() => rate(botId, entryId, kind, 1)}><Up /></button>
      <button type="button" className="icon-btn small rate-btn" aria-label={STRF.rateDown} aria-pressed={cur === -1} onClick={() => rate(botId, entryId, kind, -1)}><Down /></button>
    </span>
  );
}

/** Bot settings: the Bot's counts. */
export function RatingsRow({ botId }: { botId: string }) {
  useEffect(() => load(botId), [botId]);
  const r = useRatings((s) => s.byBot[botId]);
  return (
    <div className="settings-row" data-setting="ratings">
      <span style={{ flexGrow: 1 }}>{STRF.ratings}</span>
      <span className="muted">{STRF.ratingsCount(r?.up ?? 0, r?.down ?? 0)}</span>
    </div>
  );
}
