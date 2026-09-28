import { useState } from "react";
import { STR } from "@synapse/shared";
import { isFanOut, type TranscriptItem } from "../transcript-items";
import { ExchangeMessageList, ExchangeToggle } from "./ExchangeShared";

/** CHAT-04 collapsed block: "N messages with [avatars] Scout | N Bots", or "Messaged [avatars] N Bots" for a fan-out (B2B-02). Click expands inline. */
export function ExchangeBlock({ item }: { item: Extract<TranscriptItem, { kind: "exchange" }> }) {
  const [open, setOpen] = useState(false);
  const fan = isFanOut(item.entries);
  const ids = fan ? item.entries.map((e) => e.toAgent!.id) : item.peers.map((p) => p.id);
  const label = ids.length === 1 ? (item.peers.find((p) => p.id === ids[0])?.name ?? "") : STR.nBots(ids.length);
  return (
    <div className="exchange">
      <ExchangeToggle countLabel={fan ? STR.messaged : STR.messagesWith(item.count)} ids={ids} whoLabel={label} open={open} onToggle={() => setOpen(!open)} />
      {open && <ExchangeMessageList entries={item.entries} />}
    </div>
  );
}
