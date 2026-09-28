# Security

Please report a security issue privately: open a [GitHub security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository rather than a public issue. Include what you found, how to reproduce it, and the version.

## The model in brief
- Everything runs locally: the Mac app, and a sandbox VM (OrbStack) that holds the Bots' computers. No telemetry.
- Each Bot runs as its own OS user in the VM, with its own home folder.
- The app talks to the VM's host service over a gateway bound to 127.0.0.1 with a bearer token.
- The Anthropic API key is sealed to the VM's key and swapped in by a proxy; a Bot's process only ever holds a
  short-lived proxy token.
- Risky actions go through Auto-review and approval cards; commands on the Mac run inside a sandbox profile.
- Phone access, when turned on, is reachable only from your own tailnet.
