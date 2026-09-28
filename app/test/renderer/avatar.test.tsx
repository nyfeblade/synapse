// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { GenerateTab } from "../../src/renderer/avatar/GenerateTab";
import { UploadTab, checkImage } from "../../src/renderer/avatar/UploadTab";
import { AvatarEditor } from "../../src/renderer/components/AvatarEditor";

beforeEach(() => {
  (window as unknown as { synapse: unknown }).synapse = { call: vi.fn(async () => ({ ok: true, result: { svg: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>' } })), onEvent: () => () => {}, onConnection: () => () => {}, retry: () => {}, appInfo: async () => ({ userName: "u" }), native: { invoke: async () => ({ ok: true, result: {} }), on: () => () => {} } };
});
afterEach(cleanup);

describe("avatar editor tabs (N13, N14)", () => {
  it("Generate is disabled until there is text, then previews the SVG", async () => {
    const onPreview = vi.fn();
    render(<GenerateTab botId="b1" onPreview={onPreview} />);
    const btn = screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Describe your avatar" }), { target: { value: "a teal cloud" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await vi.waitFor(() => expect(onPreview).toHaveBeenCalledWith({ mime: "image/svg+xml", bytesBase64: expect.any(String) }));
    expect(window.synapse.call).toHaveBeenCalledWith("generateAgentAvatar", { id: "b1", prompt: "a teal cloud" });
  });

  it("upload checks size and type (≤5 MB; png/jpg/webp/gif/svg)", () => {
    expect(checkImage({ size: 10, type: "image/png" })).toBeNull();
    expect(checkImage({ size: 6 * 1024 * 1024, type: "image/png" })).toBe("Images can be at most 5 MB.");
    expect(checkImage({ size: 10, type: "image/bmp" })).toBe("Use a PNG, JPG, WebP, GIF or SVG image.");
  });

  it("the drop/paste zone has an accessible name", () => {
    render(<UploadTab onPreview={vi.fn()} />);
    const zone = screen.getByLabelText(STR5.dropImage);
    expect(zone.tabIndex).toBe(0);
  });
});

describe("AvatarEditor error handling and pending-image reset (fix round 1, Task 25)", () => {
  const baseProps = {
    botId: "b1",
    shape: "pebble" as const,
    color: "#ffffff",
    onSave: vi.fn(),
    onImageSaved: vi.fn(),
    onCancel: vi.fn(),
  };

  it("Escape closes the editor and returns focus to the trigger (controller ruling 3)", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const onCancel = vi.fn();
    render(<AvatarEditor {...baseProps} hasImage={false} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  // fix-ui-botadmin: clearing the stored photo moved off "Reset" (which now only undoes unsaved edits) onto its
  // own labelled "Remove photo" action. Same command, same assertions — only the control that fires it changed.
  it("shows an error (not an unhandled rejection) when clearing the avatar fails, and does not report success", async () => {
    const onImageSaved = vi.fn();
    (window as unknown as { synapse: { call: ReturnType<typeof vi.fn> } }).synapse.call = vi.fn(async (cmd: string) => {
      if (cmd === "clearAgentAvatar") return { ok: false, error: { code: "boom", message: "Could not clear avatar" } };
      return { ok: true, result: {} };
    });
    render(<AvatarEditor {...baseProps} hasImage={true} onImageSaved={onImageSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not clear avatar");
    expect(onImageSaved).not.toHaveBeenCalled();
  });

  it("shows an error when saving a pending avatar fails, instead of an unhandled rejection", async () => {
    const onImageSaved = vi.fn();
    (window as unknown as { synapse: { call: ReturnType<typeof vi.fn> } }).synapse.call = vi.fn(async (cmd: string) => {
      if (cmd === "generateAgentAvatar") return { ok: true, result: { svg: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>' } };
      if (cmd === "setAgentAvatarBytes") return { ok: false, error: { code: "boom", message: "Could not save avatar" } };
      return { ok: true, result: {} };
    });
    render(<AvatarEditor {...baseProps} hasImage={false} onImageSaved={onImageSaved} />);
    fireEvent.click(screen.getByRole("tab", { name: "Generate" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Describe your avatar" }), { target: { value: "a teal cloud" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByAltText("");
    fireEvent.click(screen.getByRole("button", { name: "Set avatar" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not save avatar");
    expect(onImageSaved).not.toHaveBeenCalled();
  });

  // Materials and motion kits are retired: the current avatar has one flat look and one measured
  // motion. The editor offers neither and saves exactly the shape and colour.
  it("offers no material or motion kit, and saves exactly the shape and colour", () => {
    const onSave = vi.fn();
    render(<AvatarEditor {...baseProps} hasImage={false} onSave={onSave} />);
    for (const name of ["Matte", "Glass", "Grain", "Glow", "Calm", "Curious", "Kinetic", "Stoic"]) expect(screen.queryByRole("button", { name }), name).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Gem shape" }));
    fireEvent.click(screen.getByRole("button", { name: "Set avatar" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]).toEqual(["gem", "#ffffff"]);
  });

  it("clears the pending generated/uploaded image when switching back to the Bot tab", async () => {
    render(<AvatarEditor {...baseProps} hasImage={false} />);
    fireEvent.click(screen.getByRole("tab", { name: "Generate" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Describe your avatar" }), { target: { value: "a teal cloud" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByAltText("");
    expect((screen.getByRole("button", { name: "Set avatar" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Bot" }));
    expect((screen.getByRole("button", { name: "Set avatar" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
