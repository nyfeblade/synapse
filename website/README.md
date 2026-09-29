# Synapse website

Public pages for the Mac app: home, download, docs and privacy. The Electron app (`app`, `host`, `shared`) is unchanged. This package is not a workspace of the root `package.json`.

Docs pages render `docs/api-key-auth.md`, `docs/google-setup.md`, `docs/phone-access.md` and `docs/portable-install.md` from the repository root. Install, features, privacy and building-from-source follow the README and `SECURITY.md`. Run commands from `website/` so those files resolve as `../docs`.

## Run locally

Node 20.9 or later. The app workspaces ask for Node 24.20; this site does not.

```sh
cd website
npm install
npm test
npm run typecheck
npm run dev
```

Open http://localhost:3000. Routes: `/`, `/download`, `/docs`, `/docs/install`, `/docs/api-key`, `/docs/google`, `/docs/phone`, `/docs/portable-install`, `/docs/building`, `/privacy`.

```sh
npm run build
npm start
```

## Download link

The download page reads `https://api.github.com/repos/nyfeblade/synapse/releases` (cached for an hour). It uses the highest non-draft `vX.Y.Z` release that has `Synapse-<version>-arm64.dmg`, including prereleases. Drafts are skipped.

If that request fails, the page uses [`release.config.ts`](release.config.ts), which is pinned to `Synapse-0.1.0-arm64.dmg` from the `v0.1.0` release. Change that file to pin a different known-good disk image.

No environment variable is required. Optional:

| Name | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin. Defaults to `https://synapse-app-nyfe.vercel.app`. |
| `GITHUB_TOKEN` | Only if GitHub rate-limits unauthenticated release reads. A public repository does not need a token, and the site does not send one unless this is set. Do not commit it. |

## Vercel

Create or edit the project that serves the public site.

| Setting | Value |
| --- | --- |
| Root Directory | `website` |
| Framework Preset | Next.js |
| Install Command | `npm install` (default) |
| Build Command | `npm run build` (default) |
| Output Directory | Next.js default (leave empty) |
| Node.js Version | 22.x |
| Environment variables | none |

**Deployment Protection must be off** for Production, or visitors are sent to Vercel SSO. That includes Vercel Authentication and Standard Protection. Preview protection can stay on if you want; the production URL has to be public. The repository cannot change this setting. After you set the Root Directory, redeploy.

The project currently at `https://synapse-app-nyfe.vercel.app` redirects to a Vercel login until protection is disabled and this directory is the root. `NEXT_PUBLIC_SITE_URL` can stay unset for that hostname.
