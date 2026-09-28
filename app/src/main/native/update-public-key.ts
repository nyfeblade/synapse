/**
 * Release updates: the embedded Ed25519 public key that every update zip's detached signature must verify against
 * (GitHub feed and local release folder alike). `node app/scripts/release-sign.mjs keygen` made the keypair once;
 * the private key lives ONLY in ~/Library/Application Support/Synapse-release/update-signing.key (0600), outside
 * the repo. Lose that file and every installed Synapse needs a manual reinstall. Never commit a private key.
 * See docs/release.md.
 */
export const UPDATE_PUBLIC_KEY: string | null = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmeKqQA+72FNbwbux+vIs+xNY5ymUJI8nGlaVzTH0Ox0=
-----END PUBLIC KEY-----
`;
