import type { Metadata } from "next";
import Link from "next/link";
import { Guide } from "@/components/Guide";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Building from source",
  description: "What you need to build Synapse from source, how packaging signs the app, and where the disk image lands.",
  alternates: { canonical: "/docs/building" },
};

const TOC = [
  { id: "tools", text: "Tools", depth: 2 },
  { id: "package", text: "Package and sign", depth: 2 },
  { id: "layout", text: "How it fits together", depth: 2 },
  { id: "develop", text: "Develop", depth: 2 },
] as const;

export default function BuildingPage() {
  return (
    <Guide title="Building from source" toc={TOC}>
      <p>
        From the <a href={SITE.repo}>repository</a>. The shipped disk image is on the{" "}
        <Link href="/download">download page</Link>; proving a fresh install is in{" "}
        <Link href="/docs/portable-install">Portable install</Link>.
      </p>
      <h2 id="tools">Tools</h2>
      <p>
        You need Node 24.20 or later and full Xcode (not only the Command Line Tools: the native helpers are built
        with its <code>swiftc</code>). The first package build downloads several GB (cmake, the whisper.cpp source and
        model, Python and its wheels, and the Kokoro voice model), so it needs network access and the disk space;
        later builds reuse <code>.build-cache/</code>.
      </p>
      <pre>
        <code>{`npm install
npm test            # the full suite
npm run typecheck`}</code>
      </pre>
      <h2 id="package">Package and sign</h2>
      <p>
        Packaging signs the app with a local code-signing identity called &quot;Synapse Local Signing&quot;. Pick one:
      </p>
      <ul>
        <li>
          <strong>Keep permissions and updates:</strong> create the identity once with{" "}
          <code>node app/scripts/signing-identity.mjs ensure --new-identity</code>, then run <code>npm run dmg</code>.
          Keep that identity: an installed Synapse accepts updates only from builds signed with it.
        </li>
        <li>
          <strong>A throwaway build:</strong> <code>SYNAPSE_ADHOC_SIGN=1 npm run dmg</code>. It is signed ad hoc, so
          the macOS permissions you grant don&apos;t carry over from one build to the next, and an installed Synapse
          refuses it as an update.
        </li>
      </ul>
      <p>
        The disk image lands in <code>app/dist-release/Synapse-&lt;version&gt;-arm64.dmg</code>.
      </p>
      <h2 id="layout">How it fits together</h2>
      <pre>
        <code>{`Mac: Electron app (app/) ──gateway (Bearer, SSE)──► VM: host service (host/)
                                                      └─ each Bot = a Claude Code session (Agent SDK)`}</code>
      </pre>
      <div className="table-wrap">
        <table className="folder-table">
          <thead>
            <tr>
              <th>Folder</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>app/</code>
              </td>
              <td>The Mac app: Electron shell, coordinator, renderer, native helpers (dictation, Mac control)</td>
            </tr>
            <tr>
              <td>
                <code>host/</code>
              </td>
              <td>The engine in the VM: gateway, store, Bot service, scheduler, prompts</td>
            </tr>
            <tr>
              <td>
                <code>shared/</code>
              </td>
              <td>Contracts, limits, strings and ids shared by the host and the app</td>
            </tr>
            <tr>
              <td>
                <code>box/</code>
              </td>
              <td>Provisioning, the run-as-Bot wrappers, deploy and check scripts for the OrbStack VM</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="develop">Develop</h2>
      <p>
        For development, provision the VM with <code>box/provision-from-mac.sh</code>, check it with{" "}
        <code>box/verify-box.sh</code> and deploy the host with <code>box/deploy.sh</code>. The bundled voice runtime
        is built with <code>npm run kokoro:stage -w @synapse/app</code> (see{" "}
        <Link href="/docs/portable-install">Portable install</Link>). <code>node scripts/banner.mjs</code> redraws the
        banner from the app icon. <code>node scripts/public-scan.ts</code> checks the tree for personal data and
        third-party material; the test suite runs the same check.
      </p>
      <p>Some internal names still use the working name &quot;Bots&quot; (package names, the data folder, some service names).</p>
    </Guide>
  );
}
