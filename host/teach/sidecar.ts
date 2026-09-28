import fs from "node:fs";
import path from "node:path";
import { log } from "../util/log";
import { writeJsonAtomic } from "../util/atomic-json";
import type { CdpLike } from "./cdp";
import type { SidecarHandle } from "./recorder";
import { redactField, redactUrl } from "./redact";
import { XinputParser, type RawXEvent, type XInputLike } from "./xinput";

export type { SidecarHandle } from "./recorder";

type Win = { title: string; class: string };
export type SidecarEvent =
  | { t: number; type: "pointer"; action: "down" | "up" | "scroll"; x: number; y: number; button: number; window: Win }
  | { t: number; type: "key"; key: string }
  | { t: number; type: "text"; chars: number }
  | { t: number; type: "nav"; url: string; title: string; tabId: string }
  | { t: number; type: "target"; role: string; name: string; url: string | null; bbox: [number, number, number, number] | null; window?: Win }
  | { t: number; type: "field"; role: string; name: string; inputType: string; value: string }
  | { t: number; type: "snapshot"; file: string };

const MODIFIERS: Record<string, "ctrl" | "alt" | "super" | "shift"> = {
  Control_L: "ctrl", Control_R: "ctrl", Alt_L: "alt", Alt_R: "alt", Meta_L: "alt", Meta_R: "alt", Super_L: "super", Super_R: "super", Shift_L: "shift", Shift_R: "shift",
};
const PRINTABLE_NAMES = new Set(["space", "period", "comma", "minus", "equal", "slash", "backslash", "semicolon", "apostrophe", "bracketleft", "bracketright", "grave", "plus", "at", "numbersign", "dollar", "percent", "ampersand", "asterisk", "parenleft", "parenright", "underscore", "colon", "quotedbl", "less", "greater", "question", "exclam"]);
const isPrintable = (ks: string) => ks.length === 1 || PRINTABLE_NAMES.has(ks) || /^KP_\d$/.test(ks);
const BROWSER = /chrom/;
const SNAPSHOT_DEBOUNCE_MS = 500;
const TEXT_IDLE_MS = 1000;

/** I8: a snapshot's URL (and every string in it) redacted before it is stored. */
function redactSnapshot(snap: unknown, scan: (t: string) => string, url: (u: string) => string): unknown {
  const o = snap as { url?: unknown };
  const withUrl = o && typeof o === "object" && typeof o.url === "string" ? { ...o, url: url(o.url) } : snap;
  try {
    return JSON.parse(scan(JSON.stringify(withUrl))) as unknown;
  } catch {
    return { redacted: true };
  }
}

export function startSidecar(d: {
  sessionDir: string; startedAtMs: number; xinput: XInputLike; cdp: CdpLike | null; now(): number; setTimer?(fn: () => void, ms: number): unknown; clearTimer?(t: unknown): void;
  /** I8: the Bot's scanner, applied to URLs, titles, names and snapshots before they are written. */
  redact?(text: string): string;
}): SidecarHandle {
  const scan = d.redact ?? ((t: string) => t);
  const url = (u: string) => redactUrl(u, scan);
  const setT = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const eventsFile = path.join(d.sessionDir, "events.jsonl");
  if (!fs.existsSync(eventsFile)) fs.writeFileSync(eventsFile, "");
  const t = () => d.now() - d.startedAtMs;
  const write = (e: SidecarEvent) => fs.appendFileSync(eventsFile, `${JSON.stringify(e)}\n`);
  const held = new Set<string>();
  let textCount = 0;
  let textT = 0;
  let textTimer: unknown = null;
  let lastSnapshot = -Infinity;
  let snapN = 0;
  let stopped = false;
  const pending: Promise<unknown>[] = [];

  const flushText = () => {
    if (textTimer) clearT(textTimer);
    textTimer = null;
    if (textCount) write({ t: textT, type: "text", chars: textCount });
    textCount = 0;
  };

  const snapshot = async () => {
    if (!d.cdp || t() - lastSnapshot < SNAPSHOT_DEBOUNCE_MS) return;
    lastSnapshot = t();
    const raw = await d.cdp.snapshot().catch(() => null);
    if (!raw || stopped) return;
    const snap = redactSnapshot(raw, scan, url);
    const file = `snapshots/${String(++snapN).padStart(4, "0")}.json`;
    fs.mkdirSync(path.join(d.sessionDir, "snapshots"), { recursive: true });
    writeJsonAtomic(path.join(d.sessionDir, file), snap);
    write({ t: lastSnapshot, type: "snapshot", file });
  };

  const onKey = (ev: RawXEvent) => {
    const ks = d.xinput.keysym(ev.detail);
    if (!ks) return;
    const mod = MODIFIERS[ks];
    if (mod) { if (ev.kind === "press") held.add(mod); else held.delete(mod); return; }
    if (ev.kind !== "press") return;
    const combo = ["ctrl", "alt", "super"].filter((m) => held.has(m));
    if (isPrintable(ks) && !combo.length) {
      if (!textCount) textT = t();
      textCount++;
      if (textTimer) clearT(textTimer);
      textTimer = setT(flushText, TEXT_IDLE_MS);
      return;
    }
    flushText();
    const name = ks.length === 1 ? ks.toLowerCase() : ks;
    write({ t: t(), type: "key", key: [...combo, ...(combo.length && held.has("shift") ? ["shift"] : []), name].join("+") });
  };

  const onButton = async (ev: RawXEvent) => {
    const at = t();
    const button = ev.detail;
    const scroll = button >= 4 && button <= 7;
    if (scroll && ev.kind === "release") return;
    flushText();
    const [pos, win] = await Promise.all([d.xinput.pointer(), d.xinput.activeWindow()]);
    const action = scroll ? "scroll" : ev.kind === "press" ? "down" : "up";
    if (action === "down") {
      if (BROWSER.test(win.class)) await snapshot();
      const target = d.cdp && BROWSER.test(win.class) ? await d.cdp.targetAt(pos.x, pos.y).catch(() => null) : null;
      write({ t: at, type: "pointer", action, x: pos.x, y: pos.y, button, window: win });
      write(target ? { t: at, type: "target", ...target, name: scan(target.name), url: target.url ? url(target.url) : target.url } : { t: at, type: "target", role: "window", name: scan(win.title), url: null, bbox: null, window: win });
      return;
    }
    write({ t: at, type: "pointer", action, x: pos.x, y: pos.y, button, window: win });
  };

  d.cdp?.onNavigate((e) => {
    flushText();
    write({ t: t(), type: "nav", url: url(e.url), title: scan(e.title), tabId: e.tabId }); // I8
    lastSnapshot = -Infinity;
    const timer = setT(() => void snapshot(), SNAPSHOT_DEBOUNCE_MS);
    void timer;
  });
  d.cdp?.onField((f) => write({ t: t(), type: "field", role: f.role, name: scan(f.name || f.label), inputType: f.inputType, value: scan(redactField(f)) }));

  const parser = new XinputParser();
  const loop = (async () => {
    for await (const line of d.xinput.lines) {
      if (stopped) break;
      const ev = parser.push(line);
      if (!ev) continue;
      if (ev.device === "key") onKey(ev);
      else pending.push(onButton(ev).catch((e) => log.warn("teach sidecar pointer failed", { error: String(e) })));
    }
  })();

  return {
    // Bug 47: reaching this return IS the start succeeding — xinput is attached and the writer is
    // running. The handle phase4 hands the recorder is the one that may still be waiting on it.
    started: async () => true,
    stop: async () => {
      if (stopped) return;
      d.xinput.close();
      await loop.catch(() => {});
      await Promise.all(pending);
      flushText();
      stopped = true;
      await d.cdp?.close();
    },
  };
}
