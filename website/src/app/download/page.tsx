import type { Metadata } from "next";
import Link from "next/link";
import { InstallSteps, Requirements, Updates } from "@/components/product-copy";
import { formatBytes, formatPublished, getDmg, sourceLabel } from "@/lib/release";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Download",
  description:
    "Download Synapse for Apple silicon. Install OrbStack, open the disk image, and use right-click → Open the first time.",
  alternates: { canonical: "/download" },
};

export default async function DownloadPage() {
  const dmg = await getDmg();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Synapse",
    operatingSystem: "macOS 14 or later",
    applicationCategory: "UtilitiesApplication",
    softwareVersion: dmg.version,
    downloadUrl: dmg.url,
    softwareRequirements: "Apple silicon, macOS 14 or later, OrbStack, an Anthropic API key",
    license: "https://opensource.org/license/mit",
    description: SITE.description,
  };

  return (
    <div className="wrap home">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1>Download</h1>
      <p className="lede">The Mac app, for Apple silicon.</p>
      <section className="release" aria-labelledby="release-name">
        {dmg.prerelease ? <span className="badge">Prerelease</span> : null}
        <h2 id="release-name">{dmg.releaseName}</h2>
        <p className="meta">
          <a href={dmg.url}>{dmg.assetName}</a>
          {dmg.size !== null ? ` · ${formatBytes(dmg.size)}` : null}
          {dmg.publishedAt ? ` · ${formatPublished(dmg.publishedAt)}` : null}
        </p>
        <p className="meta">{sourceLabel(dmg.source)}. Drafts are skipped. Prereleases count.</p>
        {dmg.notice ? (
          <p className="note">
            The GitHub release list could not be read ({dmg.notice}). This file is the configured fallback in{" "}
            <code>website/release.config.ts</code>.
          </p>
        ) : null}
        <div className="actions">
          <a className="button" href={dmg.url}>
            Download DMG
          </a>
          <a className="button button-quiet" href={dmg.releaseUrl}>
            This release
          </a>
        </div>
        <p className="meta">
          <a href={SITE.releases}>All releases</a>. Each release also carries the updater zip, its checksum and
          signature, and the GPL source archives for the bundled voice.
        </p>
      </section>

      <div className="prose">
        <h2 id="steps">Install</h2>
        <InstallSteps download={<a href={dmg.url}>{dmg.assetName}</a>} />

        <h2 id="requirements">Requirements</h2>
        <Requirements />

        <h2 id="updates">Updates</h2>
        <Updates />
        <p>
          The same steps are in the <Link href="/docs/install">install guide</Link>.
        </p>
      </div>
    </div>
  );
}
