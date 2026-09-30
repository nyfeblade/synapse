import { STR } from "@synapse/shared";
import { unhideBot } from "../bot-actions";
import { useOverlays } from "../overlays";
import { useUi } from "../store";
import "../styles/bot-admin.css";
import { Dialog } from "./Dialog";
import { EmptyView } from "./EmptyView";
import { CloseIcon } from "./Icons";
import { ShapeAvatar } from "./ShapeAvatar";

export function HiddenBotsDialog() {
  const close = useOverlays((s) => s.close);
  const botMap = useUi((s) => s.bots); // zustand 5: select the stable map, derive the list outside the selector
  const hidden = Object.values(botMap).filter((b) => b.settings.hiddenFromSidebar);
  return (
    <Dialog label={STR.hiddenBots} onClose={close} className="modal small">
      <>
        <header className="modal-head"><h2>{STR.hiddenBots}</h2><button type="button" className="icon-btn" aria-label={STR.close} onClick={close}><CloseIcon /></button></header>
        {/* UI-controls pass (2026-09-29): with nothing hidden this was a title over blank space. */}
        {hidden.length === 0 ? <EmptyView title={STR.noHiddenBots} size="inline" /> : null}
        <ul className="plain-list">
          {hidden.map((b) => (
            <li key={b.id} className="list-row">
              <ShapeAvatar shape={b.profile.avatarShape} color={b.profile.avatarColor} size={28} />
              <span className="grow ellipsis" style={{ minWidth: 0 }} title={b.profile.name}>{b.profile.name}</span>
              <button type="button" className="btn-outline" aria-label={`${STR.unhide} ${b.profile.name}`} onClick={() => void unhideBot(b.id)}>{STR.unhide}</button>
            </li>
          ))}
        </ul>
      </>
    </Dialog>
  );
}
