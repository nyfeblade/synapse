# Releasing Synapse

## Cutting and publishing a release

From the repo root, on the Mac that holds the signing key and the "Synapse Local Signing" certificate:

```sh
npm run release:bump -- patch        # or minor / major; commits "release: vX.Y.Z" and tags vX.Y.Z locally
npm run publish-release -- <owner/repo> --dry-run   # the guard and readiness checks only; builds nothing
npm run publish-release -- <owner/repo>             # build, sign, DMG, gh release create
```

- **Versions.** `app/package.json`'s `version` is the one version source. The packager copies it into the bundle's
  `CFBundleShortVersionString`, which is what `app.getVersion()` and the updater read. `release:bump` changes that line
  (and the lockfile's copy), commits, and makes an annotated tag. It pushes nothing. It refuses when tracked files have
  uncommitted changes or the tag already exists.
- **Artifacts** are named from that version: `Synapse-<v>-arm64.zip` (+ `.sha256`, `.sig`) and `Synapse-<v>-arm64.dmg`,
  all in `app/dist-release/`. Every release also carries the exact source archives of the GPL-3.0 parts of the bundled
  voice: `espeak-ng-1.52.0.tar.gz` (the espeak-ng release espeakng-loader 0.2.4 builds) and
  `phonemizer_fork-3.3.2.tar.gz`. `app/native/kokoro/gpl-sources.json` pins each one's canonical URL and SHA-256. They
  are fetched at release time into `.build-cache/gpl-sources/` and never committed. When `requirements.lock` moves
  either package, update that file's version, URL and hash in the same change. `productName` stays "Bots" because userData and keychain entries are keyed on it. It is
  never used in artifact names.
- **publish-release** runs, in order:
  1. The guard: `gh repo view <repo> --json visibility`. It stops unless the repo is `PRIVATE`. A `PUBLIC` repo
     passes only with an explicit `--public`. Anything else is refused, including a repo gh can't read.
  2. The readiness checks:
     - the signing key file exists, is 0600 and matches the public key the app embeds;
     - HEAD is tagged `v<version>`;
     - no tracked file has uncommitted changes;
     - the repo has no release with that tag yet;
     - when the repo is this code repo's `origin`, the tag has been pushed. Run `git push origin HEAD vX.Y.Z` first.
       A separate releases-only repo needs no push.
  3. The GPL source archives (`scripts/gpl-sources.mjs`): each is downloaded from its pinned URL (or reused from the
     cache) and refused unless its SHA-256 matches. This runs before the build, so a dead link stops the release early.
  4. `npm run release`: package (build, code-sign, zip), Ed25519-sign the zip, fill the local release folder.
  5. `scripts/dmg.mjs`: the DMG.
  6. The visibility guard again (the repo could have changed during the build), then `gh release create v<version>` with the zip, `.sha256`, `.sig`, DMG and both source archives.
- `npm run release` alone (no GitHub) still works. It packages, signs, and writes the local release folder.

## The update-signing key (Ed25519)

- **Private key**: `~/Library/Application Support/Synapse-release/update-signing.key`. The file is mode 0600 and its
  folder 0700. It is outside the repo. `.gitignore` also lists `update-signing.key`, `*.key` and `Synapse-release/`.
- **Public key**: embedded in the app at `app/src/main/native/update-public-key.ts`.
- `node app/scripts/release-sign.mjs keygen` made the pair once. It refuses when the key file exists and never replaces it.
- Other `release-sign.mjs` commands: `check` confirms the key file matches the embedded key. `sign <zip>` and
  `verify <zip>` work on single files. `selftest` runs a round trip with a throwaway key. None of them ever prints
  the private key.
- The signature is detached, base64, and covers `"<zip name>|<version>|<sha256>"`, so an old signed zip can't be
  replayed under a newer tag. `release.mjs` writes it as `<zip>.sig` beside the zip and as `sig` in `latest.json`.

### Back the key up

Copy `update-signing.key` somewhere safe and offline, for example a password manager's secure note or an encrypted
USB stick. **If the key is lost, no installed Synapse will accept another update.** Every user then has to download
and install a new build by hand, one that embeds a new key made with `keygen` after you delete the old file.

The same applies to the "Synapse Local Signing" code-signing certificate in the login keychain (see below). An
installed app also checks that each update is code-signed by that certificate. Export it once with Keychain Access
and keep it with the key.

## What the app checks before it installs an update

Both sources are checked: the local release folder first, then the GitHub feed.

1. **The version.** The version must be semver-newer than the running app (`compareSemver`), so there are no
   downgrades or reinstalls. Only plain `x.y.z` tags are offered.
2. **The checksum.** The zip's sha256 must match `.sha256` (GitHub) or `latest.json` (local folder).
3. **The Ed25519 signature.** It is checked against the embedded public key **before** `ditto` or any swap. A missing
   `.sig` is refused: "This update isn't signed". A mismatch is refused: "The update's signature didn't verify against
   Synapse's update key". A build with no embedded key installs nothing ("Updates not configured").
4. **After `ditto`.** The unpacked app's `CFBundleShortVersionString` must equal the version. The app must also satisfy
   the running app's designated requirement: `codesign --verify --deep --strict -R=…`, the "Synapse Local Signing"
   certificate.
5. **Hardening.**
   - The zip is streamed or copied into the private (0700) stage dir first, and that copy is hashed, verified and unpacked. For the local folder, a file swapped in after the check is never what gets unpacked.
   - Downloads are capped at 3 GB, checked against both Content-Length and the streamed bytes.
   - The token goes only to `https://api.github.com`, matched on the exact origin.
   - Concurrent checks or downloads share one run, and a download keeps the release it started with.
6. **The swap.** The swap script is fixed text that takes its paths as argv. The new build has 60 s to report healthy (its window
   is shown and its renderer has loaded; the Bots' computer isn't waited for), or the old build is put back.
   Health is judged on the window and the renderer only, so a crash after the renderer has loaded isn't rolled back;
   a version that is rolled back is skipped until a newer one is out.

### The GitHub feed

- Settings → Updates → Update source takes `owner/repo` and an optional token. Both are stored in the profile's
  `update-source.json`, with the token encrypted.
- **Public repo:** no token is needed and none is sent.
- **Private repo:** the token must be able to read the repo's releases. It is sent on every API call.
- The app reads `GET /repos/<feed>/releases?per_page=30`, not `/releases/latest`.
  - Drafts are skipped.
  - A release someone ticked "pre-release" on is still seen. `/latest` would hide it.
  - Only plain `vX.Y.Z` tags count, and the highest one wins.
- The zip is chosen by its **exact name**, `Synapse-<v>-arm64.zip`. Look-alikes are never downloaded: another arch, the
  DMG, or the old `Bots-` name. Assets are fetched through the asset API with `Accept: application/octet-stream`.
- **Network errors, rate limits (429, or 403 with no requests left) and GitHub 5xx are quiet.** The status goes back
  to idle with no error line, and the app checks again after `Retry-After`, `X-RateLimit-Reset` or 30 min, whichever
  applies (between 1 min and 6 h). A 404 or 401 is a real error and says what to fix: the repo name, or the token.

### The Bots' computer after an update

Once the new build is connected to the Bots' computer, the app first runs the box re-provision check
(`reprovisionIfChanged`: the bundle's provision version against the box's). If that did nothing, it runs the host
check (`redeployHostIfChanged`: the bundled `host/dist/build-id.txt` against the box's `/health` `hostBuild`). Both
wait until no Bot is working, and they never force. Log: `~/Library/Logs/Synapse/update.log`. Tests:
`app/test/main/host-redeploy.test.ts`, `app/test/main/reprovision.test.ts`.

## Local signing identity (code signature, bug 99)

`npm run package -w @synapse/app` signs Synapse.app, its helpers and `bots-dictation` with a self-signed certificate,
**"Synapse Local Signing"**, from your login keychain. Every build then has the same designated requirement
(`identifier "com.nyfeblade.synapse" and certificate leaf = H"<cert sha1>"`), so macOS keeps the Microphone and
Speech Recognition grants and the keychain's "Always Allow" answers across rebuilds.

- `app/scripts/signing-identity.mjs ensure` creates the certificate once. `show` prints its SHA-1.
- The first codesign use of the key opens a "codesign wants to access key" dialog. Enter your login password and
  click **Always Allow**.
- An ad-hoc build (`CI`, `SYNAPSE_ADHOC_SIGN=1`) can't be released. `release.mjs` and `dmg.mjs` refuse it.

## Tests

The tests never touch the real key. They use throwaway keypairs, and `SYNAPSE_UPDATE_KEY` /
`SYNAPSE_UPDATE_PUBKEY_FILE` point `release-sign.mjs` at temp files. The publish-guard tests put a fake `gh` on
`PATH`. The tests are:

- `app/test/main/updater*.test.ts`
- `app/test/main/release-sign.test.ts`
- `app/test/main/release-local.test.ts`
- `app/test/main/release-publish.test.ts`
