// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@synapse/shared";
import { Composer } from "../../src/renderer/components/Composer";
import { ComposerAttachments } from "../../src/renderer/components/ComposerAttachments";
import { useComposer } from "../../src/renderer/composer-store";
import { useUi } from "../../src/renderer/store";
import { uploadFiles } from "../../src/renderer/uploads";
import { botFixture, installFakeBridge } from "./fake-bridge";

const refFor = (name: string, size: number) => ({ attachmentId: `${name}.id`, name, size, mime: "application/pdf", storePath: `/s/${name}`, boxPath: `/workspace/uploads/${name}` });

function bigFile(name: string, chunks: number) {
  return new File([new Uint8Array(LIMITS.uploadChunkBytes * chunks)], name, { type: "application/pdf" });
}

/** A drop event that really bubbles to window, the way a native file drop does. */
function dropOn(el: Element, files: File[]) {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files, types: ["Files"] } });
  el.dispatchEvent(ev);
}

describe("composer uploads: cancel, drop scope and the queued send", () => {
  afterEach(cleanup);
  beforeEach(() => {
    useComposer.setState({ byBot: {} });
    useUi.setState({ bots: { b: botFixture("b", "Piper") } } as never);
    try { localStorage.clear(); } catch { /* storage unavailable */ }
  });

  it("removing a chip mid-upload cancels the upload: no further chunks and the chip stays gone", async () => {
    const seen: number[] = [];
    const gates: (() => void)[] = [];
    installFakeBridge({
      uploadAttachment: (a: { offset: number; final: boolean; size: number; name: string }) => {
        seen.push(a.offset);
        return new Promise((resolve) => gates.push(() => resolve({ received: a.offset, attachment: a.final ? refFor(a.name, a.size) : null })));
      },
    });
    void uploadFiles("b", [bigFile("big.pdf", 3)]);
    await waitFor(() => expect(seen).toHaveLength(1));
    const uploadId = useComposer.getState().byBot.b!.attachments[0]!.uploadId;
    act(() => useComposer.getState().removeAttachment("b", uploadId));
    expect(useComposer.getState().byBot.b!.attachments).toEqual([]);
    gates[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(useComposer.getState().byBot.b!.attachments).toEqual([]);
    expect(seen).toHaveLength(1);
    for (const g of gates) g();
  });

  it("clearing the composer mid-upload does not let the upload re-populate it", async () => {
    const gates: (() => void)[] = [];
    installFakeBridge({
      uploadAttachment: (a: { offset: number; final: boolean; size: number; name: string }) => new Promise((resolve) => gates.push(() => resolve({ received: a.offset, attachment: a.final ? refFor(a.name, a.size) : null }))),
    });
    void uploadFiles("b", [bigFile("big.pdf", 2)]);
    await waitFor(() => expect(useComposer.getState().byBot.b!.attachments).toHaveLength(1));
    act(() => useComposer.getState().clear("b"));
    gates[0]!();
    await new Promise((r) => setTimeout(r, 20));
    expect(useComposer.getState().byBot.b!.attachments).toEqual([]);
    for (const g of gates) g();
  });

  it("a file dropped outside the chat surface is not attached, and a .botpack is left to the importer", async () => {
    const bridge = installFakeBridge({ uploadAttachment: (a: { final: boolean; size: number; name: string }) => ({ received: a.size, attachment: a.final ? refFor(a.name, a.size) : null }) });
    const { container } = render(
      <div className="window">
        <aside className="sidebar" data-testid="sidebar" />
        <main className="main"><ComposerAttachments botId="b" /></main>
      </div>,
    );
    dropOn(screen.getByTestId("sidebar"), [new File(["x"], "notes.pdf", { type: "application/pdf" })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.calls.filter(([c]) => c === "uploadAttachment")).toHaveLength(0);

    dropOn(container.querySelector("main.main")!, [new File(["x"], "team.botpack", { type: "application/octet-stream" })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.calls.filter(([c]) => c === "uploadAttachment")).toHaveLength(0);

    dropOn(container.querySelector("main.main")!, [new File(["x"], "notes.pdf", { type: "application/pdf" })]);
    await waitFor(() => expect(bridge.calls.filter(([c]) => c === "uploadAttachment")).toHaveLength(1));
  });

  it("a send queued behind an upload says so and can be cancelled", async () => {
    installFakeBridge({ sendPrompt: { accepted: true } });
    act(() => useComposer.getState().upsertAttachment("b", { uploadId: "u1", name: "notes.pdf", size: 5, mime: "application/pdf", progress: 0, ref: null, error: null }));
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.change(box, { target: { value: "look at this" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Sending when the upload finishes…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel send" }));
    await waitFor(() => expect(screen.queryByText("Sending when the upload finishes…")).toBeNull());
  });

  it("removing the uploading attachment cancels the queued send instead of firing it", async () => {
    const bridge = installFakeBridge({ sendPrompt: { accepted: true } });
    act(() => useComposer.getState().upsertAttachment("b", { uploadId: "u1", name: "notes.pdf", size: 5, mime: "application/pdf", progress: 0, ref: null, error: null }));
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.change(box, { target: { value: "look at this" } });
    fireEvent.keyDown(box, { key: "Enter" });
    act(() => useComposer.getState().removeAttachment("b", "u1"));
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.calls.filter(([c]) => c === "sendPrompt")).toHaveLength(0);
  });

  it("an upload that errors cancels the queued send instead of firing it", async () => {
    const bridge = installFakeBridge({ sendPrompt: { accepted: true } });
    act(() => useComposer.getState().upsertAttachment("b", { uploadId: "u1", name: "notes.pdf", size: 5, mime: "application/pdf", progress: 0, ref: null, error: null }));
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.change(box, { target: { value: "look at this" } });
    fireEvent.keyDown(box, { key: "Enter" });
    act(() => useComposer.getState().upsertAttachment("b", { uploadId: "u1", name: "notes.pdf", size: 5, mime: "application/pdf", progress: 0, ref: null, error: "upload failed" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.calls.filter(([c]) => c === "sendPrompt")).toHaveLength(0);
  });

  it("sending keeps the chip for an attachment that failed, so the failure is not erased", async () => {
    const bridge = installFakeBridge({ sendPrompt: { accepted: true } });
    act(() => {
      useComposer.getState().upsertAttachment("b", { uploadId: "ok", name: "good.pdf", size: 5, mime: "application/pdf", progress: 1, ref: refFor("good.pdf", 5), error: null });
      useComposer.getState().upsertAttachment("b", { uploadId: "bad", name: "bad.pdf", size: 5, mime: "application/pdf", progress: 0, ref: null, error: "upload failed" });
    });
    render(<Composer botId="b" name="Piper" running={false} />);
    const box = screen.getByRole("textbox", { name: "Message Piper" });
    fireEvent.change(box, { target: { value: "here you go" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(bridge.calls.filter(([c]) => c === "sendPrompt")).toHaveLength(1));
    await waitFor(() => expect(useComposer.getState().byBot.b!.attachments.map((a) => a.uploadId)).toEqual(["bad"]));
    expect(screen.getByText("bad.pdf")).toBeTruthy();
  });
});
