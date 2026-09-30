import { useEffect, useRef, useState } from "react";
import { AVATAR_COLOR_NAMES, AVATAR_COLORS, AVATAR_SHAPE_LABELS, SHARE_SITE, shareLinks, STR, STRSH, type SharePreview, type ShareSelection } from "@synapse/shared";
import { call } from "../bridge";
import { Dialog } from "../components/Dialog";
import { ShapeAvatar } from "../components/ShapeAvatar";
import { nativeCall } from "../native";
import { WebsiteEntry } from "./WebsiteEntry";
import { useTemplates } from "./store";

/**
 * Share Bot: the Bot's face and name, what goes into the link (instructions, skills and tools, each skill and
 * tool with a checkbox, and its look), and one muted line on what never does. Copy link is the primary button and
 * the default on Enter; Share… hands the link to the Mac's share menu. A Bot too big for a link saves a .botpack.
 */
export function ShareSheet() {
  const sheet = useTemplates((s) => s.sheet);
  if (!sheet || sheet.kind !== "share") return null;
  return <ShareBody key={`${sheet.botId}:${sheet.website}`} botId={sheet.botId} website={sheet.website} />;
}

function ShareBody({ botId, website }: { botId: string; website: boolean }) {
  const close = useTemplates((s) => s.close);
  const [data, setData] = useState<SharePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);

  const load = async (selection?: ShareSelection) => {
    const n = ++seq.current;
    try {
      const r = await call("sharePayload", { id: botId, ...(selection ? { selection } : {}) });
      if (n === seq.current) { setData(r); setError(null); }
    } catch (e) { if (n === seq.current) setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [botId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Copy link is the default: focus it once the link is ready, so Enter copies.
  useEffect(() => { if (data?.fragment && !website) copyRef.current?.focus(); }, [data?.fragment, website]);

  const toggle = (kind: keyof ShareSelection, id: string) => {
    if (!data) return;
    const cur = data.selection[kind];
    const next = { ...data.selection, [kind]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    setData({ ...data, selection: next, [kind]: data[kind].map((x) => ("id" in x ? x.id : x.catalogId) === id ? { ...x, included: !cur.includes(id) } : x) } as SharePreview);
    setCopied(false);
    void load(next);
  };
  const link = data?.fragment ? shareLinks(data.fragment, SHARE_SITE).web : null;
  const copy = async () => {
    if (!data) return;
    try {
      const r = await call("sharePayload", { id: botId, selection: data.selection, remember: true });
      if (!r.fragment) { setData(r); return; }
      await navigator.clipboard.writeText(shareLinks(r.fragment, SHARE_SITE).web);
      setCopied(true);
    } catch (e) { setError((e as Error).message); }
  };
  const shareMenu = () => { if (link && data) void nativeCall("shareMenu", { url: link, title: data.name }).catch(() => {}); };
  const saveBotpack = async () => {
    if (!data || saving) return;
    setSaving(true);
    try {
      const manifest = {
        profile: { name: data.name, title: data.title, description: data.instructions, avatarShape: data.face.shape, avatarColor: data.face.color },
        skills: data.skills.filter((k) => k.included).map((k) => ({ id: k.id, name: k.name, description: k.description })),
        memories: [], routines: [],
        plugins: data.tools.filter((t) => t.included).map((t) => ({ catalogId: t.catalogId, name: t.name })),
      };
      const r = await call("exportTemplate", { id: botId, manifest });
      await nativeCall("saveFile", { defaultName: r.fileName, bytesBase64: r.bytesBase64, filters: [{ name: "Bot template", extensions: ["botpack"] }] });
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };
  const colorName = (c: string) => AVATAR_COLOR_NAMES[AVATAR_COLORS.indexOf(c as (typeof AVATAR_COLORS)[number])] ?? c;

  return (
    <Dialog label={data?.name ?? STRSH.shareBot} onClose={close} className="tpl-sheet share-sheet">
      <form onSubmit={(e) => { e.preventDefault(); if (!website) void (data?.fragment ? copy() : saveBotpack()); }}>
        {!data && !error && <span className="muted">…</span>}
        {data && (
          <>
            <div className="tpl-head">
              <ShapeAvatar className="tpl-face" shape={data.face.shape} color={data.face.color} size={44} still />
              <div className="tpl-head-text"><h2>{data.name}</h2>{data.title && <span className="muted">{data.title}</span>}</div>
            </div>
            <div className="share-rows">
              {data.instructions && (
                <div className="share-row">
                  <button type="button" className="tpl-row-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{STRSH.instructions}</button>
                  {open && <p className="tpl-instructions pre-wrap">{data.instructions}</p>}
                </div>
              )}
              {data.skills.length > 0 && (
                <fieldset className="share-row tpl-section"><legend>{STRSH.skills}</legend>
                  {data.skills.map((k) => (
                    <label key={k.id} className="tpl-item"><input type="checkbox" checked={k.included} onChange={() => toggle("skills", k.id)} />{k.name}{k.runsCode && <span className="chip warn">{STRSH.runsCode}</span>}</label>
                  ))}
                </fieldset>
              )}
              {data.tools.length > 0 && (
                <fieldset className="share-row tpl-section"><legend>{STRSH.tools}</legend>
                  {data.tools.map((t) => (
                    <label key={t.catalogId} className="tpl-item"><input type="checkbox" checked={t.included} onChange={() => toggle("tools", t.catalogId)} />{t.name}</label>
                  ))}
                </fieldset>
              )}
              <div className="share-row share-look"><span className="share-row-label">{STRSH.look}</span><span className="muted">{AVATAR_SHAPE_LABELS[data.face.shape]} · {colorName(data.face.color)}</span></div>
            </div>
            {data.hidden && <p className="muted small" role="note">{STRSH.hidden(data.hidden)}</p>}
            <p className="muted small">{STRSH.neverIncluded}</p>
            {!data.fragment && <p className="tpl-line-text" role="note">{STRSH.tooBig}</p>}
            {website && data.fragment && <WebsiteEntry fragment={data.fragment} name={data.name} onDone={close} />}
          </>
        )}
        {error && <span className="error" role="alert">{error}</span>}
        {!website && (
          <div className="sheet-actions">
            <button type="button" className="btn-outline" onClick={close}>{STR.close}</button>
            {data?.fragment && <button type="button" className="btn-outline" onClick={shareMenu}>{STRSH.shareMenu}</button>}
            {data && (data.fragment
              ? <button ref={copyRef} type="submit" className="btn-primary">{copied ? STRSH.copied : STRSH.copyLink}</button>
              : <button type="submit" className="btn-primary" disabled={saving}>{STRSH.saveBotpack}</button>)}
          </div>
        )}
      </form>
    </Dialog>
  );
}
