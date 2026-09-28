// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { STR5 } from "@synapse/shared";
import { AttachFileButton, VoiceInputButton } from "../../src/renderer/components/ComposerActionButtons";

afterEach(cleanup);

describe("ComposerActionButtons (shared between Composer and NewChat)", () => {
  it("renders a disabled, later-phase Attach file button", () => {
    render(<AttachFileButton />);
    const btn = screen.getByRole("button", { name: "Attach file" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(STR5.notAvailableYet);
  });

  it("renders a disabled, later-phase Start voice input button", () => {
    render(<VoiceInputButton />);
    const btn = screen.getByRole("button", { name: "Start voice input" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(STR5.notAvailableYet);
  });
});
