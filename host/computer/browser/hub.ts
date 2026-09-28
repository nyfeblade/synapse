import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIMITSC } from "@synapse/shared";
import { readJson, writeJsonAtomic } from "../../util/atomic-json";
import type { DisplayManager } from "../displays";
import type { BrowserConnector, CdpBrowser, CdpPage } from "./connector";

export interface BotTab { page: CdpPage; viewId: string; index: number; navigateError?: string }
interface ViewsState { views: Record<string, { targetId: string; url: string }> }

/** BRW-06: one dedicated tab per Bot view on that Bot's own Chromium (one Chromium per display). */
export class BrowserHub {
  private conns = new Map<number, CdpBrowser>();
  private refs = new Map<string, Map<string, number>>();
  private stateDir: string;

  constructor(private o: { displays: DisplayManager; connector: BrowserConnector; stateDir?: string }) {
    this.stateDir = o.stateDir ?? "/tmp/.bot-browser";
  }

  private stateFile(index: number): string {
    return path.join(this.stateDir, `views-${index}.json`);
  }

  private async conn(index: number, port: number): Promise<CdpBrowser> {
    let b = this.conns.get(index);
    if (!b || !b.connected()) {
      b = await this.o.connector.connect(port);
      this.conns.set(index, b);
    }
    return b;
  }

  async browser(botId: string): Promise<CdpBrowser> {
    const info = await this.o.displays.ensure(botId);
    return this.conn(info.index, info.cdpPort);
  }

  async tab(botId: string, viewId: string): Promise<BotTab> {
    const info = await this.o.displays.ensure(botId);
    this.o.displays.touch(botId);
    const b = await this.conn(info.index, info.cdpPort);
    const state = readJson<ViewsState>(this.stateFile(info.index), { views: {} });
    const v = state.views[viewId];
    const pages = await b.pages();
    let page = v ? pages.find((p) => p.targetId === v.targetId && !p.closed()) : undefined;
    if (!page && v?.url && v.url !== "about:blank") page = pages.find((p) => p.url() === v.url && !Object.values(state.views).some((o) => o.targetId === p.targetId));
    let navigateError: string | undefined;
    if (!page) {
      page = await b.newPage();
      if (v?.url && v.url !== "about:blank") {
        try {
          await page.goto(v.url, { timeoutMs: LIMITSC.navigateMs });
        } catch (err) {
          navigateError = err instanceof Error ? err.message : String(err);
          console.error(`[BrowserHub] re-adopt navigation to ${v.url} failed for view ${viewId}: ${navigateError}`);
        }
      }
    }
    await page.bringToFront();
    const tab: BotTab = { page, viewId, index: info.index, ...(navigateError ? { navigateError } : {}) };
    await this.remember(tab);
    return tab;
  }

  async setView(botId: string, viewId: string, page: CdpPage): Promise<void> {
    const info = await this.o.displays.ensure(botId);
    await this.remember({ page, viewId, index: info.index });
  }

  async remember(tab: BotTab): Promise<void> {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const file = this.stateFile(tab.index);
    const state = readJson<ViewsState>(file, { views: {} });
    state.views[tab.viewId] = { targetId: tab.page.targetId, url: tab.page.url() };
    writeJsonAtomic(file, state, 0o644);
  }

  setRefs(viewId: string, refs: Map<string, number>): void {
    this.refs.set(viewId, refs);
  }

  ref(viewId: string, ref: string): number | null {
    return this.refs.get(viewId)?.get(ref) ?? null;
  }

  /** APR-07: sha256 of the sorted "id\turl" lines of every page target plus the window generation. */
  async identity(botId: string): Promise<string | null> {
    const info = this.o.displays.info(botId);
    if (!info?.running) return null;
    const b = await this.conn(info.index, info.cdpPort);
    const lines = (await b.targets()).filter((t) => t.type === "page").map((t) => `${t.targetId}\t${t.url}`).sort();
    return createHash("sha256").update(`${lines.join("\n")}\n#gen=${this.o.displays.generation(botId)}`).digest("hex");
  }

  /** I6: also clears the element refs of the Bot's views (viewIds). */
  forget(botId: string, viewIds: string[] = []): void {
    for (const v of viewIds) this.refs.delete(v);
    const info = this.o.displays.info(botId);
    if (!info) return;
    void this.conns.get(info.index)?.close().catch(() => {});
    this.conns.delete(info.index);
  }

  async close(): Promise<void> {
    await Promise.all([...this.conns.values()].map((b) => b.close().catch(() => {})));
    this.conns.clear();
  }
}
