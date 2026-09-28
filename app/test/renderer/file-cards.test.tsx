// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STR, type SendMessageEntry } from "@synapse/shared";
import { FileCard } from "../../src/renderer/components/FileCard";
import { FilePreview } from "../../src/renderer/components/FilePreview";
import { parseCsv, previewKind } from "../../src/renderer/file-loader";
import { installFakeBridge } from "./fake-bridge";

const card = (over: Partial<Extract<SendMessageEntry["message"], { type: "attachment" }>> = {}): SendMessageEntry => ({
  kind: "send-message", id: "t1s1", requestId: "r", createdAt: 1,
  message: { type: "attachment", url: "file:///workspace/report.pdf", name: "report.pdf", size: 1_200_000, mime: "application/pdf", pages: 12, caption: "Here's the report.", ...over },
});

describe("file cards (FILE-03)", () => {
  let bridge: ReturnType<typeof installFakeBridge>;
  beforeEach(() => { bridge = installFakeBridge({ readWorkspaceFile: { chunkBase64: btoa("a,b\n1,2\n"), size: 8, mime: "text/csv", eof: true } }); });
  afterEach(cleanup);

  it("shows name, caption, size and pages on one line, and Save calls the native save", () => {
    render(<FileCard botId="b" entry={card()} />);
    expect(screen.getByText("report.pdf")).toBeTruthy();
    // The caption used to be a paragraph stranded ABOVE the card; it is the file's own second line.
    expect(screen.getByText("Here's the report. · 1.1 MB · 12 pages")).toBeTruthy();
    expect(screen.queryByText("Here's the report."), "and not a bubble of its own").toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `${STR.save} report.pdf` }));
    expect((window.synapse.saveFile as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual([{ path: "/workspace/report.pdf", name: "report.pdf" }]);
  });

  it("classifies preview kinds", () => {
    expect(previewKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(previewKind("text/markdown", "a.md")).toBe("markdown");
    expect(previewKind("text/plain", "a.py")).toBe("text");
    expect(previewKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx")).toBe("xlsx");
    expect(previewKind("text/html", "a.html")).toBe("html");
    expect(previewKind("application/zip", "a.zip")).toBe("none");
    expect(parseCsv('a,"b,c"\n1,"2 ""x"""\n')).toEqual([["a", "b,c"], ["1", '2 "x"']]);
  });

  it("previews a CSV as a table and HTML in a sandboxed iframe", async () => {
    render(<FilePreview path="/workspace/a.csv" name="a.csv" mime="text/csv" onClose={() => {}} />);
    expect(await screen.findByRole("cell", { name: "2" })).toBeTruthy();
    expect(bridge.calls.at(-1)).toEqual(["readWorkspaceFile", { path: "/workspace/a.csv", offset: 0, length: 4 * 1024 * 1024 }]);
  });

  it("opens https attachments externally instead of previewing", () => {
    render(<FileCard botId="b" entry={card({ url: "https://example.com/deck.pptx", name: "deck.pptx", size: null, pages: null, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })} />);
    expect(screen.getByRole("link", { name: /deck\.pptx/ }).getAttribute("href")).toBe("https://example.com/deck.pptx");
  });

  it("surfaces a failed Save instead of an unhandled rejection (fix round 1, finding 2)", async () => {
    (window.synapse.saveFile as unknown as { mockRejectedValueOnce(v: unknown): void }).mockRejectedValueOnce(new Error("disk full"));
    render(<FileCard botId="b" entry={card()} />);
    fireEvent.click(screen.getByRole("button", { name: `${STR.save} report.pdf` }));
    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
  });

  it("FilePreview also surfaces a failed Save instead of an unhandled rejection (fix round 1, finding 2)", async () => {
    (window.synapse.saveFile as unknown as { mockRejectedValueOnce(v: unknown): void }).mockRejectedValueOnce(new Error("disk full"));
    render(<FilePreview path="/workspace/notes.txt" name="notes.txt" mime="text/plain" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: STR.save }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((el) => el.textContent?.includes("disk full"))).toBe(true));
  });

  it("FilePreview closes on Escape (Task 37 E2E finding)", () => {
    let closed = 0;
    render(<FilePreview path="/workspace/notes.md" name="notes.md" mime="text/markdown" onClose={() => { closed++; }} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(1);
  });
});
