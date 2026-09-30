import { useState } from "react";
import { STR5 } from "@synapse/shared";
import { call } from "../../bridge";
import { acceptAgent, useUi } from "../../store";
import { newFlag } from "../../is-new";
import { registerCard, type CardProps } from "./registry";

export function EngineeringOfferCard({ botId, card, isNew = false }: CardProps) {
  if (card.kind !== "engineering-offer") return null;
  const on = useUi((s) => s.bots[botId]?.settings.engineeringMode === true);
  const [settled, setSettled] = useState<"on" | "declined" | null>(null);
  const flip = (enabled: boolean) => {
    setSettled(enabled ? "on" : "declined");
    void call("setAgentEngineeringMode", { id: botId, enabled })
      .then((r) => acceptAgent(r.agent));
  };
  const done = on || settled === "on";
  return (
    <section className={`card-primitive${newFlag(isNew)}`} aria-label={STR5.engineeringOfferTitle}>
      <div className="card-title">{STR5.engineeringOfferTitle}</div>
      <p className="muted">{STR5.engineeringOfferBody}</p>
      {done ? <p className="muted">{STR5.engineeringMode}</p> : settled === "declined" ? <p className="muted">{STR5.notNow}</p> : (
        <div className="card-actions">
          <button type="button" className="btn-secondary" onClick={() => flip(false)}>{STR5.notNow}</button>
          <button type="button" className="btn-primary" onClick={() => flip(true)}>{STR5.turnOnEngineering}</button>
        </div>
      )}
    </section>
  );
}

registerCard("engineering-offer", EngineeringOfferCard);
