import type { Metadata } from "next";
import Link from "next/link";
import { Features, Intro } from "@/components/product-copy";
import { DOC_NAV } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Docs",
  description: "How to install and use Synapse: the disk image, an Anthropic API key, Google, phone access and builds.",
  alternates: { canonical: "/docs" },
};

export default function DocsPage() {
  return (
    <article className="doc-body">
      <h1>Docs</h1>
      <Intro />
      <h2>Guides</h2>
      <ul className="guide-list">
        {DOC_NAV.filter((item) => item.href !== "/docs").map((item) => (
          <li key={item.href}>
            <Link href={item.href}>{item.label}</Link>
            <p>{item.description}</p>
          </li>
        ))}
      </ul>
      <h2>Features</h2>
      <Features />
      <p>
        <Link href="/download">Download the disk image</Link>
      </p>
    </article>
  );
}
