import fs from "node:fs";
import { dialog, type BrowserWindow } from "electron";
import { LIMITS } from "@synapse/shared";
import type { HostFetch } from "./host-fetch";

type Deps = { showSaveDialog: (win: BrowserWindow, o: { defaultPath: string }) => Promise<{ canceled: boolean; filePath?: string }> };
const defaults: Deps = { showSaveDialog: (win, o) => dialog.showSaveDialog(win, o) };

/** FILE-06: native save dialog, then 4 MiB chunks from the gateway straight to disk (through the proven host fetch). */
export async function saveFileFromGateway(win: BrowserWindow, hostFetch: HostFetch, req: { path: string; name: string }, deps: Partial<Deps> = {}): Promise<{ saved: boolean }> {
  const d = { ...defaults, ...deps };
  const choice = await d.showSaveDialog(win, { defaultPath: req.name });
  if (choice.canceled || !choice.filePath) return { saved: false };
  const out = fs.createWriteStream(choice.filePath);
  try {
    for (let offset = 0; ; ) {
      const r = await hostFetch("/api/readWorkspaceFile", { method: "POST", body: JSON.stringify({ path: req.path, offset, length: LIMITS.fileReadChunkBytes }) });
      const j = (await r.json()) as { ok: boolean; result?: { chunkBase64: string; eof: boolean }; error?: { message: string } };
      if (!j.ok || !j.result) throw new Error(j.error?.message ?? "download failed");
      const chunk = Buffer.from(j.result.chunkBase64, "base64");
      if (!out.write(chunk)) await new Promise<void>((res) => out.once("drain", () => res()));
      offset += chunk.length;
      if (j.result.eof || !chunk.length) break;
    }
  } finally {
    await new Promise<void>((res) => out.end(res));
  }
  return { saved: true };
}
