// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR } from "@synapse/shared";
import { ComposerAttachments } from "../../src/renderer/components/ComposerAttachments";
import { ComposerPlusMenu } from "../../src/renderer/components/ComposerPlusMenu";
import { useComposer } from "../../src/renderer/composer-store";
import { useUi } from "../../src/renderer/store";
import { uploadFiles, validateFiles } from "../../src/renderer/uploads";
import { installFakeBridge } from "./fake-bridge";

describe("attachments in the composer (CHAT-09)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => {
    bridge = installFakeBridge({
      uploadAttachment: (a: { final: boolean; size: number; name: string }) => ({ received: a.size, attachment: a.final ? { attachmentId: "abc.txt", name: a.name, size: a.size, mime: "text/plain", storePath: "/s/abc.txt", boxPath: "/workspace/uploads/a.txt" } : null }),
      getWorkflows: { workflows: [{ id: "weekly-report", name: "Weekly report", description: "", source: null, managed: false, bodyChars: 1, disabledFor: [], updatedAt: 1 }] },
    });
    useComposer.setState({ byBot: {} });
    useUi.setState({ bots: { b: { id: "b" } } } as never);
  });
  afterEach(cleanup);

  it("validates count and size", () => {
    const f = (n: string, size: number, type = "text/plain") => new File([new Uint8Array(size)], n, { type });
    expect(validateFiles(5, [f("a.txt", 1), f("b.txt", 1)])).toBe(STR.tooManyAttachments);
    expect(validateFiles(0, [f("big.pdf", 26 * 1024 * 1024, "application/pdf")])).toBe(STR.fileTooLarge("big.pdf", 25));
    expect(validateFiles(0, [f("clip.mp4", 26 * 1024 * 1024, "video/mp4")])).toBeNull();
  });

  it("uploads in chunks and shows a chip that can be removed", async () => {
    await uploadFiles("b", [new File(["hello"], "a.txt", { type: "text/plain" })]);
    expect(bridge.calls.filter(([c]) => c === "uploadAttachment")).toHaveLength(1);
    render(<ComposerAttachments botId="b" />);
    expect(screen.getByText("a.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove a.txt" }));
    expect(useComposer.getState().byBot.b!.attachments).toEqual([]);
  });

  it("the + menu offers Attach files, Photo from clipboard, Use a skill and Teach a task", async () => {
    render(<ComposerPlusMenu botId="b" />);
    fireEvent.click(screen.getByRole("button", { name: STR.attachFile }));
    expect(screen.getByRole("menuitem", { name: STR.attachFiles })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: STR.photoFromClipboard })).toBeTruthy();
    expect((screen.getByRole("menuitem", { name: STR.teachATask }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("menuitem", { name: `${STR.useASkill} ▸` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Weekly report" }));
    await waitFor(() => expect(useComposer.getState().byBot.b!.skillIds).toEqual(["weekly-report"]));
  });

  it("shows an error chip instead of hanging when the clipboard read is denied", async () => {
    (navigator as unknown as { clipboard: { read: () => Promise<unknown> } }).clipboard = {
      read: () => Promise.reject(new Error("clipboard access denied")),
    };
    render(<ComposerPlusMenu botId="b" />);
    fireEvent.click(screen.getByRole("button", { name: STR.attachFile }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.photoFromClipboard }));
    await waitFor(() => expect(useComposer.getState().byBot.b!.attachments.some((a) => a.error === "Error: clipboard access denied")).toBe(true));
  });

  it("shows an error in the skills submenu instead of going silently inert when getWorkflows rejects", async () => {
    bridge = installFakeBridge({
      getWorkflows: () => { throw new Error("network down"); },
    });
    render(<ComposerPlusMenu botId="b" />);
    fireEvent.click(screen.getByRole("button", { name: STR.attachFile }));
    fireEvent.click(screen.getByRole("menuitem", { name: `${STR.useASkill} ▸` }));
    expect(await screen.findByRole("menuitem", { name: "Error: network down" })).toBeTruthy();
  });

  it("Teach a task opens the teach setup for this Bot (TCH-01); disabled in a group chat", () => {
    useUi.setState({ bots: { b: { id: "b" }, g: { id: "g", group: { memberIds: [] } } }, teachSetupFor: null } as never);
    render(<ComposerPlusMenu botId="b" />);
    fireEvent.click(screen.getByRole("button", { name: STR.attachFile }));
    fireEvent.click(screen.getByRole("menuitem", { name: STR.teachATask }));
    expect(useUi.getState().teachSetupFor).toBe("b");
    cleanup();
    render(<ComposerPlusMenu botId="g" />);
    fireEvent.click(screen.getByRole("button", { name: STR.attachFile }));
    expect((screen.getByRole("menuitem", { name: STR.teachATask }) as HTMLButtonElement).disabled).toBe(true);
  });
});
