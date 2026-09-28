import { STRV } from "@synapse/shared";
import { HandIcon } from "../components/Icons";

/**
 * Bug 134 (item 7): a Bot that wants to add something while another speaks raises a hand on its avatar
 * instead of talking. Clicking it (or saying "go ahead, <name>") gives it the floor; it goes down by
 * itself after 20 seconds.
 */
export function RaisedHand({ name, onGoAhead }: { name: string; onGoAhead(): void }) {
  return (
    <button type="button" className="raised-hand" aria-label={`${STRV.handRaised(name)}. ${STRV.goAheadBot(name)}`} title={STRV.goAheadBot(name)} onClick={onGoAhead}>
      <HandIcon />
    </button>
  );
}

/** "Which Bot?": the voice command named more than one (e.g. "call Sam" with two Sams). */
export function CallPicker({ kind, options, onPick, onDismiss }: { kind: "add" | "remove"; options: { id: string; name: string }[]; onPick(id: string): void; onDismiss(): void }) {
  return (
    <div className="call-picker" role="group" aria-label={kind === "add" ? STRV.pickBotToAdd : STRV.pickBotToRemove}>
      <span className="call-picker-label">{kind === "add" ? STRV.pickBotToAdd : STRV.pickBotToRemove}</span>
      {options.map((o) => <button key={o.id} type="button" className="btn-outline small" onClick={() => onPick(o.id)}>{o.name}</button>)}
      <button type="button" className="link-btn" onClick={onDismiss}>{STRV.neverMind}</button>
    </div>
  );
}
