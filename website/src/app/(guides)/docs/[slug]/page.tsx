import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Guide } from "@/components/Guide";
import { loadMarkdownDoc, MARKDOWN_DOCS, markdownSlug, type MarkdownSlug } from "@/lib/docs";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams(): { slug: MarkdownSlug }[] {
  return MARKDOWN_DOCS.map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const known = markdownSlug(slug);
  if (!known) return {};
  const doc = loadMarkdownDoc(known);
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: `/docs/${known}` },
  };
}

function DocNote({ slug }: { slug: MarkdownSlug }) {
  switch (slug) {
    case "google":
      return (
        <aside className="note">
          <p>
            Where this page says Bots, it means Synapse. Some internal names still use the working name Bots.
          </p>
        </aside>
      );
    case "portable-install":
      return (
        <aside className="note">
          <p>
            The public app signs in with an Anthropic API key only. Where the fresh-user run below says &quot;Sign in
            to Claude&quot;, use the API key step on <Link href="/docs/install">Install</Link>. A Claude subscription
            or a Claude Code login is not supported (<Link href="/docs/api-key">API key</Link>).
          </p>
        </aside>
      );
    case "api-key":
    case "phone":
      return null;
    default: {
      const leftover: never = slug;
      return leftover;
    }
  }
}

export default async function MarkdownDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const known = markdownSlug(slug);
  if (!known) notFound();
  const doc = loadMarkdownDoc(known);
  return (
    <Guide title={doc.title} toc={doc.toc} note={<DocNote slug={known} />}>
      <div dangerouslySetInnerHTML={{ __html: doc.html }} />
    </Guide>
  );
}
