import { describe, expect, it, vi } from "vitest";
import { chooseSigningIdentity, preflightSigning } from "../../scripts/sign-app.mjs";
import { IDENTITY_NAME, parseIdentityHash } from "../../scripts/signing-identity.mjs";

const LISTING = `
Policy: Code Signing
  Matching identities
  1) 1111111111111111111111111111111111111111 "Apple Development: someone (XYZ)"
  2) 0123456789abcdef0123456789abcdef01234567 "Synapse Local Signing" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found

  Valid identities only
  1) 1111111111111111111111111111111111111111 "Apple Development: someone (XYZ)"
     1 valid identities found
`;

describe("parseIdentityHash (bug 99)", () => {
  it("finds the local identity even though it is untrusted, and only that one", () => {
    expect(IDENTITY_NAME).toBe("Synapse Local Signing");
    expect(parseIdentityHash(LISTING)).toBe("0123456789ABCDEF0123456789ABCDEF01234567");
  });
  it("is null when the identity is absent", () => {
    expect(parseIdentityHash("  0 identities found\n")).toBeNull();
    expect(parseIdentityHash(LISTING.replace("Synapse Local Signing", "Synapse Local Signing 2"))).toBeNull();
  });
});

describe("chooseSigningIdentity: the existing stable identity, never a new one, never silently ad hoc (bug 99, portable install)", () => {
  it("uses the local identity that already exists — it only looks, it never creates one", () => {
    const find = vi.fn(() => "ABC");
    expect(chooseSigningIdentity({ env: {}, find, warn: () => {} })).toEqual({ identity: "ABC", adhoc: false });
    expect(find).toHaveBeenCalledOnce();
  });
  it("CI / SYNAPSE_ADHOC_SIGN=1 never touches a keychain: ad hoc, because it was asked for", () => {
    const find = vi.fn(() => "ABC");
    expect(chooseSigningIdentity({ env: { CI: "true" }, find, warn: () => {} })).toEqual({ identity: "-", adhoc: true });
    expect(chooseSigningIdentity({ env: { SYNAPSE_ADHOC_SIGN: "1" }, find, warn: () => {} })).toEqual({ identity: "-", adhoc: true });
    expect(find).not.toHaveBeenCalled();
  });
  it("a Mac without the identity FAILS the package — a silent ad-hoc build loses every macOS permission and can't update", () => {
    expect(() => chooseSigningIdentity({ env: {}, find: () => null, warn: () => {} })).toThrow(/Synapse Local Signing.*SYNAPSE_ADHOC_SIGN=1/s);
  });
  it("preflight: a signing call that stalls (keychain prompt) fails fast with the one-time fix", () => {
    expect(() => preflightSigning("ABC", () => { throw new Error("spawnSync codesign ETIMEDOUT"); })).toThrow(/Always Allow/);
    const run = vi.fn();
    preflightSigning("-", run);
    expect(run).not.toHaveBeenCalled();
  });

  it("a keychain that can't be read fails the package too, naming why", () => {
    expect(() => chooseSigningIdentity({ env: {}, find: () => { throw new Error("no keychain"); }, warn: () => {} })).toThrow(/no keychain/);
  });
});
