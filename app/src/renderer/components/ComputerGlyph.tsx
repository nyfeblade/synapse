import { LIMITSC, STRC } from "@synapse/shared";
import { useEffect, useState } from "react";
import { useComputer } from "../computer-state";
import { DisplayIcon } from "./Icons";

/** CMP-06 (1): monitor glyph in the chat header, full ink while there was activity in the last 5 s. */
export function ComputerGlyph({ botId }: { botId: string }) {
  const last = useComputer((s) => s.activity[botId] ?? 0);
  const openComputer = useComputer((s) => s.openComputer);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!last) return;
    setNow(Date.now());
    const t = setTimeout(() => setNow(Date.now()), LIMITSC.glyphActiveMs + 50);
    return () => clearTimeout(t);
  }, [last]);
  const active = last > 0 && now - last < LIMITSC.glyphActiveMs;
  return (
    <button type="button" className={`icon-btn computer-glyph${active ? " active" : ""}`} aria-label={STRC.computerGlyph} onClick={() => openComputer(botId)}>
      <DisplayIcon />
    </button>
  );
}
