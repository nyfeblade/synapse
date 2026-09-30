import { memo, type ReactElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openDeepLink, safeUrlTransform } from "../deep-links";
import { codeComponents } from "./CodeBlock";

/** GFM without single-tilde strikethrough: Bots write `~` for "approximately" (gate M-3); `~~x~~` still strikes. */
const REMARK_PLUGINS: NonNullable<Parameters<typeof Markdown>[0]["remarkPlugins"]> = [[remarkGfm, { singleTilde: false }]];

/** A Bot's markdown, in both its finished and typing/streaming form: links (Phase 5 deep links, plus the code-cards
 * spec's "open in the system browser") and code (CodeBlock.tsx — a card for a fenced block, a chip for inline
 * `code`), the two places the default renderer was not enough on its own. */
const MD_COMPONENTS: NonNullable<Parameters<typeof Markdown>[0]["components"]> = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" onClick={(e) => { if (href && openDeepLink(href)) e.preventDefault(); }}>{children}</a>,
  ...codeComponents,
};

/** How many parsed messages are kept. A long chat's worth; the oldest drop out first. */
export const MARKDOWN_CACHE_SIZE = 800;
const cache = new Map<string, ReactElement>();
let parses = 0;

/** How many times markdown was actually parsed (tests: a re-render of the same content parses nothing). */
export const markdownParses = (): number => parses;

/**
 * Bug 442: every transcript update re-parsed every message's markdown (micromark was the top of a 100-turn chat's
 * reply profile). A finished message's markdown is parsed ONCE per content: `Markdown` (react-markdown's sync,
 * hook-free renderer) is called as a function and its element tree is cached by the text itself, so a remount (a
 * Bot switched back to, a row re-keyed) reuses it too. Only the streaming bubble parses on every chunk.
 */
export function renderMarkdown(text: string): ReactElement {
  const hit = cache.get(text);
  if (hit) {
    cache.delete(text); // most recently used last
    cache.set(text, hit);
    return hit;
  }
  parses++;
  const el = Markdown({ children: text, remarkPlugins: REMARK_PLUGINS, urlTransform: safeUrlTransform, components: MD_COMPONENTS });
  cache.set(text, el);
  if (cache.size > MARKDOWN_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return el;
}

/** A finished message's markdown: parsed once per content, and skipped entirely while its text is unchanged. */
export const BotMarkdown = memo(function BotMarkdown({ text }: { text: string }) {
  return renderMarkdown(text);
});

/** The streaming reply: its text changes every chunk, so it is parsed fresh and never cached. */
export function StreamMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={REMARK_PLUGINS} urlTransform={safeUrlTransform} components={MD_COMPONENTS}>{text}</Markdown>;
}
