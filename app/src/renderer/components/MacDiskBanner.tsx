import { useEffect, useState } from "react";
import { STRO } from "@synapse/shared";
import { nativeCall, onNative } from "../native";
import { Announce } from "./Announce";

export interface MacDiskView { level: "ok" | "low" | "critical"; freeBytes: number | null; totalBytes: number | null; boxFreeBytes: number | null; checkedAt: number }

/** The main process's latest free-space check (src/main/mac-disk.ts): on mount, then every `mac-disk` event. */
export function useMacDisk(): MacDiskView | null {
  const [v, setV] = useState<MacDiskView | null>(null);
  useEffect(() => {
    let live = true;
    void nativeCall<MacDiskView>("macDisk.status").then((r) => { if (live && r && "level" in r) setV((cur) => cur ?? r); }, () => {});
    const off = onNative<MacDiskView>("mac-disk", (r) => setV(r));
    return () => { live = false; off(); };
  }, []);
  return v;
}

const RANK = { ok: 0, low: 1, critical: 2 } as const;

/**
 * bug-log 128: under 15 GB free on the Mac, one quiet line at the top of the window. Dismiss hides it
 * until the disk gets worse (low → critical); it comes back by itself on the next episode.
 */
export function MacDiskBanner() {
  const v = useMacDisk();
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // the level rank that was dismissed
  const rank = v ? RANK[v.level] : 0;
  useEffect(() => { if (rank === 0) setDismissedAt(null); }, [rank]);
  if (!v || v.level === "ok" || v.freeBytes === null) return null;
  if (dismissedAt !== null && rank <= dismissedAt) return null;
  // App-level chrome, so it goes through the announcement outlet (bug 46): on top of an open modal
  // it moves into that surface instead of painting under the scrim.
  return (
    <Announce>
      <div role="status" aria-live="polite" data-announcement="mac-disk" className={`disk-banner mac-disk-banner${v.level === "critical" ? " hard" : ""}`}>
        <span>{STRO.macDiskLow(v.freeBytes)}</span>
        <button type="button" className="btn-outline small" onClick={() => setDismissedAt(rank)}>{STRO.dismiss}</button>
      </div>
    </Announce>
  );
}
