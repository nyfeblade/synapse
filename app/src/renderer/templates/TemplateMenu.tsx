import { useState, type MouseEvent, type ReactNode } from "react";
import { STR, STR5 } from "@synapse/shared";
import { call } from "../bridge";
import { Menu } from "../components/Menus";
import { ShareIcon } from "../components/Icons";
import { askConfirm } from "../components/ConfirmDialog";
import { useUi } from "../store";
import { useTemplates } from "./store";

/** Local label: shared/src/strings-phase5.ts belongs to another track this cycle. */
const DELETE_TITLE = "Delete this template?";
const DELETE_LINE = "Bots already made from it are not affected.";

/**
 * The template actions as a menu that opens at a point, and nothing else — no trigger of its own.
 *
 * WHY IT IS A HOOK. There are now two places that open these actions: this file's own button (the
 * Bot admin surfaces) and the chat header's overflow, which lists them beside Usage rather than
 * spending a fourth unlabelled glyph on them. The delete confirmation, the rejected-delete path and
 * the aria-busy gap on a slow getTemplate are the kind of thing that is written once and then
 * quietly diverges when it is written twice, so the second caller takes this and supplies its own
 * trigger instead of copying thirty lines.
 */
export function useTemplateActions(botId: string): { openAt(x: number, y: number): Promise<void>; busy: boolean; node: ReactNode } {
  const [menu, setMenu] = useState<{ x: number; y: number; templateId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // The menu can't be positioned until getTemplate answers, and this await had no catch: a rejected
  // read meant the button did nothing at all, twice over — no menu, no message, no sign it had even
  // been pressed. call() now routes the reason to the sidebar's alert banner by default; aria-busy
  // covers the gap in between, and the button stays live so the user can try again.
  const openAt = async (x: number, y: number) => {
    setBusy(true);
    try {
      const { template } = await call("getTemplate", { id: botId });
      setMenu({ x, y, templateId: template?.id ?? null });
    } catch {
      // Already reported by call(); nothing to add here but letting the button go again.
    } finally {
      setBusy(false);
    }
  };
  const t = useTemplates.getState();
  return {
    openAt,
    busy,
    node: (
      <>
      {menu && (
        <Menu label={STR5.templateActions} x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menu.templateId === null
          ? [{ label: STR5.shareAsTemplate, onSelect: () => void t.openExport(botId) }]
          : [
            { label: STR5.viewTemplateDetails, onSelect: () => void t.openDetails(botId) },
            { label: STR5.updateTemplate, onSelect: () => void t.openExport(botId) },
            // One click used to destroy the shared template with no confirmation and no undo, and a rejected
            // delete looked exactly like a successful one. The app confirms smaller deletions than this.
            {
              label: STR5.deleteTemplate, danger: true, onSelect: () => {
                const templateId = menu.templateId!;
                void askConfirm({ title: DELETE_TITLE, line: DELETE_LINE, verb: STR.deleteVerb }).then((ok) => {
                  if (!ok) return;
                  void call("deleteTemplate", { templateId })
                    .catch((e: unknown) => useUi.setState({ actionError: e instanceof Error ? e.message : String(e) }));
                });
              },
            },
          ]} />
      )}
      </>
    ),
  };
}

/** The standalone trigger: one glyph that opens the actions under itself. */
export function TemplateMenu({ botId }: { botId: string }) {
  const { openAt, busy, node } = useTemplateActions(botId);
  const open = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void openAt(r.right - 200, r.bottom + 4);
  };
  return (
    <>
      <button type="button" className="icon-btn" aria-label={STR5.templateActions} aria-busy={busy || undefined} onClick={open}><ShareIcon /></button>
      {node}
    </>
  );
}
