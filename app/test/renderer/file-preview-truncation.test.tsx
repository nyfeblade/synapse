// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@synapse/shared";
import { FilePreview } from "../../src/renderer/components/FilePreview";
import { loadFile, previewMaxBytes } from "../../src/renderer/file-loader";
import { installFakeBridge } from "./fake-bridge";

const TOO_LARGE = "This file is too large to preview. Use Save to open it outside the app.";

/** A workspace file the host streams forever: every chunk is full and `eof` never arrives. */
function endlessFile(mime: string) {
  return installFakeBridge({
    readWorkspaceFile: () => ({ chunkBase64: btoa("x".repeat(65536)), eof: false, mime }),
  });
}

describe("previewing a file the loader had to truncate (FILE-06)", () => {
  afterEach(cleanup);
  beforeEach(() => {
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:preview";
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  });

  it("loadFile reports that it stopped at the cap instead of returning a half file silently", async () => {
    endlessFile("application/pdf");
    const partial = await loadFile("/w/big.pdf", 65536);
    expect(partial.truncated).toBe(true);
    expect(partial.bytes.length).toBe(65536);
  });

  it("loadFile does not claim truncation for a file that fits", async () => {
    installFakeBridge({ readWorkspaceFile: () => ({ chunkBase64: btoa("hi"), eof: true, mime: "text/plain" }) });
    expect((await loadFile("/w/a.txt")).truncated).toBe(false);
  });

  it("a file past the cap shows a 'too large to preview' notice with Save, not a half-rendered document", async () => {
    endlessFile("application/pdf");
    const { container } = render(<FilePreview path="/w/big.pdf" name="big.pdf" mime="application/pdf" onClose={() => {}} />);
    expect(await screen.findByText(TOO_LARGE, {}, { timeout: 15_000 })).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("a file that fits is still previewed", async () => {
    installFakeBridge({ readWorkspaceFile: () => ({ chunkBase64: btoa("mp4"), eof: true, mime: "video/mp4" }) });
    const { container } = render(<FilePreview path="/w/tiny.mp4" name="tiny.mp4" mime="video/mp4" onClose={() => {}} />);
    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
    expect(screen.queryByText(TOO_LARGE)).toBeNull();
  });

  it("video and audio previews get the 200 MiB upload cap, everything else the 25 MiB document cap", () => {
    expect(previewMaxBytes("video")).toBe(LIMITS.attachmentVideoMaxBytes);
    expect(previewMaxBytes("audio")).toBe(LIMITS.attachmentVideoMaxBytes);
    expect(previewMaxBytes("pdf")).toBe(LIMITS.attachmentDocMaxBytes);
    expect(previewMaxBytes("image")).toBe(LIMITS.attachmentDocMaxBytes);
  });
});
