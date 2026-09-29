import fs from "node:fs";
import path from "node:path";
import { renderMarkdown, type RenderedMarkdown } from "./markdown";

export interface MarkdownDoc {
  slug: "api-key" | "google" | "phone" | "portable-install";
  file: string;
  fallbackDescription: string;
}

export const MARKDOWN_DOCS: readonly MarkdownDoc[] = [
  {
    slug: "api-key",
    file: "docs/api-key-auth.md",
    fallbackDescription: "How Synapse uses an Anthropic API key, and what it does not use.",
  },
  {
    slug: "google",
    file: "docs/google-setup.md",
    fallbackDescription: "Connect Gmail, Calendar and Drive with your own Google Cloud OAuth client.",
  },
  {
    slug: "phone",
    file: "docs/phone-access.md",
    fallbackDescription: "Call your Bots from a phone on your own Tailscale network.",
  },
  {
    slug: "portable-install",
    file: "docs/portable-install.md",
    fallbackDescription: "Build the DMG and prove it on a fresh Mac.",
  },
];

export type MarkdownSlug = MarkdownDoc["slug"];

export interface LoadedDoc extends RenderedMarkdown {
  slug: MarkdownSlug;
  description: string;
}

/** Repo root when commands are run from the website package (Vercel Root Directory: website). */
export function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

export function markdownSlug(value: string): MarkdownSlug | null {
  const found = MARKDOWN_DOCS.find((doc) => doc.slug === value);
  return found ? found.slug : null;
}

export function loadMarkdownDoc(slug: MarkdownSlug): LoadedDoc {
  const doc = MARKDOWN_DOCS.find((item) => item.slug === slug);
  if (!doc) throw new Error(`Unknown doc ${slug}`);
  const full = path.join(repoRoot(), doc.file);
  const markdown = fs.readFileSync(full, "utf8");
  const rendered = renderMarkdown(markdown);
  return {
    slug,
    ...rendered,
    description: doc.fallbackDescription,
  };
}
