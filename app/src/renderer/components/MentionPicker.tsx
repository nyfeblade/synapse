import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { McpServerView } from "@synapse/shared";
import { call } from "../bridge";
import { useOverlays } from "../overlays";
import { useUi } from "../store";

export function mentionQuery(text: string, caret: number): string | null {
  const m = /(^|\s)@([\p{L}\p{N} _-]{0,40})$/u.exec(text.slice(0, caret));
  return m ? m[2]! : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A mention is "@name" on a word boundary, not any "@name" substring. The plain `includes` this
 * replaced also matched the "@gmail" inside "bob@gmail.com", and the host turns a mention that
 * matches a connector's name into a prompt hint — so an ordinary email address in the message
 * quietly told the Bot to use Gmail.
 */
export function extractMentions(text: string, names: string[]): string[] {
  const hit = names.filter((n) => n.trim() && new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRe(n.trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "iu").test(text));
  // "@Scout Team" mentions Scout Team, not also Scout: keep only the longest match.
  return hit.filter((n) => !hit.some((o) => o.length > n.length && o.toLowerCase().includes(n.toLowerCase())));
}

export function useMentionNames(): string[] {
  const bots = useUi((s) => s.bots);
  const [servers, setServers] = useState<McpServerView[]>([]);
  // Guarded with `?? []`: tests elsewhere mount the full Composer with a fixed-result bridge stub
  // that doesn't key its response by command name, so `r.servers` can come back `undefined` here.
  useEffect(() => { void call("listMcpServers", {}).then((r) => setServers(r.servers ?? [])).catch(() => {}); }, []);
  return [...Object.values(bots).map((b) => b.profile.name), ...servers.map((s) => s.name)];
}

export function MentionPicker({ query, names, onPick, onClose }: { query: string; names: string[]; onPick(name: string): void; onClose(): void }) {
  const [sel, setSel] = useState(0);
  const hits = useMemo(() => names.filter((n) => n.toLowerCase().startsWith(query.toLowerCase())).slice(0, 8), [names, query]);
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, hits.length - 1))), [hits.length]);
  // Capture phase, like SkillPicker: while the picker is open the arrows and Enter belong to it, not
  // to the textarea underneath — which otherwise moved the caret or sent the half-typed message.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hits.length || useOverlays.getState().open) return; // an overlay on top owns the keyboard
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); const n = hits[sel]; if (n) onPick(n); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hits, sel, onPick, onClose]);
  if (!hits.length) return null;
  return (
    <ul role="listbox" aria-label="Mention" className="picker mention-picker">
      {hits.map((n, i) => (
        <li key={n} role="option" aria-selected={i === sel} className={i === sel ? "pick selected" : "pick"}
          onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); onPick(n); }}>
          <span className="pick-label">{n}</span>
        </li>
      ))}
    </ul>
  );
}
