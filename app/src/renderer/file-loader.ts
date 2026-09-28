import { LIMITS } from "@synapse/shared";
import { call } from "./bridge";

export type PreviewKind = "image" | "pdf" | "markdown" | "text" | "csv" | "xlsx" | "html" | "audio" | "video" | "none";
const TEXT_EXT = /\.(txt|log|json|ya?ml|xml|toml|ini|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|sql|css|lua|r|scala|dart|ipynb|eml)$/i;

export function previewKind(mime: string, name: string): PreviewKind {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown" || /\.md$/i.test(name)) return "markdown";
  if (mime === "text/csv" || mime === "text/tab-separated-values") return "csv";
  if (/spreadsheetml|ms-excel/.test(mime) || /\.xlsx$/i.test(name)) return "xlsx";
  if (mime === "text/html") return "html";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || TEXT_EXT.test(name)) return "text";
  return "none";
}

/** How much of a file a preview of this kind may load: video and audio get the cap uploads allow. */
export function previewMaxBytes(kind: PreviewKind): number {
  return kind === "video" || kind === "audio" ? LIMITS.attachmentVideoMaxBytes : LIMITS.attachmentDocMaxBytes;
}

/** Reads a workspace file, up to `maxBytes`. `truncated` says the file was longer than that — callers
 *  must not render the partial bytes as if they were the whole file. */
export async function loadFile(path: string, maxBytes = LIMITS.attachmentDocMaxBytes): Promise<{ bytes: Uint8Array; mime: string; truncated: boolean }> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let mime = "application/octet-stream";
  let truncated = false;
  for (;;) {
    const r = await call("readWorkspaceFile", { path, offset, length: LIMITS.fileReadChunkBytes });
    mime = r.mime;
    const bin = atob(r.chunkBase64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    parts.push(u);
    offset += u.length;
    if (r.eof || !u.length) break;
    if (offset >= maxBytes) { truncated = true; break; }
  }
  const out = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return { bytes: out, mime, truncated };
}

export function parseCsv(text: string, sep = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
