import { useEffect, useState } from "react";
import { GatewayCallError, STR, STR5, STRSH } from "@synapse/shared";
import { call } from "../bridge";
import { Dialog } from "../components/Dialog";
import { ShapeAvatar } from "../components/ShapeAvatar";
import { useMarketplace } from "../marketplace/store";
import { useUi } from "../store";
import { nativeCall } from "../native";
import { useTemplates } from "./store";
import { applyNewBotChoice, NewBotModelStep } from "../components/NewBotModelStep";
import type { NewBotChoice } from "../model-picks";

export function ImportSheet() {
  const { sheet, close } = useTemplates();
  if (sheet?.kind === "share-error") return <ShareErrorSheet message={sheet.message} newer={sheet.newer} onClose={close} />;
  // Escape used to reach the Marketplace behind this sheet and close that instead, leaving the sheet
  // floating over an empty app. The overlay stack settles which layer hears it.
  if (!sheet || sheet.kind !== "import") return null;
  return <ImportBody key={sheet.preview.token} />;
}

function ImportBody() {
  const { sheet, close } = useTemplates();
  // While this sheet is up, another link doesn't pull the window forward again (the main process asks).
  useEffect(() => {
    void nativeCall("share.importSheetOpen", { open: true }).catch(() => {});
    return () => { void nativeCall("share.importSheetOpen", { open: false }).catch(() => {}); };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(true);
  const [adding, setAdding] = useState(false);
  // 0.1.7: the Bot's model (and paying key, with several keys), chosen before it's added.
  const [choice, setChoice] = useState<NewBotChoice | null>(null);
  if (!sheet || sheet.kind !== "import") return null;
  const p = sheet.preview;
  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const { id } = await call("importTemplate", { token: p.token });
      await applyNewBotChoice(id, choice);
      const after = useTemplates.getState().afterAdd;
      close();
      useMarketplace.getState().close(); // the new Bot opens in view, not behind the Marketplace
      if (after) after(id);
      else useUi.getState().openBot(id);
    } catch (e) {
      setError(p.share && e instanceof GatewayCallError && e.code === "PREVIEW_EXPIRED" ? STRSH.previewExpired : (e as Error).message);
    } finally { setAdding(false); }
  };
  const list = (title: string, items: string[]) => items.length > 0 && <section className="tpl-section"><h3>{title}</h3><ul>{items.map((x) => <li key={x}>{x}</li>)}</ul></section>;
  return (
    <Dialog label={p.name} onClose={close} className="tpl-sheet">
      <>
        {p.face ? (
          <div className="tpl-head">
            <ShapeAvatar className="tpl-face" shape={p.face.shape} color={p.face.color} size={44} still />
            <h2>{p.name}</h2>
          </div>
        ) : <h2>{p.name}</h2>}
        {p.author && <span className="muted">{STR5.authorsBot(p.author.name)}</span>}
        {p.share ? (
          p.instructions ? (
            <section className="tpl-section">
              <button type="button" className="tpl-row-toggle" aria-expanded={showInstructions} onClick={() => setShowInstructions(!showInstructions)}>{STRSH.instructions}</button>
              {showInstructions && <p className="tpl-instructions pre-wrap">{p.instructions}</p>}
            </section>
          ) : null
        ) : <p className="muted pre-wrap">{p.description}</p>}
        {list(STR5.factsItKnows, p.facts)}
        {p.skills ? p.skills.length > 0 && (
          <section className="tpl-section"><h3>{STR5.playbooks}</h3>
            <ul>{p.skills.map((k) => <li key={k.name}>{k.name}{k.runsCode && <span className="chip warn">{STRSH.runsCode}</span>}</li>)}</ul>
          </section>
        ) : list(STR5.playbooks, p.playbooks)}
        {p.playbooksShared && <p className="muted small" role="note">{STR5.playbooksShared}</p>}
        {list(STR5.jobs, p.jobs)}
        {p.apps.length > 0 && (
          <section className="tpl-section"><h3>{STR5.apps}</h3>
            <ul>{p.apps.map((a) => <li key={a.name}>{a.name}{a.needsConnecting && <span className="chip warn">{STR5.needsConnecting}</span>}</li>)}</ul>
          </section>
        )}
        {p.flags && p.flags.length > 0 && (
          <section className="tpl-section"><h3>{STRSH.unusualText}</h3>
            <ul>{p.flags.map((f) => <li key={f}>{f}</li>)}</ul>
          </section>
        )}
        {p.thirdParty && <p className="warning" role="note">{STRSH.addedAsShared}</p>}
        {p.alreadyAdded && <p className="muted" role="note">{STRSH.alreadyHave}</p>}
        <NewBotModelStep choice={choice} onChange={setChoice} />
        {error && <span className="error" role="alert">{error}</span>}
        <div className="sheet-actions">
          <button type="button" className="btn-secondary" onClick={close}>{STR.cancel}</button>
          <button type="button" className="btn-primary" disabled={adding} onClick={() => void add()}>{p.alreadyAdded ? STRSH.addACopy : STR5.addBot}</button>
        </div>
      </>
    </Dialog>
  );
}

/** A link that can't be opened: its one calm line, and Update when a newer Synapse would open it. */
function ShareErrorSheet({ message, newer, onClose }: { message: string; newer: boolean; onClose(): void }) {
  return (
    <Dialog label={message} onClose={onClose} className="tpl-sheet tpl-line">
      <>
        <p role="alert" className="tpl-line-text">{message}</p>
        <div className="sheet-actions">
          <button type="button" className={newer ? "btn-secondary" : "btn-primary"} onClick={onClose}>{STR.close}</button>
          {newer && <button type="button" className="btn-primary" onClick={() => { onClose(); useUi.getState().openSettings("system"); }}>{STRSH.update}</button>}
        </div>
      </>
    </Dialog>
  );
}
