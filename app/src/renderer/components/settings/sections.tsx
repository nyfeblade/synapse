import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useUi } from "../../store";

export type SettingsSectionId = "general" | "auto-review" | "account" | "usage" | "voice" | "computer" | "schedules" | "system";
interface SectionDef { id: SettingsSectionId; label: string; Component: ComponentType | null }

const sections: SectionDef[] = [
  { id: "general", label: "General", Component: null },
  // New-user walk, finding 22: Auto-review's rule builder no longer tops General.
  { id: "auto-review", label: "Auto-review", Component: null },
  { id: "account", label: "Account", Component: null },
  // New-user walk, finding 15: the account menu's Usage opened Account; it is a section of its own.
  { id: "usage", label: "Usage", Component: null },
  { id: "voice", label: "Voice", Component: null },
  { id: "computer", label: "Computer", Component: null },
  { id: "schedules", label: "Schedules", Component: null },
  { id: "system", label: "System", Component: null },
];

const blocksBySection = new Map<SettingsSectionId, { id: string; order: number; Component: ComponentType }[]>();

export function registerSettingsSection(id: SettingsSectionId, label: string, Component: ComponentType): void {
  const s = sections.find((x) => x.id === id);
  if (s) Object.assign(s, { label, Component });
}

/** A section's extra blocks (e.g. Security Key, Memory in General; Usage in Account; Updates,
 *  Backups, Diagnostics in System), rendered in order below the section's own content. */
export function registerSectionBlock(section: SettingsSectionId, id: string, order: number, Component: ComponentType): void {
  const list = blocksBySection.get(section) ?? [];
  const i = list.findIndex((b) => b.id === id);
  if (i >= 0) list.splice(i, 1);
  list.push({ id, order, Component });
  list.sort((a, b) => a.order - b.order);
  blocksBySection.set(section, list);
}

/** Back-compat name: General's own blocks. */
export function registerGeneralBlock(id: string, order: number, Component: ComponentType): void {
  registerSectionBlock("general", id, order, Component);
}

export function settingsSections(): readonly SectionDef[] {
  return sections;
}

export function generalExtraBlocks(): readonly { id: string; Component: ComponentType }[] {
  return blocksBySection.get("general") ?? [];
}

export function sectionBlocks(section: SettingsSectionId): readonly { id: string; Component: ComponentType }[] {
  return blocksBySection.get(section) ?? [];
}

/** A single block, wrapped so it flashes for 2s (SET-18) when `settingsFocus`'s head names it — the
 *  same parity a bare `openSettings("usage")` / `openSettings("updates")` used to get for free by
 *  being its own top-level section, before it folded into Account / System as a block. */
function FlashBlock({ id, focus, children }: { id: string; focus: string | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if ((focus ?? "").split("/")[0] !== id) return;
    ref.current?.scrollIntoView?.({ block: "center" });
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 2000);
    return () => clearTimeout(t);
  }, [focus, id]);
  return <div ref={ref} className={flash ? "settings-block flash" : "settings-block"}>{children}</div>;
}

/** Renders a section's registered blocks, in order, each able to flash itself into view. */
export function SectionBlocks({ section }: { section: SettingsSectionId }) {
  const focus = useUi((s) => s.settingsFocus);
  return (
    <>
      {sectionBlocks(section).map(({ id, Component }) => (
        <FlashBlock key={id} id={id} focus={focus}><Component /></FlashBlock>
      ))}
    </>
  );
}

/** A sub-focus that used to be its own top-level section and folded into another one as a block. */
const SECTION_OF_BLOCK: Record<string, SettingsSectionId> = {
  updates: "system",
  backups: "system",
  diagnostics: "system",
};

/** "auto-review" (Phase 1) → general; "usage" → account; "updates|backups|diagnostics" → system;
 *  a current section id (or a sub-focus inside it, e.g. "computer/execution") → itself. */
export function sectionOf(focus: string | null): SettingsSectionId {
  const head = (focus ?? "").split("/")[0]!;
  if (Object.hasOwn(SECTION_OF_BLOCK, head)) return SECTION_OF_BLOCK[head]!;
  return (["auto-review", "account", "usage", "voice", "computer", "schedules", "system"] as const).find((s) => s === head) ?? "general";
}
