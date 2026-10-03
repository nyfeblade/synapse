import type { Metadata } from "next";
import Link from "next/link";
import { Guide } from "@/components/Guide";
import { PrivacyPoints } from "@/components/product-copy";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy and security",
  description: "Synapse runs on your Mac. There is no Synapse server and no telemetry. Report security issues privately.",
  alternates: { canonical: "/privacy" },
};

const TOC = [
  { id: "on-your-mac", text: "On your Mac", depth: 2 },
  { id: "reporting", text: "Reporting a problem", depth: 2 },
  { id: "licence", text: "Licence", depth: 2 },
] as const;

export default function PrivacyPage() {
  return (
    <Guide title="Privacy and security" toc={TOC}>
      <h2 id="on-your-mac">On your Mac</h2>
      <PrivacyPoints />
      <ul>
        <li>Risky actions go through Auto-review and approval cards; commands on the Mac run inside a sandbox profile.</li>
        <li>
          Phone access, when turned on, is reachable only from your own tailnet. See <Link href="/docs/phone">Phone</Link>.
        </li>
      </ul>
      <p>
        How the API key is stored and checked is in <Link href="/docs/api-key">API key</Link>.
      </p>
      <h2 id="reporting">Reporting a problem</h2>
      <p>
        Please report a security issue privately: open a <a href={SITE.securityAdvisory}>GitHub security advisory</a> on{" "}
        <a href={SITE.repo}>this repository</a> rather than a public issue. Include what you found, how to reproduce it,
        and the version. The same note is in <a href={SITE.securityFile}>SECURITY.md</a>.
      </p>
      <h2 id="licence">Licence</h2>
      <p>
        MIT, see the <a href={SITE.license}>LICENCE</a>. The app bundles third-party components under their own
        licences, including the GPL-3.0 espeak-ng and phonemizer used by the Kokoro voice, whose source archives are
        attached to every release: see the <a href={SITE.thirdParty}>third-party notices</a>.
      </p>
      <p>Synapse is not affiliated with or endorsed by Anthropic.</p>
    </Guide>
  );
}
