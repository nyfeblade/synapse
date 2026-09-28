import { LIMITSC } from "@synapse/shared";
import type { DisplayManager } from "../displays";
import type { BrowserConnector, CdpBrowser } from "./connector";

export interface Cookie { name: string; value: string; domain: string; path: string; expires: number; secure: boolean; httpOnly: boolean; sameSite?: string }
export const cookieKey = (c: Cookie) => `${c.domain}\t${c.path}\t${c.name}`;
const sig = (c: Cookie) => `${c.value}\t${c.expires}\t${c.secure}\t${c.httpOnly}\t${c.sameSite ?? ""}`;

/** SEC-09: the primary Chromium on :1 holds the shared login state; every running screen is kept in step through CDP. */
export class CookieSync {
  private seen = new Map<number, Map<string, string>>(); // per display: key → signature last seen there
  private timer: NodeJS.Timeout | null = null;
  private conns = new Map<number, CdpBrowser>();

  constructor(private o: { connector: BrowserConnector; displays: DisplayManager; everyMs?: number }) {}

  private async conn(index: number): Promise<CdpBrowser> {
    let b = this.conns.get(index);
    if (!b || !b.connected()) {
      b = await this.o.connector.connect(LIMITSC.cdpBase + index);
      this.conns.set(index, b);
    }
    return b;
  }

  private async read(index: number): Promise<Cookie[]> {
    return ((await (await this.conn(index)).browserSend<{ cookies: Cookie[] }>("Storage.getCookies")).cookies ?? []);
  }

  private async write(index: number, cookies: Cookie[]): Promise<void> {
    if (cookies.length) await (await this.conn(index)).browserSend("Storage.setCookies", { cookies });
  }

  /** CDP's Storage domain has no deleteCookies (T29 box finding); setting the cookie already expired deletes it. */
  private async remove(index: number, keys: string[]): Promise<void> {
    if (!keys.length) return;
    const cookies = keys.map((k) => { const [domain, path, name] = k.split("\t"); return { name, value: "", domain, path, expires: 1 }; });
    await (await this.conn(index)).browserSend("Storage.setCookies", { cookies });
  }

  private remember(index: number, cookies: Cookie[]): void {
    this.seen.set(index, new Map(cookies.map((c) => [cookieKey(c), sig(c)])));
  }

  /** Called when a screen starts: copy the shared jar into it. */
  async seed(index: number): Promise<void> {
    const shared = await this.read(LIMITSC.primaryDisplay);
    await this.write(index, shared);
    this.remember(index, await this.read(index));
    this.remember(LIMITSC.primaryDisplay, shared);
  }

  /** Changes seen on any screen since the last pass go to the primary and to every other running screen.
   *  A cookie that disappeared from a screen since the last pass (e.g. a logout) is deleted everywhere else too. */
  async sync(): Promise<{ pushed: number }> {
    const screens = [LIMITSC.primaryDisplay, ...this.o.displays.list().filter((d) => d.running).map((d) => d.index)];
    const current = new Map<number, Cookie[]>();
    for (const i of screens) current.set(i, await this.read(i).catch(() => []));
    const changed = new Map<string, Cookie>();
    const removed = new Set<string>();
    for (const [i, cookies] of current) {
      const before = this.seen.get(i);
      if (!before) continue;
      const currentKeys = new Set(cookies.map(cookieKey));
      for (const c of cookies) if (before.get(cookieKey(c)) !== sig(c)) changed.set(cookieKey(c), c);
      for (const k of before.keys()) if (!currentKeys.has(k)) removed.add(k);
    }
    for (const k of removed) changed.delete(k);
    let pushed = 0;
    for (const [i, cookies] of current) {
      const have = new Map(cookies.map((c) => [cookieKey(c), sig(c)]));
      const need = [...changed.values()].filter((c) => have.get(cookieKey(c)) !== sig(c));
      await this.write(i, need).catch(() => {});
      pushed += need.length;
      const toRemove = [...removed].filter((k) => have.has(k));
      await this.remove(i, toRemove).catch(() => {});
      const remaining = cookies.filter((c) => !changed.has(cookieKey(c)) && !removed.has(cookieKey(c)));
      this.remember(i, [...remaining, ...changed.values()]);
    }
    return { pushed };
  }

  start(): void {
    this.timer ??= setInterval(() => void this.sync().catch(() => {}), this.o.everyMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
