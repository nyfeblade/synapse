import { useEffect, useMemo, useRef, useState } from "react";
import { LIMITS5, STR5, type BotSummary } from "@synapse/shared";
import { PlusIcon } from "../components/Icons";
import { ShapeAvatar } from "../components/ShapeAvatar";

/** Bug 108: the Bots the user can add to a call — real Bots (no groups, none archived) not on it yet. */
export function eligibleForCall(bots: Record<string, BotSummary>, onCall: string[]): BotSummary[] {
  return Object.values(bots).filter((b) => !b.group && !b.archived && !onCall.includes(b.id));
}

/**
 * The call screen's "Add Bot" control: a + next to the avatar row that opens a dropdown of the Bots
 * not on the call (avatar + name), type-to-filter, arrow keys + Enter, Escape closes the dropdown
 * only (never the call). At LIMITS5.callMaxBots it is disabled: "Up to 6 Bots on a call".
 */
export function CallAddMenu({ bots, onCall, onPick }: { bots: Record<string, BotSummary>; onCall: string[]; onPick(botId: string): void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const full = onCall.length >= LIMITS5.callMaxBots;
  const all = useMemo(() => eligibleForCall(bots, onCall), [bots, onCall]);
  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((b) => b.profile.name.toLowerCase().includes(q)) : all;
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { if (full) setOpen(false); }, [full]);
  if (!all.length && !full) return null;
  const close = () => { setOpen(false); setQuery(""); button.current?.focus(); };
  const pick = (id: string) => { close(); onPick(id); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && shown[active]) { e.preventDefault(); pick(shown[active]!.id); }
  };
  return (
    <div className="call-add-wrap">
      {/* A disabled button shows no tooltip in Chromium, so the reason sits on its wrapper. */}
      <span title={full ? STR5.callFull : STR5.callAddBot}>
        <button ref={button} type="button" className="round-btn call-add" aria-label={STR5.callAddBot} aria-haspopup="menu" aria-expanded={open}
          title={full ? STR5.callFull : STR5.callAddBot} disabled={full} onClick={() => setOpen((o) => !o)}><PlusIcon /></button>
      </span>
      {open && (
        <div className="call-add-menu" onKeyDown={onKey}>
          <input ref={input} className="call-add-filter" type="text" placeholder={STR5.callAddFilter} aria-label={STR5.callAddFilter}
            aria-controls="call-add-list" aria-activedescendant={shown[active] ? `call-add-${shown[active]!.id}` : undefined}
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <div id="call-add-list" role="menu" aria-label={STR5.callAddBot}>
            {shown.length === 0 && <span className="call-add-empty">{STR5.callNoOtherBots}</span>}
            {shown.map((b, i) => (
              <button key={b.id} id={`call-add-${b.id}`} type="button" role="menuitem" className="call-add-item" data-active={i === active}
                aria-label={b.profile.name} onMouseEnter={() => setActive(i)} onClick={() => pick(b.id)}>
                <span aria-hidden="true"><ShapeAvatar shape={b.profile.avatarShape} color={b.profile.avatarColor} size={20} /></span>
                <span>{b.profile.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
