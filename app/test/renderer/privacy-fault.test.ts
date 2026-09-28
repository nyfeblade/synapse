import { describe, expect, it } from "vitest";
import { STR5 } from "@synapse/shared";
import { permissionFault } from "../../src/renderer/voice/dictation-errors";

// Mic / speech permission (bug 99): every permission failure maps to a specific message AND the
// System Settings pane that fixes it, so the UI can offer the "Open System Settings" button.
describe("permissionFault: helper status → UI", () => {
  it("microphone denied → microphone message + Microphone pane", () => {
    expect(permissionFault("permission:microphone:denied")).toEqual({ pane: "microphone", text: STR5.micAccessDenied });
  });
  it("microphone restricted (MDM / parental) → restricted message, still the Microphone pane", () => {
    expect(permissionFault("permission:microphone:restricted")).toEqual({ pane: "microphone", text: STR5.micAccessRestricted });
  });
  it("speech denied → speech message + Speech Recognition pane", () => {
    expect(permissionFault("permission:speech:denied")).toEqual({ pane: "speech", text: STR5.speechAccessDenied });
  });
  it("speech restricted → restricted message + Speech Recognition pane", () => {
    expect(permissionFault("permission:speech:restricted")).toEqual({ pane: "speech", text: STR5.speechAccessRestricted });
  });
  it("an older helper's bare not-authorized still maps (speech) with the generic text", () => {
    expect(permissionFault("not-authorized")).toEqual({ pane: "speech", text: STR5.micDenied });
  });
  it("the audio engine failing to start is a microphone fault", () => {
    expect(permissionFault("microphone: The operation couldn't be completed")).toEqual({ pane: "microphone", text: STR5.micDenied });
  });
  it("non-permission errors map to nothing", () => {
    expect(permissionFault("No speech detected")).toBeNull();
    expect(permissionFault("Recognition request was canceled")).toBeNull();
  });
});
