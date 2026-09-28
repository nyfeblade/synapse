import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { STR, type SendMessageEntry, type UserMessageEntry } from "@synapse/shared";
import { call } from "../bridge";
import { useComposer } from "../composer-store";
import { copyWithConfirmation } from "../toast";
import { Menu } from "./Menus";
import "../styles/message-actions.css";

/** The toolbar's three controls, in DOM order — the roving tabindex walks this. */
const BAR = ["react", "reply", "more"] as const;

export const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

export function MessageActions({ botId, entry, text }: { botId: string; entry: UserMessageEntry | SendMessageEntry; text: string }) {
  const [picker, setPicker] = useState(false);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const react = (emoji: string) => { setPicker(false); void call("reactToMessage", { id: botId, entryId: entry.id, emoji }); };
  // The hover toolbar is hidden with CSS only, so an abandoned picker stayed open in state and popped
  // back up the next time the mouse crossed the message. Dismiss it the way the "…" menu dismisses.
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => { if (!bar.current?.contains(e.target as Node)) setPicker(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPicker(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [picker]);
  // The bar hides by paint now, not by layout, so these three are in the tab order — and three tab
  // stops per message is unusable in a long conversation (driven against the app: 21 of 45 stops).
  // `role="toolbar"` already promised the answer: ONE tab stop, arrow keys inside. The roving
  // tabindex below is that promise kept.
  const [at, setAt] = useState(0);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number | undefined> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: BAR.length - 1 };
    const next = keys[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const i = (next + BAR.length) % BAR.length;
    setAt(i);
    bar.current?.querySelectorAll<HTMLButtonElement>(":scope > .icon-btn")[i]?.focus();
  };
  return (
    <div ref={bar} className="msg-actions" role="toolbar" aria-label="Message actions" onKeyDown={onKeyDown}>
      <button type="button" tabIndex={at === 0 ? 0 : -1} className="icon-btn small" aria-label={STR.react} onClick={() => setPicker((p) => !p)} onFocus={() => setAt(0)}>☺</button>
      <button type="button" tabIndex={at === 1 ? 0 : -1} className="icon-btn small" aria-label={STR.reply} onClick={() => useComposer.getState().setReplyTo(botId, entry.id)} onFocus={() => setAt(1)}>↩</button>
      <button type="button" tabIndex={at === 2 ? 0 : -1} className="icon-btn small" aria-label={STR.moreMessageActions} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMore({ x: r.left, y: r.bottom + 4 }); }} onFocus={() => setAt(2)}>…</button>
      {picker && (
        <div className="emoji-pop">
          {QUICK_EMOJI.map((e) => <button key={e} type="button" className="icon-btn small" aria-label={`React ${e}`} onClick={() => react(e)}>{e}</button>)}
        </div>
      )}
      {more && (
        <Menu label={STR.moreMessageActions} x={more.x} y={more.y} onClose={() => setMore(null)} items={[
          { label: STR.copy, onSelect: () => void copyWithConfirmation(text) },
          { label: STR.copyText, onSelect: () => void copyWithConfirmation(text.replace(/[*_`#>~]/g, "")) },
          ...("requestId" in entry ? [{ label: STR.copyRequestId, onSelect: () => void copyWithConfirmation(entry.requestId) }] : []),
        ]} />
      )}
    </div>
  );
}
