import { useState } from "react";
import { STR, STR5 } from "@synapse/shared";
import { call } from "../bridge";
import { Dialog } from "../components/Dialog";
import { useMarketplace } from "../marketplace/store";
import { useUi } from "../store";
import { useTemplates } from "./store";

export function ImportSheet() {
  const { sheet, close } = useTemplates();
  const [error, setError] = useState<string | null>(null);
  // Escape used to reach the Marketplace behind this sheet and close that instead, leaving the sheet
  // floating over an empty app. The overlay stack settles which layer hears it.
  if (!sheet || sheet.kind !== "import") return null;
  const p = sheet.preview;
  const add = async () => {
    try {
      const { id } = await call("importTemplate", { token: p.token });
      close();
      useMarketplace.getState().close(); // the new Bot opens in view, not behind the Marketplace
      useUi.getState().openBot(id);
    } catch (e) { setError((e as Error).message); }
  };
  const list = (title: string, items: string[]) => items.length > 0 && <section className="tpl-section"><h3>{title}</h3><ul>{items.map((x) => <li key={x}>{x}</li>)}</ul></section>;
  return (
    <Dialog label={p.name} onClose={close} className="tpl-sheet">
      <>
        <h2>{p.name}</h2>
        {p.author && <span className="muted">{STR5.authorsBot(p.author.name)}</span>}
        <p className="muted pre-wrap">{p.description}</p>
        {list(STR5.factsItKnows, p.facts)}
        {list(STR5.playbooks, p.playbooks)}
        {p.playbooksShared && <p className="muted small" role="note">{STR5.playbooksShared}</p>}
        {list(STR5.jobs, p.jobs)}
        {p.apps.length > 0 && (
          <section className="tpl-section"><h3>{STR5.apps}</h3>
            <ul>{p.apps.map((a) => <li key={a.name}>{a.name}{a.needsConnecting && <span className="chip warn">{STR5.needsConnecting}</span>}</li>)}</ul>
          </section>
        )}
        {p.thirdParty && <p className="warning" role="note">{STR5.thirdPartyWarning}</p>}
        {error && <span className="error" role="alert">{error}</span>}
        <div className="sheet-actions">
          <button type="button" className="btn-outline" onClick={close}>{STR.cancel}</button>
          <button type="button" className="btn-primary" onClick={() => void add()}>{STR5.addBot}</button>
        </div>
      </>
    </Dialog>
  );
}
