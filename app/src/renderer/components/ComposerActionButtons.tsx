import { STR5 } from "@synapse/shared";
import { MicIcon, PlusIcon } from "./Icons";

/** Disabled, later-phase composer action buttons shared by Composer and NewChat. */
export function AttachFileButton() {
  return <button type="button" className="round-btn" aria-label="Attach file" title={STR5.notAvailableYet} disabled><PlusIcon /></button>;
}

export function VoiceInputButton() {
  return <button type="button" className="round-btn" aria-label="Start voice input" title={STR5.notAvailableYet} disabled><MicIcon /></button>;
}
