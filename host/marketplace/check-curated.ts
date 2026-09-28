import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CuratedEntry } from "./catalog";
import { writeJsonAtomic } from "../util/atomic-json";

export interface CheckResult { id: string; ok: boolean; status: number | string }

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } } };

export async function checkCurated(list: CuratedEntry[], fetchImpl: typeof fetch = fetch): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const e of list) {
    if (e.via !== "remote") { out.push({ id: e.id, ok: true, status: e.via }); continue; }
    try {
      const res = await fetchImpl(e.url!, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(init), signal: AbortSignal.timeout(10_000) });
      const authOk = res.status === 401 && /bearer/i.test(res.headers.get("www-authenticate") ?? "");
      out.push({ id: e.id, ok: res.ok || authOk || res.status === 405, status: res.status });
    } catch (err) {
      out.push({ id: e.id, ok: false, status: String((err as Error).message) });
    }
  }
  return out;
}

/** Atomic write (temp file + fsync + rename), matching the codebase convention in util/atomic-json.ts. */
export function persistVerified(here: string, out: CheckResult[]): void {
  writeJsonAtomic(path.join(here, "curated.verified.json"), out);
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const list = JSON.parse(fs.readFileSync(path.join(here, "curated.json"), "utf8")) as CuratedEntry[];
  const out = await checkCurated(list);
  persistVerified(here, out);
  for (const r of out) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.id} ${r.status}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main();
