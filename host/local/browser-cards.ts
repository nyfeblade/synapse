import fs from "node:fs";
import type { BrowserReply, BrowserSessionCardView, BrowserUsageView } from "@synapse/shared";
import type { BotService } from "../bots/bot-service";
import { postCard, updateCard } from "../phase5/cards";
import type { TurnSlot } from "../runner/turn-slot";

const WEEK = 7 * 86_400_000;
type Counts = { actions: number; screenshots: number; outlineChars: number };
interface Persisted { week: number; total: Counts; byBot: Record<string, Counts> }

/**
 * mac-browser: the chat card for a Bot's browser session (page title, steps, Show window) and the week's usage.
 * Screenshots are counted apart from text actions (they cost ~1.2k tokens each; an outline step costs tens to hundreds).
 */
export class BrowserCards {
  private cards = new Map<string, { entryId: string; view: BrowserSessionCardView }>();
  private u: Persisted;

  constructor(private d: { bots: Pick<BotService, "appendEntry" | "updateEntry" | "getEntry">; now(): number; file?: string; log?(line: string): void }) {
    this.u = this.load();
  }

  record(botId: string, slot: TurnSlot | null, r: BrowserReply): void {
    const shot = !!r.image;
    this.count(botId, { actions: 1, screenshots: shot ? 1 : 0, outlineChars: r.text.length });
    if (shot) this.d.log?.(`browser: screenshot for ${botId} (${r.url})`);
    const cur = this.cards.get(botId);
    const view: BrowserSessionCardView = {
      kind: "browser-session", session: r.session, title: r.title || r.url, url: r.url, steps: r.steps,
      screenshots: (cur && cur.view.session === r.session ? cur.view.screenshots : 0) + (shot ? 1 : 0), status: r.status,
    };
    if (cur && cur.view.session === r.session) {
      cur.view = view;
      updateCard(this.d.bots as BotService, botId, cur.entryId, view);
      return;
    }
    if (!slot) return;
    this.cards.set(botId, { entryId: postCard({ bots: this.d.bots as BotService, now: this.d.now }, botId, slot, view), view });
  }

  usage(): BrowserUsageView {
    this.roll();
    return { ...this.u.total, byBot: { ...this.u.byBot } };
  }

  forgetBot(botId: string): void { this.cards.delete(botId); }

  private count(botId: string, c: Counts): void {
    this.roll();
    const add = (x: Counts) => { x.actions += c.actions; x.screenshots += c.screenshots; x.outlineChars += c.outlineChars; };
    add(this.u.total);
    add((this.u.byBot[botId] ??= { actions: 0, screenshots: 0, outlineChars: 0 }));
    this.save();
  }

  private roll(): void {
    const week = Math.floor(this.d.now() / WEEK);
    if (this.u.week !== week) this.u = { week, total: { actions: 0, screenshots: 0, outlineChars: 0 }, byBot: {} };
  }

  private load(): Persisted {
    const fresh = { week: Math.floor(this.d.now() / WEEK), total: { actions: 0, screenshots: 0, outlineChars: 0 }, byBot: {} };
    if (!this.d.file) return fresh;
    try {
      const p = JSON.parse(fs.readFileSync(this.d.file, "utf8")) as Persisted;
      return typeof p.week === "number" && p.total && p.byBot ? p : fresh;
    } catch { return fresh; }
  }

  private save(): void {
    if (!this.d.file) return;
    try {
      const tmp = `${this.d.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.u), { mode: 0o600 });
      fs.renameSync(tmp, this.d.file);
    } catch { /* best effort */ }
  }
}
