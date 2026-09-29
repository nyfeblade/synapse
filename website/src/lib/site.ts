export const SITE_URL_DEFAULT = "https://synapse-app-nyfe.vercel.app";

export const SITE = {
  name: "Synapse",
  title: "Synapse — your own team of AI Bots, on your Mac.",
  description:
    "Synapse is a Mac app where a small team of AI Bots works for you, on your own Anthropic API key. Apple silicon, macOS 14 or later.",
  repo: "https://github.com/nyfeblade/synapse",
  releases: "https://github.com/nyfeblade/synapse/releases",
  license: "https://github.com/nyfeblade/synapse/blob/main/LICENSE",
  securityFile: "https://github.com/nyfeblade/synapse/blob/main/SECURITY.md",
  securityAdvisory:
    "https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability",
  thirdParty: "https://github.com/nyfeblade/synapse/blob/main/app/build/THIRD-PARTY-NOTICES.txt",
  orbstack: "https://orbstack.dev",
  anthropicConsole: "https://console.anthropic.com",
  updateSource: "nyfeblade/synapse",
} as const;

export function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim() || SITE_URL_DEFAULT;
  return raw.replace(/\/$/, "");
}
