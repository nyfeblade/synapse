import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { qrMatrix, qrSvg } from "../../src/main/phone/qr";
import { encodePng, iconPng, qrPng } from "../../src/main/phone/png";

// Bug 198: the Phone access QR code is made on this Mac. Proven by scanning it with macOS's own
// detector (CoreImage) — the same kind of reader a phone camera is.
const here = path.dirname(fileURLToPath(import.meta.url));
const decoder = path.join(here, "..", "fixtures", "qr-decode.swift");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-qr-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const TEXTS = [
  "https://example-mac.example-tailnet.ts.net/",
  "https://m.t.ts.net/",
  "https://a-rather-long-machine-name-for-a-mac.tail-with-a-long-name.ts.net/",
  `https://${"x".repeat(120)}.ts.net/`,
];

describe("the QR code", () => {
  it("grows with the text and stays square (versions 1-10)", () => {
    const sizes = TEXTS.map((t) => qrMatrix(t).length);
    for (const s of sizes) expect((s - 17) % 4).toBe(0);
    expect(sizes[1]).toBeLessThanOrEqual(sizes[0]!);
    expect(sizes[3]).toBeGreaterThan(sizes[2]!);
    expect(() => qrMatrix("x".repeat(400))).toThrow();
  });

  it("draws one SVG path with a quiet zone", () => {
    const s = qrSvg(TEXTS[0]!);
    expect(s.size).toBe(qrMatrix(TEXTS[0]!).length + 8);
    expect(s.path.startsWith("M")).toBe(true);
  });

  it.runIf(process.platform === "darwin")("scans back to the exact URL with CoreImage", () => {
    const files = TEXTS.map((t, i) => { const f = path.join(dir, `qr${i}.png`); fs.writeFileSync(f, qrPng(qrMatrix(t))); return f; });
    const out = execFileSync("swift", [decoder, ...files], { encoding: "utf8", timeout: 120_000 });
    const got = out.trim().split("\n").map((l) => l.split("\t")[1] ?? "");
    expect(got).toEqual(TEXTS);
  }, 150_000);
});

describe("the PNG writer", () => {
  it("writes a valid PNG signature and size", () => {
    const png = encodePng(2, 2, new Uint8Array(16).fill(255));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(2);
    const icon = iconPng(192);
    expect(icon.readUInt32BE(16)).toBe(192);
    expect(icon.readUInt32BE(20)).toBe(192);
  });
});
