import { useState } from "react";
import { decodeShare, SHARE_LIMITS, STR, STRSH } from "@synapse/shared";
import { nativeCall } from "../native";

/** The catalogue entry the site build reads (site/bots/<slug>.json): no author field, ever. */
export async function websiteEntry(fragment: string, blurb: string, today = new Date().toISOString().slice(0, 10)): Promise<{ fileName: string; json: string }> {
  const d = await decodeShare(fragment);
  if (!d.ok) throw new Error(d.message);
  const slug = d.payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "bot";
  const entry = { slug, blurb: blurb.trim().slice(0, SHARE_LIMITS.blurb), order: 100, addedAt: today, payload: d.payload };
  return { fileName: `${slug}.json`, json: `${JSON.stringify(entry, null, 2)}\n` };
}

/**
 * Export for website (the owner's advanced action): the Share sheet's own link, plus a blurb, written as a
 * catalogue entry to a folder the owner picks. Publishing is adding that file to site/bots/ and pushing.
 */
export function WebsiteEntry({ fragment, name, onDone }: { fragment: string; name: string; onDone(): void }) {
  const [blurb, setBlurb] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const e = await websiteEntry(fragment, blurb);
      const bytes = new TextEncoder().encode(e.json);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const bytesBase64 = btoa(bin);
      const r = await nativeCall<{ path: string | null }>("saveFile", { defaultName: e.fileName, bytesBase64, filters: [{ name: "Catalogue entry", extensions: ["json"] }] });
      setSaved(r.path);
    } catch (err) { setError((err as Error).message); }
  };
  return (
    <div className="share-website">
      <label className="share-blurb"><span>{STRSH.blurb}</span>
        <input className="text-input" value={blurb} maxLength={SHARE_LIMITS.blurb} placeholder={name} onChange={(e) => setBlurb(e.target.value)} />
      </label>
      {saved && <p className="muted small" role="status">{saved}</p>}
      {error && <span className="error" role="alert">{error}</span>}
      <div className="sheet-actions">
        <button type="button" className="btn-outline" onClick={onDone}>{STR.close}</button>
        <button type="button" className="btn-primary" disabled={!blurb.trim()} onClick={() => void save()}>{STRSH.saveEntry}</button>
      </div>
    </div>
  );
}
