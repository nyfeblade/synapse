import { STR5 } from "@synapse/shared";
import { registerSettingsSection, SectionBlocks } from "./sections";

/** Settings → System: Updates, Backups and Diagnostics, each its own block under a heading. */
export function SystemSection() {
  return (
    <>
      <h2>{STR5.system}</h2>
      <SectionBlocks section="system" />
    </>
  );
}

registerSettingsSection("system", STR5.system, SystemSection);
