// components/Overlays.tsx — final in this task (no replacement).
import { useOverlays } from "../overlays";
import { CommandPalette } from "./CommandPalette";
import { HiddenBotsDialog } from "./HiddenBotsDialog";
import { PrivateSkills } from "./PrivateSkills";

export function Overlays() {
  const open = useOverlays((s) => s.open);
  if (open === "palette") return <CommandPalette />;
  if (open === "skills") return <PrivateSkills />;
  if (open === "hidden-bots") return <HiddenBotsDialog />;
  return null;
}
