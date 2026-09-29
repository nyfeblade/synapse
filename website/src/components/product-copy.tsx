import Link from "next/link";
import type { ReactNode } from "react";
import { SITE } from "@/lib/site";

export function Intro() {
  return (
    <>
      <p className="lede">Synapse is a Mac app where a small team of AI Bots works for you.</p>
      <p>
        You chat with them, give them code to write, talk to them on voice calls and let them use your Mac, with your
        approval for anything risky. Each Bot has its own name, memory and skills, and its own Linux computer in a
        sandbox on your Mac. Synapse runs on your own Anthropic API key: you pay Anthropic for what the Bots use, and
        nothing else.
      </p>
    </>
  );
}

const FEATURES: readonly { title: string; body: string }[] = [
  {
    title: "A team",
    body: "Several Bots, each with its own name, memory, skills and computer. They work with each other as well as with you.",
  },
  {
    title: "Real work",
    body: "Bots run multi-step tasks on their own computer, with files, the shell, the web and the accounts you connect. They ask before risky actions.",
  },
  {
    title: "Code",
    body: "Point a Bot at a repository: it works on its own branch in a separate worktree, runs the tests and hands back the branch or a pull request.",
  },
  {
    title: "Voice calls",
    body: "Call a Bot and talk. Speech is transcribed on your Mac and the voice is generated on your Mac.",
  },
  {
    title: "Your Mac, with approval",
    body: "A Bot can use your Mac's apps and screen and run commands in a sandbox. Risky actions show an approval card first.",
  },
  {
    title: "Routines",
    body: "Bots run jobs on a schedule: a morning briefing, a weekly check, a reminder.",
  },
  {
    title: "Spend you can see and cap",
    body: "Every model call is metered. See what each Bot spends by day, week and month, and set budgets that pause a Bot or ask you first when it reaches the limit.",
  },
];

export function Features() {
  return (
    <div className="spec-list">
      {FEATURES.map((feature) => (
        <div key={feature.title}>
          <h3>{feature.title}</h3>
          <p>{feature.body}</p>
        </div>
      ))}
    </div>
  );
}

export function Requirements() {
  return (
    <ul>
      <li>A Mac with Apple silicon, macOS 14 or later, and about 8 GB of free disk.</li>
      <li>
        <a href={SITE.orbstack}>OrbStack</a>, which runs the sandbox the Bots work in.
      </li>
      <li>
        An Anthropic API key, from the <a href={SITE.anthropicConsole}>Anthropic Console</a>. Synapse uses an API key
        only: signing in with a Claude subscription or a Claude Code login is not supported (
        <Link href="/docs/api-key">API key</Link>).
      </li>
      <li>An internet connection for the first run and for the Bots' work.</li>
    </ul>
  );
}

export function InstallSteps({ download }: { download: ReactNode }) {
  return (
    <ol>
      <li>
        Check the <a href="#requirements">requirements</a> and install <a href={SITE.orbstack}>OrbStack</a>.
      </li>
      <li>
        Download {download}, open it and drag <strong>Synapse</strong> onto <strong>Applications</strong>.
      </li>
      <li>
        <p>
          Open it the first time with right-click → <strong>Open</strong>, then <strong>Open</strong> again in the
          dialog.
        </p>
        <p>
          Synapse is signed with a self-signed certificate, not an Apple Developer ID, and it is not notarized by
          Apple, so macOS blocks a normal double-click the first time. If right-click → <strong>Open</strong> doesn't
          offer the button (recent macOS versions), try to open Synapse once, then go to{" "}
          <strong>System Settings → Privacy &amp; Security</strong> and click <strong>Open Anyway</strong> next to
          Synapse. After that it opens normally.
        </p>
      </li>
    </ol>
  );
}

export function FirstRun() {
  return (
    <>
      <p>The setup screen walks you through it:</p>
      <ol>
        <li>It starts OrbStack and builds the Bots' computer, a small Linux VM (about 1 GB of downloads).</li>
        <li>
          It asks for your Anthropic API key. The key is sealed on your Mac; afterwards the app shows only its last
          four characters.
        </li>
        <li>You meet your first Bot. Start talking, or add more Bots from the sidebar.</li>
      </ol>
      <p>
        The voice ships inside the app, so voice calls work straight away. macOS asks for the microphone, screen
        recording and accessibility only when you first use a feature that needs them.
      </p>
    </>
  );
}

export function Updates() {
  return (
    <>
      <p>
        To get updates, enter <code>{SITE.updateSource}</code> in <strong>Settings → Updates</strong>. Before Synapse
        installs an update it checks the update's signature against a key built into the app, and that the new app is
        signed with the same certificate.
      </p>
      <p>
        This repository is public, so no token is needed and none is sent. A release marked pre-release is still
        offered. Only plain <code>vX.Y.Z</code> tags count, and the highest one wins.
      </p>
    </>
  );
}

export function PrivacyPoints() {
  return (
    <div className="spec-list">
      <div>
        <h3>Local</h3>
        <p>
          The app and the Bots' computer run on your Mac, in an OrbStack VM. There is no Synapse server and no
          telemetry. The Bots' requests go to Anthropic's API with your key, and to the sites and services you ask them
          to use.
        </p>
      </div>
      <div>
        <h3>Sandboxed Bots</h3>
        <p>
          Each Bot runs as its own user in the VM, with a private home folder. Commands on your Mac run inside a macOS
          sandbox profile and ask for approval.
        </p>
      </div>
      <div>
        <h3>Secrets sealed locally</h3>
        <p>
          Your API key and every other secret are sealed on your Mac with a key file in the app's data folder; the
          macOS Keychain is not used. A Bot never holds your API key: its process gets a short-lived token, and a local
          proxy swaps in the real key.
        </p>
      </div>
      <div>
        <h3>Spend budgets</h3>
        <p>
          Budgets are checked before a model call is made, so a Bot pauses or asks you before it goes past the limit
          you set.
        </p>
      </div>
      <div>
        <h3>A closed gateway</h3>
        <p>The app talks to the VM over a gateway bound to 127.0.0.1, with a bearer token.</p>
      </div>
    </div>
  );
}
