import { useEffect, useState } from "react";
import { STRSH } from "@synapse/shared";
import { callQuiet } from "../bridge";
import { nativeCall } from "../native";
import { useTemplates } from "./store";

/**
 * Bot sharing: a Bot menu's share items. "Share Bot…" always; "Copy link" (one click) once this Bot's link was
 * copied and nothing in it has changed since; "Export for website" only with the owner's advanced controls on.
 * `open` is whether the menu is showing: the two checks run as it opens, and the items appear when they answer.
 */
export function useShareItems(botId: string | null, open: boolean): { label: string; onSelect(): void }[] {
  const [same, setSame] = useState(false);
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    setSame(false);
    if (!open || !botId) return;
    let live = true;
    // callQuiet, both: background probes for an optional menu item; without an answer the item just isn't shown.
    void callQuiet("sharePayload", { id: botId }).then((r) => { if (live) setSame(r.sameAsLastShare); }).catch(() => {});
    void nativeCall<{ on?: boolean }>("ownerTools.get").then((r) => { if (live) setOwner(r?.on === true); }).catch(() => {});
    return () => { live = false; };
  }, [botId, open]);
  if (!botId) return [];
  const t = useTemplates.getState();
  return [
    { label: STRSH.shareBot, onSelect: () => t.openShare(botId) },
    ...(same ? [{ label: STRSH.copyLink, onSelect: () => void t.copyShareLink(botId) }] : []),
    ...(owner ? [{ label: STRSH.exportForWebsite, onSelect: () => t.openShare(botId, true) }] : []),
  ];
}
