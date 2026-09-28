import { useRef, useState } from "react";
import { LIMITS5, STR5 } from "@synapse/shared";

const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];

export function checkImage(f: { size: number; type: string }): string | null {
  if (!TYPES.includes(f.type)) return STR5.avatarBadType;
  if (f.size > LIMITS5.avatarMaxBytes) return STR5.avatarTooLarge;
  return null;
}

export function UploadTab({ onPreview }: { onPreview(p: { mime: string; bytesBase64: string; url: string }): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const take = (f: File | undefined | null) => {
    if (!f) return;
    const bad = checkImage(f);
    if (bad) return setError(bad);
    setError(null);
    const r = new FileReader();
    r.onload = () => {
      const u = String(r.result);
      setUrl(u);
      onPreview({ mime: f.type, bytesBase64: u.split(",")[1] ?? "", url: u });
    };
    r.readAsDataURL(f);
  };
  return (
    <div
      className="avatar-tab drop"
      aria-label={STR5.dropImage}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        take(e.dataTransfer.files[0]);
      }}
      onPaste={(e) => take([...e.clipboardData.files][0])}
      tabIndex={0}
    >
      {url ? <img alt="" className="avatar-preview round" src={url} /> : <span>{STR5.dropImage}</span>}
      <span className="muted">{STR5.or}</span>
      <button type="button" className="btn-outline" onClick={() => input.current?.click()}>{STR5.browseFiles}</button>
      <input ref={input} type="file" accept={TYPES.join(",")} hidden onChange={(e) => take(e.target.files?.[0])} />
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
