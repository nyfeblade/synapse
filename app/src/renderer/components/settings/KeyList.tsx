import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { STR, STR_KEYS, STR_PROVIDER_UI, keyLooksRight, type KeyedProvider, type KeysView, type KeyView } from "@synapse/shared";
import { callQuiet } from "../../bridge";
import { publishKeys, useKeysView } from "./keys-store";
import { Menu, type MenuItem } from "../Menus";
import { MoreIcon } from "../Icons";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^[A-Z_]+: /, "") || STR.hostNoAnswer;

/**
 * Settings → Account (0.1.7): one provider's saved keys, each with its label, mask, spend this month and Test; Rename,
 * Make default, Monthly cap and Remove sit behind the row's menu. Add key asks for a label and the key, which goes to
 * the main process to be sealed to the box (window.synapse.providers.addKey); the host only ever answers with masks.
 */
export function KeyList({ provider, onChanged }: { provider: KeyedProvider; onChanged?(v: KeysView): void }) {
  const { view } = useKeysView();
  const [adding, setAdding] = useState(false);
  const take = (v: KeysView) => { publishKeys(v); onChanged?.(v); };
  const ring = view?.rings.find((r) => r.provider === provider);
  if (!view || !ring) return null;
  return (
    <div className="key-list" aria-label={`${ring.label} keys`}>
      {ring.keys.map((k) => <KeyRow key={k.id} provider={provider} k={k} several={ring.keys.length > 1} onView={take} />)}
      {adding
        ? <AddKeyForm provider={provider} first={!ring.keys.length} onDone={(v) => { if (v) take(v); setAdding(false); }} />
        : (
          <div className="settings-row key-add-row">
            {!ring.keys.length && <span className="grow muted">{STR_KEYS.noKeys}</span>}
            <button type="button" className="link-btn" onClick={() => setAdding(true)}>{STR_KEYS.addKey}</button>
          </div>
        )}
    </div>
  );
}

function KeyRow({ provider, k, several, onView }: { provider: KeyedProvider; k: KeyView; several: boolean; onView(v: KeysView): void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<null | "rename" | "cap">(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; title: string; detail: string } | "testing" | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  };
  const testNow = () => run(async () => {
    setTest("testing");
    try { setTest(await callQuiet("testKey", { provider, keyId: k.id })); } catch (e) { setTest(null); throw e; }
  });
  const items: MenuItem[] = [
    { label: STR_KEYS.rename, onSelect: () => { setText(k.label); setMode("rename"); } },
    ...(k.isDefault ? [] : [{ label: STR_KEYS.makeDefault, onSelect: () => void run(async () => {
      const viaMain = window.synapse.providers.makeDefault;
      onView(viaMain ? (await viaMain(provider, k.id)) as KeysView : await callQuiet("setDefaultKey", { provider, keyId: k.id }));
    }) }]),
    { label: STR_KEYS.cap, onSelect: () => { setText(k.capUsd ? String(k.capUsd) : ""); setMode("cap"); } },
    { separator: true },
    { label: STR_KEYS.remove, danger: true, onSelect: () => void run(async () => {
      const viaMain = window.synapse.providers.removeKey;
      onView(viaMain ? (await viaMain(provider, k.id)) as KeysView : await callQuiet("removeKey", { provider, keyId: k.id }));
    }) },
  ];
  const submit = () => run(async () => {
    if (mode === "rename") onView(await callQuiet("renameKey", { provider, keyId: k.id, label: text }));
    else if (mode === "cap") {
      const n = text.trim() ? Number(text.replace(/[$,\s]/g, "")) : null;
      if (n !== null && !(n >= 0)) throw new Error(STR_KEYS.cap);
      onView(await callQuiet("setKeyCap", { provider, keyId: k.id, capUsd: n || null }));
    }
    setMode(null);
  });
  const bad = k.health === "rejected" ? STR_KEYS.rejected : k.health === "no-credit" ? STR_KEYS.noCredit : null;
  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>) => { const r = e.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: r.right - 180, y: r.bottom + 4 }); };
  return (
    <div className="key-row" aria-label={k.label}>
      {mode ? (
        <form className="settings-row" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <input autoFocus aria-label={mode === "rename" ? STR_KEYS.label : STR_KEYS.cap} className="text-input grow" value={text} maxLength={mode === "rename" ? 24 : 10}
            inputMode={mode === "cap" ? "decimal" : undefined} placeholder={mode === "cap" ? STR_KEYS.capNone : STR_KEYS.labelPlaceholder}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMode(null); } }} />
          <button type="button" className="btn-outline" disabled={busy} onClick={() => setMode(null)}>{STR_KEYS.cancel}</button>
          <button type="submit" className="btn-primary" disabled={busy || (mode === "rename" && !text.trim())}>{STR_KEYS.save}</button>
        </form>
      ) : (
        <div className="settings-row">
          <span className="key-label">{k.label}</span>
          {several && k.isDefault && <span className="key-tag">{STR_KEYS.isDefault}</span>}
          <span className="key-mask muted">{k.masked}</span>
          <span className="grow" />
          {bad && <span className="key-bad">{bad}</span>}
          <span className="key-usage muted">{STR_KEYS.usage(k.monthUsd, k.monthRuns)}{k.capUsd ? ` / $${k.capUsd}` : ""}</span>
          <button type="button" className="btn-outline" disabled={busy} onClick={() => void testNow()}>{test === "testing" ? STR_KEYS.testing : STR_KEYS.test}</button>
          <button type="button" className="icon-btn" aria-label={`${k.label}: more`} aria-haspopup="menu" aria-expanded={!!menu} onClick={openMenu}><MoreIcon /></button>
        </div>
      )}
      {menu && <Menu label={k.label} x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {test && test !== "testing" && <p role="status" className={test.ok ? "account-test ok" : "account-test"}><strong>{test.title}</strong>{test.detail ? <span className="muted"> {test.detail}</span> : null}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}

function AddKeyForm({ provider, first, onDone }: { provider: KeyedProvider; first: boolean; onDone(v: KeysView | null): void }) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const k = key.trim();
    if (!keyLooksRight(provider, k)) { setError(STR_PROVIDER_UI.badFormat); return; }
    setBusy(true);
    setError(null);
    try {
      const add = window.synapse.providers.addKey;
      if (!add) throw new Error(STR.hostNotConnected);
      onDone((await add(provider, k, label.trim())) as KeysView);
    } catch (e) { setError(reason(e)); } finally { setBusy(false); }
  };
  return (
    <form className="key-add" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="settings-row">
        <input autoFocus aria-label={STR_KEYS.label} className="text-input key-add-label" maxLength={24} placeholder={first ? STR_KEYS.labelPlaceholder : STR_KEYS.label} value={label} onChange={(e) => setLabel(e.target.value)} />
        <input aria-label="Key" type="password" autoComplete="off" spellCheck={false} className="text-input grow" placeholder={STR_PROVIDER_UI.keyPlaceholder} value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div className="settings-row">
        <span className="grow" />
        <button type="button" className="btn-outline" disabled={busy} onClick={() => onDone(null)}>{STR_KEYS.cancel}</button>
        <button type="submit" className="btn-primary" disabled={busy || !key.trim()}>{STR_KEYS.save}</button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}
