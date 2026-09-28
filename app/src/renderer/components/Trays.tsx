import { STR } from "@synapse/shared";
import { call } from "../bridge";
import { useGoogle } from "../google/store";
import { newFlag, useIsNew } from "../is-new";
import { copyWithConfirmation } from "../toast";
import { useUi } from "../store";
import { CloseIcon } from "./Icons";

export function Trays({ botId }: { botId: string }) {
  const allTrays = useUi((s) => s.trays);
  const trays = allTrays.filter((t) => t.botId === botId || t.botId === null);
  // Motion-spec §3.1/§5.2: only a tray that arrived while we were watching plays its entrance.
  // The reset key is constant because .trays is one list for the whole session, not per Bot.
  const { isNew } = useIsNew("trays", trays.map((t) => t.id));
  if (!trays.length) return null;
  return (
    <section className="trays" aria-label={STR.notifications}>
      <div className="trays-head"><span>{STR.notifications}</span><button type="button" className="link-btn" onClick={() => { for (const t of trays) void call("dismissTray", { trayId: t.id }); }}>{STR.clear}</button></div>
      {trays.map((t) => (
        <div key={t.id} className={`tray${newFlag(isNew(t.id))}`}>
          <div className="tray-text"><span className="tray-title">{t.title}{t.count > 1 ? ` (${t.count})` : ""}</span>{t.detail && <span className="tray-detail">{t.detail}</span>}</div>
          {t.buttons.map((b) => <button key={b.label} type="button" className="btn-outline small" onClick={() => {
            // ORIG-GOOGLE: "Reconnect Google" opens the Connect Google sheet; the notification goes away.
            if (b.action === "reconnect-google") useGoogle.getState().openSheet();
            // The button's own action has to reach the host, or "Resume routines" just hides the notice.
            const forward = b.action === "retry" || b.action === "resume-routines" ? { action: b.action } : {};
            void call("dismissTray", { trayId: t.id, ...forward });
          }}>{b.label}</button>)}
          {t.requestId && <button type="button" className="icon-btn" aria-label={STR.copyRequestId} onClick={() => void copyWithConfirmation(t.requestId as string)}>#</button>}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => void call("dismissTray", { trayId: t.id })}><CloseIcon /></button>
        </div>
      ))}
    </section>
  );
}
