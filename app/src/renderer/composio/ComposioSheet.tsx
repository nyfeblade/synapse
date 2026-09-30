import { useMemo, useState } from "react";
import { COMPOSIO_DASHBOARD_URL, STR5, STRX, type ComposioAccountView, type ComposioAppView } from "@synapse/shared";
import { Dialog } from "../components/Dialog";
import { nativeCall } from "../native";
import { useUi } from "../store";
import { useComposio, useComposioSync } from "./store";

function useBotList(): { id: string; name: string }[] {
  const bots = useUi((s) => s.bots);
  return useMemo(() => Object.values(bots).map((b) => ({ id: b.id, name: b.profile.name })).sort((a, b) => a.name.localeCompare(b.name)), [bots]);
}

/** Per-Bot grants for one connected account (default none). */
function BotGrants({ app, account }: { app: ComposioAppView; account: ComposioAccountView }) {
  const bots = useBotList();
  const setGrant = useComposio((s) => s.setGrant);
  const title = app.accounts.length > 1 ? account.label : app.name;
  return (
    <div className="composio-grants" role="group" aria-label={`${STRX.bots}: ${title}`}>
      {bots.map((b) => {
        const on = account.bots.includes(b.id);
        return (
          <div key={b.id} className="settings-row" data-bot={b.id}>
            <span className="grow">{b.name}</span>
            <button type="button" role="switch" aria-checked={on} aria-label={`${title}: ${b.name}`} className={on ? "switch on" : "switch"} onClick={() => void setGrant(app.toolkit, b.id, !on, account.id)} />
          </div>
        );
      })}
    </div>
  );
}

/** 4.3b: the account's name (the MCP account-label row's style). */
function RenameRow({ app, account }: { app: ComposioAppView; account: ComposioAccountView }) {
  const rename = useComposio((s) => s.rename);
  const [label, setLabel] = useState(account.label);
  const id = `cx-label-${account.id}`;
  return (
    <div className="settings-row">
      <label htmlFor={id}>{STR5.accountLabel}</label>
      <input id={id} className="text-input narrow" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button type="button" className="btn-outline small" disabled={!label.trim() || label.trim() === account.label} aria-label={`${STR5.rename} ${account.label}`} onClick={() => void rename(app.toolkit, account.id, label.trim())}>{STR5.rename}</button>
    </div>
  );
}

/** 4.3b: one account of an app: its name, its Bots, Remove (or its sign-in while it isn't connected yet). */
function AccountRow({ app, account, many }: { app: ComposioAppView; account: ComposioAccountView; many: boolean }) {
  const { busy, connect, reopen, disconnect } = useComposio();
  // Ask on connect: a newly connected account with no Bots yet opens its Bot list.
  const [showBots, setShowBots] = useState(false);
  const expanded = account.state === "connected" && (showBots || account.bots.length === 0);
  const label = many ? account.label : app.name;
  return (
    <div className="composio-account" data-account={account.id}>
      <div className={many ? "settings-row account-row" : "settings-row"}>
        <span className="grow composio-app-name">{label}</span>
        {account.state === "waiting" && (
          <span className="pill-wait"><span className="muted">{STRX.waiting}</span>
            <button type="button" className="link-btn" onClick={() => reopen(app.toolkit)}>{STRX.reopen}</button></span>
        )}
        {account.state === "failed" && (
          <span className="mkt-action"><span className="mkt-status error">{account.error ?? STRX.failed}</span>
            <button type="button" className="pill" disabled={!!busy} aria-label={`${STRX.retry} ${label}`} onClick={() => void connect(app.toolkit)}>{STRX.retry}</button></span>
        )}
        {account.state === "connected" && (
          <span className="mkt-action">
            <button type="button" className="link-btn" aria-expanded={expanded} onClick={() => setShowBots((v) => !v)}>{account.bots.length ? STRX.botCount(account.bots.length) : STRX.noBots}</button>
            {!many && <span className="mkt-status">{STRX.connected}</span>}
            {!many && <button type="button" className="link-btn" disabled={!!busy} aria-label={`${STRX.addAccount} ${app.name}`} onClick={() => void connect(app.toolkit)}>{STRX.addAccount}</button>}
            <button type="button" className="btn-outline" disabled={busy === app.toolkit} aria-label={`${many ? STRX.remove : STRX.disconnect} ${label}`} onClick={() => void disconnect(app.toolkit, account.id)}>{many ? STRX.remove : STRX.disconnect}</button>
          </span>
        )}
      </div>
      {expanded && <div className="composio-grants"><RenameRow app={app} account={account} /></div>}
      {expanded && <BotGrants app={app} account={account} />}
    </div>
  );
}

function AppRow({ app }: { app: ComposioAppView }) {
  const { busy, connect } = useComposio();
  const accounts = app.accounts ?? [];
  const many = accounts.length > 1;
  if (!accounts.length) {
    return (
      <div className="composio-app" data-toolkit={app.toolkit}>
        <div className="settings-row">
          <span className="grow composio-app-name">{app.name}</span>
          <button type="button" className="pill" disabled={!!busy} aria-label={`${STRX.connect} ${app.name}`} onClick={() => void connect(app.toolkit)}>{STRX.connect}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="composio-app" data-toolkit={app.toolkit}>
      {many && (
        <div className="settings-row">
          <span className="grow composio-app-name">{app.name}</span>
          <button type="button" className="link-btn" disabled={!!busy} aria-label={`${STRX.addAccount} ${app.name}`} onClick={() => void connect(app.toolkit)}>{STRX.addAccount}</button>
        </div>
      )}
      {accounts.map((a) => <AccountRow key={a.id} app={app} account={a} many={many} />)}
    </div>
  );
}

/** The four-step key walkthrough. Labels only; the key itself never reaches this window. */
function KeySteps() {
  const { busy, error, pasteKey } = useComposio();
  const checking = busy === "key";
  return (
    <ol className="composio-steps" aria-label={STRX.sheetTitle}>
      <li>
        <span className="composio-step-label">{STRX.step1}</span>
        <button type="button" className="btn-outline" onClick={() => void nativeCall("openExternal", { url: COMPOSIO_DASHBOARD_URL }).catch(() => {})}>{STRX.step1Button}</button>
      </li>
      <li>
        <span className="composio-step-label">{STRX.step2}</span>
        <ul className="composio-substeps">{STRX.step2Items.map((s) => <li key={s}>{s}</li>)}</ul>
      </li>
      <li>
        <span className="composio-step-label">{STRX.step3}</span>
        <button type="button" className="btn-primary" disabled={checking} onClick={() => void pasteKey()}>{STRX.pasteButton}</button>
      </li>
      <li>
        <span className="composio-step-label">{STRX.step4}</span>
        {checking ? <span className="muted" role="status">{STRX.checking}</span> : error ? <span className="error" role="alert">{error}</span> : null}
      </li>
    </ol>
  );
}

export function ComposioSheet() {
  const { open, status, busy, error, close, pasteKey, clearKey } = useComposio();
  useComposioSync();
  if (!open) return null;
  const keySet = status?.keySet === true;
  return (
    <Dialog label={STRX.sheetTitle} onClose={close} className="tpl-sheet google-sheet composio-sheet">
      <>
        <h2>{STRX.sheetTitle}</h2>
        {!keySet && <KeySteps />}
        {keySet && status && (
          <>
            <section className="settings-card" aria-label={STRX.keySaved}>
              <div className="settings-row gap">
                <span className="grow">{STRX.keySaved}</span>
                <button type="button" className="link-btn" disabled={!!busy} onClick={() => void pasteKey()}>{busy === "key" ? STRX.checking : STRX.replaceKey}</button>
                <button type="button" className="btn-outline" disabled={!!busy} onClick={() => void clearKey()}>{STRX.removeKey}</button>
              </div>
            </section>
            <h3>{STRX.apps}</h3>
            <section className="settings-card composio-apps" aria-label={STRX.apps}>
              {status.apps.map((a) => <AppRow key={a.toolkit} app={a} />)}
            </section>
            {error && <span className="error" role="alert">{error}</span>}
          </>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn-outline" onClick={close}>{STRX.close}</button>
        </div>
      </>
    </Dialog>
  );
}

/** The one-time data note, before the first Connect (from the sheet or the Marketplace). */
export function ComposioDisclosure() {
  const { disclosureFor, busy, acceptAndConnect, cancelDisclosure } = useComposio();
  if (!disclosureFor) return null;
  return (
    <Dialog label={STRX.disclosureTitle} onClose={cancelDisclosure} className="tpl-sheet composio-disclosure">
      <>
        <h2>{STRX.disclosureTitle}</h2>
        <p>{STRX.disclosure}</p>
        <div className="sheet-actions">
          <button type="button" className="btn-outline" onClick={cancelDisclosure}>{STRX.cancel}</button>
          <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void acceptAndConnect()}>{STRX.accept}</button>
        </div>
      </>
    </Dialog>
  );
}
