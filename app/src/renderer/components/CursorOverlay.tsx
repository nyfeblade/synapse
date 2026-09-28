import { LIMITSC } from "@synapse/shared";
import { useEffect, useState } from "react";
import { useComputer } from "../computer-state";

/** CMP-07/CMP-18: the Bot's synthetic cursor, labelled with its name; clicks "press" after max(0, 500 − msSinceMove). */
export function CursorOverlay({ botId, label, scale }: { botId: string; label: string; scale: number }) {
  const c = useComputer((s) => s.cursor[botId]);
  const [pressed, setPressed] = useState(false);
  const [lastMoveAt, setLastMoveAt] = useState(0);
  useEffect(() => {
    if (!c) return;
    if (c.kind !== "click" && c.kind !== "drag") {
      setLastMoveAt(c.at);
      return;
    }
    const delay = Math.max(0, LIMITSC.cursorPressDelayMs - (c.at - lastMoveAt));
    const t1 = setTimeout(() => setPressed(true), delay);
    const t2 = setTimeout(() => setPressed(false), delay + 180);
    setLastMoveAt(c.at);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.at]);
  if (!c) return null;
  return (
    // Positioned with translate() rather than left/top so the glide animates a compositor property
    // instead of a layout one. `.bot-cursor` pins left/top to 0, so `left:0;top:0` + translate(x,y)
    // puts the box on exactly the pixel `left:x;top:y` did.
    <span className={`bot-cursor${pressed ? " pressed" : ""}`} style={{ transform: `translate(${c.x * scale}px, ${c.y * scale}px)` }} aria-hidden="true">
      <svg width="14" height="18" viewBox="0 0 14 18">
        <path d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L12 10 Z" fill="#0C0C0C" stroke="#FFFFFF" strokeWidth="1" />
      </svg>
      <span className="cursor-label">{label}</span>
    </span>
  );
}
