import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;

/** LOC-09: distinct public peers the box talked to this session (sampled from `ss`). */
export class EgressCounter {
  private peers = new Set<string>();
  constructor(private o: { run?: () => Promise<string> } = {}) {}

  async sample(): Promise<void> {
    let out = "";
    try {
      out = this.o.run ? await this.o.run() : (await promisify(execFile)("ss", ["-Htn", "state", "established"], { timeout: 5000 })).stdout;
    } catch { return; }
    for (const line of out.split("\n")) {
      const peer = line.trim().split(/\s+/).at(-1) ?? "";
      const host = peer.replace(/^\[/, "").replace(/\]?:\d+$/, "");
      if (host && !PRIVATE.test(host)) this.peers.add(host);
    }
  }

  count(): number { return this.peers.size; }
}
