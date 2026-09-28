import { useEffect, useState } from "react";

export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const w = words[0] ?? "";
  return /^\d/.test(w) ? (w[0]! + (w.slice(1).match(/[A-Za-z]/)?.[0] ?? "")).toUpperCase() : w.slice(0, 2).charAt(0).toUpperCase() + w.slice(1, 2).toLowerCase();
}

const cache = new Map<string, string>();

function isRemote(url: string): boolean {
  return /^https?:/i.test(url);
}

export function LogoTile({ name, logo, size = 36 }: { name: string; logo: string | null; size?: number }) {
  const [src, setSrc] = useState<string | null>(() => (logo && !isRemote(logo) ? logo : cache.get(logo ?? "") ?? null));
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (!logo) { setSrc(null); return; }
    if (!isRemote(logo)) { setSrc(logo); return; }
    const hit = cache.get(logo);
    if (hit) { setSrc(hit); return; }
    setSrc(null);
    let cancelled = false;
    const invoke = window.synapse?.native?.invoke;
    if (!invoke) { setBroken(true); return; }
    void invoke("fetchLogo", { url: logo }).then((r) => {
      if (cancelled) return;
      if (r.ok && typeof r.result === "string") {
        cache.set(logo, r.result);
        setSrc(r.result);
      } else setBroken(true);
    }).catch(() => { if (!cancelled) setBroken(true); });
    return () => { cancelled = true; };
  }, [logo]);
  const show = src && !broken;
  return show
    ? <img src={src} alt="" width={size} height={size} className="logo-tile" onError={() => setBroken(true)} />
    : <span aria-hidden="true" className="logo-tile" style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>{initials(name)}</span>;
}
