import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveFileFromGateway } from "../../src/main/save-file";

describe("Save (FILE-06)", () => {
  it("streams 4 MiB chunks from the gateway to the chosen path", async () => {
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "save-")), "out.bin");
    const data = Buffer.alloc(9 * 1024 * 1024, 7);
    const fetchFn = vi.fn(async (_u: string, init: { body: string }) => {
      const a = JSON.parse(init.body) as { offset: number; length: number };
      const chunk = data.subarray(a.offset, a.offset + a.length);
      return new Response(JSON.stringify({ ok: true, result: { chunkBase64: chunk.toString("base64"), size: data.length, mime: "application/octet-stream", eof: a.offset + chunk.length >= data.length } }));
    });
    const r = await saveFileFromGateway({} as never, { baseUrl: "http://g", token: "t", mode: "local", dispose: () => {} }, { path: "/workspace/big.bin", name: "big.bin" }, { showSaveDialog: async () => ({ canceled: false, filePath: dest }), fetchFn: fetchFn as never });
    expect(r).toEqual({ saved: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
  });
});
