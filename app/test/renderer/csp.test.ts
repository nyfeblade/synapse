import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Task 39 fuzz: FilePreview renders images, PDFs, audio and video from blob: URLs, but the renderer
// CSP only allowed 'self' (and data: images), so those previews were blocked and stayed blank.
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/renderer/index.html"), "utf8");
const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

describe("renderer CSP (FILE-04 previews)", () => {
  it("allows blob: for image, media and frame previews and nothing remote", () => {
    for (const d of ["img-src", "media-src", "frame-src"]) expect(directive(d).split(" ")).toContain("blob:");
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(csp.replace("ws://127.0.0.1:*", "")).not.toMatch(/https?:|\*/);
  });

  // Task 30 fuzz (high): the computer preview/takeover dials the coordinator's loopback VNC proxy over ws://127.0.0.1:<port>;
  // with no connect-src, default-src 'self' blocked it ("violates … default-src 'self'"), so the screen never showed.
  it("lets the renderer open the loopback VNC WebSocket, and nothing else remote", () => {
    expect(directive("connect-src").split(" ")).toEqual(["connect-src", "'self'", "ws://127.0.0.1:*"]);
  });
});
