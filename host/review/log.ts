import fs from "node:fs";
import path from "node:path";

/** ORIG-01 §01.11: reviewer.log.jsonl in host-private storage (inputs are redacted before logging). */
export class ReviewLog {
  constructor(private file: string, private now: () => number = Date.now) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(rec: Record<string, unknown>): void {
    fs.appendFileSync(this.file, `${JSON.stringify({ ts: this.now(), ...rec })}\n`, { mode: 0o600 });
  }
}
