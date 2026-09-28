import fs from "node:fs";
import path from "node:path";
import { log } from "../util/log";

let rssUnavailableLogged = false;

/** RSS of a process tree in bytes, read from /proc (§16.4 measures real RSS per process tree every 30 s). */
export function treeRss(pid: number, procRoot = "/proc"): number {
  const children = new Map<number, number[]>();
  let ents: string[];
  try {
    ents = fs.readdirSync(procRoot);
  } catch (e) {
    // No /proc (a host run on macOS): unknown RSS reads as 0 — never a throw out of the supervisor tick. Said once.
    if (!rssUnavailableLogged) {
      rssUnavailableLogged = true;
      log.warn("process RSS unavailable; the RSS limits are off", { procRoot, error: String(e) });
    }
    return 0;
  }
  for (const ent of ents) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const stat = fs.readFileSync(path.join(procRoot, ent, "stat"), "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const list = children.get(ppid) ?? [];
      list.push(Number(ent));
      children.set(ppid, list);
    } catch {
      /* process exited */
    }
  }
  let total = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop() as number;
    try {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(path.join(procRoot, String(p), "status"), "utf8"));
      if (m) total += Number(m[1]) * 1024;
    } catch {
      /* gone */
    }
    stack.push(...(children.get(p) ?? []));
  }
  return total;
}
