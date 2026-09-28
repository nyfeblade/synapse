import { useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";
import { STR } from "@synapse/shared";
import { languageName } from "../voice/speech-text";
import { useExpandFlip } from "../flip";
import { confirmCopy } from "../toast";
import { FileTile, sizeLine } from "./FileCard";
import { CopyIcon } from "./Icons";
import "../styles/code-block.css";

/**
 * Code cards, in this app's neutral look: a fenced ``` block becomes a CARD (language label + Copy,
 * monospace body, collapses past ~18 lines), a very long or filename-labelled one becomes a
 * FileCard-style row instead of a wall of code, and an inline `code` span becomes a quiet chip.
 *
 * WHY CODE USED TO LAND AS PLAIN TEXT (bug-log row 193): Transcript.tsx's <Markdown> already parsed
 * fences correctly (remark-gfm) and app.css already had a `.bubble.bot pre` rule — so a fenced block
 * was never literal, unstyled backticks. What it lacked was any of the affordances a "card" implies:
 * no language label, no way to copy without a triple-click-and-select, no collapse on a long block,
 * and no distinct treatment for a whole file versus a snippet — so next to the reference design's cards, a
 * plain bordered monospace box read as "just dumped in as text". This file is the fix; Transcript.tsx and
 * the TypingBubble both route their fenced/inline code through `codeComponents` below now, including
 * mid-stream (an still-open fence is *already* a valid code node to remark — CommonMark closes an
 * unterminated fence at EOF — so a stream never shows raw backticks; it just grows the same card).
 */

export const COLLAPSE_AFTER = 18;
export const COLLAPSE_TO = 14;
export const FILE_CARD_AFTER = 120;
/**
 * bug 198: the fold above (18 → 14, "Show all N lines") answers "does this need a card at all". This
 * answers a different question — once a card IS expanded, a body running into the hundreds or
 * thousands of lines (a 500-line Read step, in the bug report) still should not paint all of them into
 * the DOM in one go. The extra lines past this cap only mount on a second, explicit "Show N more
 * lines" — the same "nothing pre-rendered, expanding just mounts more" shape `code-card-more` already
 * uses, one more time.
 */
export const RENDER_CAP = 400;

export function sentenceCase(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** A fence's info string, plus the code, parsed for a language and (optionally) a filename.
 *  Filename conventions: ```ts title=foo.ts / ```ts path=foo.ts, a bare path/extension token after
 *  the language (```ts src/app/foo.ts), or the code's own first line reading `// path: foo.ts`
 *  (also `#`/`--`/`;` comment styles, `file`/`filename` in place of `path`) — the first line is then
 *  dropped from the displayed code, the way a Bot's own such marker is not meant to be read as code. */
export function parseFence(info: string | undefined, rawCode: string): { language: string; filename: string | null; code: string } {
  const tokens = (info ?? "").trim().split(/\s+/).filter(Boolean);
  const language = (tokens[0] ?? "").toLowerCase();
  let filename: string | null = null;
  for (const t of tokens.slice(1)) {
    const kv = /^(?:title|path|filename)=(.+)$/i.exec(t);
    if (kv) { filename = kv[1]!.replace(/^["']|["']$/g, ""); break; }
    if (/[\\/]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t)) { filename = t; break; }
  }
  let code = rawCode.replace(/\n$/, "");
  if (!filename) {
    const lines = code.split("\n");
    const m = /^(?:\/\/|#|--|;)\s*(?:path|file(?:name)?)\s*:\s*(\S+)\s*$/i.exec((lines[0] ?? "").trim());
    if (m) { filename = m[1]!; code = lines.slice(1).join("\n"); }
  }
  return { language, filename, code };
}

/** navigator.clipboard first; a hidden-textarea + execCommand fallback when it is missing or refused
 *  (older WebViews, a denied permission) — the shared `copyWithConfirmation` (toast.ts) deliberately
 *  has no such fallback (its own test locks in "the clipboard refused, so nothing was copied and
 *  nothing should say otherwise" for its five existing call sites), so a code card copies on its own
 *  and reuses only the toast's confirmation, never its policy. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ code }: { code: string }) {
  const onCopy = () => { void writeClipboard(code).then((ok) => { if (ok) confirmCopy(); }); };
  return (
    <button type="button" className="icon-btn code-card-copy" aria-label={STR.copyCode} title={STR.copyCode} onClick={onCopy}>
      <CopyIcon />
    </button>
  );
}

/** The card itself: header (language + Copy) and a monospace body, collapsing past COLLAPSE_AFTER
 *  lines. The extra lines only exist in the DOM once expanded (`.code-card-more`, code-block.css's
 *  `step-in` reuse) rather than being always-present-but-clipped, so there is nothing to transition
 *  on `max-height` (a LAYOUT property `interaction-states.test.ts` bans outright) — expanding simply
 *  mounts new content, which is what animates in, exactly like `ActivityGroup`'s `.steps`. */
export function CodeCardBody({ language, code }: { language: string; code: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useExpandFlip(ref, expanded || showAll);
  const lines = useMemo(() => code.split("\n"), [code]);
  const long = lines.length > COLLAPSE_AFTER;
  const head = long ? lines.slice(0, COLLAPSE_TO).join("\n") : code;
  const restAll = long && expanded ? lines.slice(COLLAPSE_TO) : [];
  const capped = restAll.length > RENDER_CAP && !showAll;
  const rest = long && expanded ? (capped ? restAll.slice(0, RENDER_CAP) : restAll).join("\n") : null;
  return (
    <div ref={ref} className="code-card">
      <div className="code-card-head">
        <span className="code-card-lang">{language || "Code"}</span>
        <CopyButton code={code} />
      </div>
      <div className={`code-card-body${long && !expanded ? " is-collapsed" : ""}`}>
        <pre className="code-card-pre"><code>{head}</code></pre>
        {/* A freshly-mounted element on expand, not a text-content change on the one above: it is
            what lets the plain CSS `animation` on `.code-card-more` (code-block.css) play at all —
            and, gated by nothing but the universal `prefers-reduced-motion` block (app.css), be
            skipped under it, the same way `.steps .step`'s entrance already is. */}
        {rest !== null && <pre className="code-card-pre code-card-more"><code>{rest}</code></pre>}
      </div>
      {long && (
        // fix round 1, finding 7: collapsing must also drop `showAll`, or re-expanding later skips
        // straight past the RENDER_CAP tier (stale `showAll=true` from last time) with no "Show N more
        // lines" step to animate through, and the collapse itself would otherwise leave `rest`'s size
        // silently mismatched with what `expanded` alone implies.
        <button type="button" className="card-link code-card-toggle" onClick={() => { if (expanded) setShowAll(false); setExpanded((e) => !e); }}>
          {expanded ? STR.showLess : STR.showAllLines(lines.length)}
        </button>
      )}
      {/* bug 198: a 500-line body's "Show all lines" only mounts the first RENDER_CAP of them; this is
          the second, explicit step that mounts the rest — never all of it in one paint. */}
      {expanded && capped && (
        <button type="button" className="card-link code-card-toggle" onClick={() => setShowAll(true)}>
          {STR.showMoreLines(restAll.length - RENDER_CAP)}
        </button>
      )}
    </div>
  );
}

/** The FileCard-style row for a very long or filename-labelled block: name, line count and size up
 *  front; a click expands the same card body inline, in place, rather than a modal — there is no
 *  real attachment entry behind this code (it never left the reply), so FilePreview's file-loader
 *  round trip does not apply here. */
export function CodeFileCard({ name, language, code }: { name: string; language: string; code: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useExpandFlip(ref, open);
  const lines = useMemo(() => code.split("\n").length, [code]);
  const size = useMemo(() => new TextEncoder().encode(code).length, [code]);
  return (
    <div ref={ref} className="file-card code-file-card">
      <button type="button" className="file-main" aria-expanded={open} aria-label={`${open ? STR.close : STR.open} ${name}`} onClick={() => setOpen((o) => !o)}>
        <FileTile name={name} />
        <span className="file-text">
          <span className="file-name">{name}</span>
          <span className="muted small">{sizeLine(size, null, `${lines} line${lines === 1 ? "" : "s"}`)}</span>
        </span>
      </button>
      {open && <CodeCardBody language={language} code={code} />}
    </div>
  );
}

function CodeCard({ lang, raw }: { lang: string; raw: string }) {
  const { language, filename, code } = useMemo(() => parseFence(lang, raw), [lang, raw]);
  const lineCount = useMemo(() => code.split("\n").length, [code]);
  const display = language ? sentenceCase(languageName(language) || language) : "";
  if (filename || lineCount > FILE_CARD_AFTER) {
    return <CodeFileCard name={filename ?? "Snippet"} language={display} code={code} />;
  }
  return <CodeCardBody language={display} code={code} />;
}

/** react-markdown v10 gives the `code` renderer no `inline` flag (removed in v9): a fenced block's
 *  <code> carries a `language-xxx` className when a language was given, but a plain ``` fence with no
 *  language has NONE — the same shape as an inline span. What a genuine inline code SPAN can never
 *  have, per CommonMark (a literal newline inside one is normalised to a space), is a `\n` in its
 *  text — so `language-` OR a newline reliably means "this is a block", in every case. */
function isFencedBlock(className: string | undefined, text: string): boolean {
  return /\blanguage-/.test(className ?? "") || text.includes("\n");
}

/** The `components` object shared by the Bot bubble and its typing/streaming bubble (Transcript.tsx)
 *  so a still-open fence mid-stream renders through the exact same card as the finished reply. */
export const codeComponents: Components = {
  code({ className, children, node }) {
    const text = String(children);
    if (!isFencedBlock(className, text)) return <code className="inline-code">{children}</code>;
    const lang = /language-(\S+)/.exec(className ?? "")?.[1] ?? "";
    // mdast/micromark split the fence's info string at its first space: `node.lang` (className above)
    // is ONLY the language word; everything after — where `title=foo.ts` / a bare path lives — is
    // `node.meta`, which mdast-util-to-hast keeps on the hast node's own `data` rather than as a DOM
    // property, so `className` alone can never see it (react-markdown's `passNode` is what recovers it).
    const meta = (node?.data as { meta?: string } | undefined)?.meta ?? "";
    return <CodeCard lang={[lang, meta].filter(Boolean).join(" ")} raw={text} />;
  },
  // The default <pre> would wrap the card above in a second box; the card IS the block's presentation.
  pre({ children }) {
    return <>{children}</>;
  },
  table({ children }) {
    return <div className="table-scroll"><table>{children}</table></div>;
  },
};
