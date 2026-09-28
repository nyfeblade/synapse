import path from "node:path";

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation", rtf: "application/rtf",
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", yaml: "application/yaml", yml: "application/yaml", xml: "application/xml",
  txt: "text/plain", md: "text/markdown", html: "text/html", htm: "text/html", css: "text/css",
  eml: "message/rfc822", msg: "application/vnd.ms-outlook", mbox: "application/mbox", ipynb: "application/x-ipynb+json",
};
const CODE = ["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "zsh", "sql", "toml", "ini", "lua", "r", "scala", "dart"];

const ext = (name: string) => path.extname(name).slice(1).toLowerCase();
export function mimeOf(name: string): string {
  const e = ext(name);
  return TYPES[e] ?? (CODE.includes(e) ? "text/plain" : "application/octet-stream");
}
export const isAllowedAttachment = (name: string) => ext(name) in TYPES || CODE.includes(ext(name));
export const isVideo = (mime: string) => mime.startsWith("video/");
export const isImageBlockType = (mime: string): mime is "image/png" | "image/jpeg" | "image/gif" | "image/webp" => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
}
