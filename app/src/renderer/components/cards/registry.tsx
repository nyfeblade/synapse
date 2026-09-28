import type { ComponentType } from "react";
import type { CardPayload } from "@synapse/shared";

/** `isNew` gates the card's entrance animation: set only for a card that arrived while the
 *  transcript was on screen, never for one that hydrated with it (motion-spec §3.1, §5.1). */
export type CardProps = { botId: string; entryId: string; card: CardPayload; isNew?: boolean };
const registry = new Map<CardPayload["kind"], ComponentType<CardProps>>();

export function registerCard(kind: CardPayload["kind"], C: ComponentType<CardProps>): void {
  registry.set(kind, C);
}

export function CardView(p: CardProps) {
  const C = registry.get(p.card.kind);
  return C ? <C {...p} /> : null;
}
