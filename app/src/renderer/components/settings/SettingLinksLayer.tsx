import { useEffect, useRef, useState } from "react";
import { STR5 } from "@synapse/shared";
import { botSettingLink, settingLink, slugRow, takePendingFocus } from "../../deep-links";
import { LinkIcon } from "../Icons";

function rowId(row: HTMLElement): string {
  if (row.dataset.setting) return row.dataset.setting;
  // Prefer a leaf label/span/h3 (one with no further label/span/h3 nested inside it) so a
  // wrapper that groups a label with a muted description in nested spans doesn't have its
  // whole subtree's text concatenated together.
  const candidates = row.querySelectorAll<HTMLElement>("label, span, h3");
  let el: HTMLElement | undefined;
  for (const c of candidates) {
    if (!c.querySelector("label, span, h3")) { el = c; break; }
  }
  const label = (el ?? candidates[0])?.textContent ?? row.textContent ?? "";
  return slugRow(label.trim().split("\n")[0]!.slice(0, 60));
}

function scopeOf(el: HTMLElement): { scope: string; link(row: string): string } | null {
  const sec = el.closest<HTMLElement>("[data-settings-section]");
  if (sec) return { scope: `section:${sec.dataset.settingsSection}`, link: (r) => settingLink(sec.dataset.settingsSection!, r) };
  const bot = el.closest<HTMLElement>("[data-bot-settings]");
  if (bot) return { scope: `bot:${bot.dataset.botSettings}`, link: (r) => botSettingLink(bot.dataset.botSettings!, r) };
  return null;
}

/** SET-18 for every settings row, without per-row wiring: hover a `.settings-row` to get its link. */
export function SettingLinksLayer() {
  const ref = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState<{ row: HTMLElement; top: number; right: number } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const s = scopeOf(ref.current!);
    const target = s && takePendingFocus(s.scope);
    const t = setTimeout(() => {
      if (!target) return;
      const row = [...host.querySelectorAll<HTMLElement>(".settings-row")].find((r) => rowId(r) === target);
      if (!row) return;
      row.scrollIntoView?.({ block: "center" });
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 2000);
    }, 30);
    const over = (e: MouseEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".settings-row");
      if (!row || !host.contains(row)) return;
      const hb = host.getBoundingClientRect();
      const rb = row.getBoundingClientRect();
      // Hand-testing round: `.setting-link` is absolutely positioned inside `.settings-content`,
      // which scrolls — so its containing block is the SCROLLED content, not the visible box.
      // Without `host.scrollTop` the icon was drawn scrollTop px above the hovered row: beside an
      // unrelated row at partial scroll, or clipped out of view entirely at the bottom of Usage.
      setHover({ row, top: rb.top - hb.top + host.scrollTop + rb.height / 2 - 12, right: 4 });
    };
    const out = (e: MouseEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".settings-row");
      if (!row || !host.contains(row)) return;
      const related = e.relatedTarget as Node | null;
      if (related && (row.contains(related) || ref.current?.contains(related))) return;
      setHover((h) => (h?.row === row ? null : h));
    };
    // Scrolling moves the row out from under both the cursor and the icon, so the placement is
    // stale the moment the pane moves: drop it and let the next mouseover re-measure.
    const scrolled = () => setHover(null);
    host.addEventListener("mouseover", over);
    host.addEventListener("mouseout", out);
    host.addEventListener("scroll", scrolled);
    return () => { clearTimeout(t); host.removeEventListener("mouseover", over); host.removeEventListener("mouseout", out); host.removeEventListener("scroll", scrolled); };
  }, []);
  const copy = async () => {
    if (!hover || !ref.current) return;
    const s = scopeOf(ref.current);
    if (!s) return;
    await navigator.clipboard.writeText(s.link(rowId(hover.row)));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <span ref={ref} className="setting-links">
      {hover && <button type="button" className="icon-btn setting-link" style={{ top: hover.top, right: hover.right }} aria-label={STR5.copyLink} title={STR5.copyLink} onClick={() => void copy()}><LinkIcon /></button>}
      {copied && <span role="status" className="link-copied">{STR5.linkCopied}</span>}
    </span>
  );
}
