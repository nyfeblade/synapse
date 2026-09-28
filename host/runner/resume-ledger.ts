import type { WakeSource } from "../brain/types";
import { readJson, writeJsonAtomic } from "../util/atomic-json";

interface Marker { botId: string; source: WakeSource }

/** EVT-16/EVT-19: host-restart-resume.json markers, written before anything else at shutdown. */
export class ResumeLedger {
  constructor(private file: string) {}
  add(m: Marker): void {
    const f = readJson<{ version: 1; pending: Marker[] }>(this.file, { version: 1, pending: [] });
    if (!f.pending.some((x) => x.botId === m.botId)) f.pending.push(m);
    writeJsonAtomic(this.file, f, 0o600);
  }
  take(): Marker[] {
    const f = readJson<{ version: 1; pending: Marker[] }>(this.file, { version: 1, pending: [] });
    writeJsonAtomic(this.file, { version: 1, pending: [] }, 0o600);
    return f.pending;
  }
}
