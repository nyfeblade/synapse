import type { Metadata } from "next";
import Link from "next/link";
import { Guide } from "@/components/Guide";
import { FirstRun, InstallSteps, Requirements, Updates } from "@/components/product-copy";

export const metadata: Metadata = {
  title: "Install",
  description: "Requirements for Synapse, how to open the disk image, and what the first run does.",
  alternates: { canonical: "/docs/install" },
};

const TOC = [
  { id: "steps", text: "Install", depth: 2 },
  { id: "requirements", text: "Requirements", depth: 2 },
  { id: "first-run", text: "First run", depth: 2 },
  { id: "updates", text: "Updates", depth: 2 },
] as const;

export default function InstallPage() {
  return (
    <Guide title="Install" toc={TOC}>
      <p>Apple silicon, macOS 14 or later. The disk image is on the download page.</p>
      <h2 id="steps">Install</h2>
      <InstallSteps
        download={
          <>
            <code>Synapse-&lt;version&gt;-arm64.dmg</code> from the <Link href="/download">download page</Link>
          </>
        }
      />
      <h2 id="requirements">Requirements</h2>
      <Requirements />
      <h2 id="first-run">First run</h2>
      <FirstRun />
      <h2 id="updates">Updates</h2>
      <Updates />
      <p>
        To build the disk image yourself, see <Link href="/docs/building">Building from source</Link> and{" "}
        <Link href="/docs/portable-install">Portable install</Link>.
      </p>
    </Guide>
  );
}
