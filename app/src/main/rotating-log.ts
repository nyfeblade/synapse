import fs from "node:fs";
import path from "node:path";

/**
 * Bug 105: a small size-capped log file (name, name.1 … name.<keep>) so the dictation / voice
 * helper's narration survives the session and a field failure can be read back afterwards. Each
 * call is one line: control characters are flattened, so helper output can't forge extra lines.
 * Writing is best-effort: a log that can't be written must never break dictation.
 */
export function createRotatingLog(o: { dir: string; name: string; maxBytes: number; keep: number; now?: () => Date }): (line: string) => void {
  const file = path.join(o.dir, o.name);
  let size = -1;
  const rotate = () => {
    for (let i = o.keep; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      try { fs.renameSync(from, `${file}.${i}`); } catch { /* not there yet */ }
    }
    size = 0;
  };
  return (line: string) => {
    try {
      const text = `${(o.now?.() ?? new Date()).toISOString()} ${line.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "")}\n`;
      const bytes = Buffer.byteLength(text);
      if (size < 0) {
        fs.mkdirSync(o.dir, { recursive: true });
        try { size = fs.statSync(file).size; } catch { size = 0; }
      }
      if (size > 0 && size + bytes > o.maxBytes) rotate();
      fs.appendFileSync(file, text, { mode: 0o600 });
      size += bytes;
    } catch {
      /* best effort */
    }
  };
}
