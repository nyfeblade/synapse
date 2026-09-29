export interface NavItem {
  href: string;
  label: string;
  description: string;
}

export const DOC_NAV: readonly NavItem[] = [
  {
    href: "/docs",
    label: "Overview",
    description: "What Synapse is, and which guide to open.",
  },
  {
    href: "/docs/install",
    label: "Install",
    description: "Requirements, the disk image, and the first open.",
  },
  {
    href: "/docs/api-key",
    label: "API key",
    description: "An Anthropic API key is the only sign-in. A Claude subscription is not supported.",
  },
  {
    href: "/docs/google",
    label: "Google",
    description: "Gmail, Calendar and Drive through your own Google Cloud OAuth client.",
  },
  {
    href: "/docs/phone",
    label: "Phone",
    description: "Call a Bot from your phone over your own Tailscale network.",
  },
  {
    href: "/docs/portable-install",
    label: "Portable install",
    description: "Build the DMG and prove it on a fresh Mac.",
  },
  {
    href: "/docs/building",
    label: "Building from source",
    description: "Node, Xcode, tests, and how the app and the VM fit together.",
  },
  {
    href: "/privacy",
    label: "Privacy and security",
    description: "What stays on your Mac, how to report a problem, and the licence.",
  },
];

export const SITEMAP_PATHS = ["/", "/download", ...DOC_NAV.map((item) => item.href)] as const;
