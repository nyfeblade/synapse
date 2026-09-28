import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UPDATE_KEY_FILE, UPDATE_SOURCE_FILE, migrateUpdateSourceFromKeychain, readUpdateSource, writeUpdateSource } from "../../src/main/update-source";

// The update feed (owner/repo) and the private repo's read-only token used to live in the keychain; a relocked
// keychain namespace silently broke updates the way it broke the permission switches (bug 225). They live in
// the profile now, like local-policy.key: 0600 files owned by the user, the token encrypted at rest.
describe("the update source file", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const profile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "upd-src-")); dirs.push(d); return d; };

  it("round-trips the feed and the token; the token is never on disk in the clear", () => {
    const ud = profile();
    writeUpdateSource(ud, { feed: "example/synapse-releases", token: "github_pat_SECRET123" });
    expect(readUpdateSource(ud)).toEqual({ feed: "example/synapse-releases", token: "github_pat_SECRET123" });
    const raw = fs.readFileSync(path.join(ud, UPDATE_SOURCE_FILE), "utf8");
    expect(raw).toContain("example/synapse-releases");
    expect(raw).not.toContain("SECRET123");
    for (const f of [UPDATE_SOURCE_FILE, UPDATE_KEY_FILE]) {
      const st = fs.statSync(path.join(ud, f));
      expect(st.mode & 0o777).toBe(0o600);
      expect(st.uid).toBe(process.getuid!());
    }
  });

  it("patches one field without losing the other, and clears with an empty value", () => {
    const ud = profile();
    writeUpdateSource(ud, { feed: "a/b", token: "t1" });
    writeUpdateSource(ud, { token: "t2" });
    expect(readUpdateSource(ud)).toEqual({ feed: "a/b", token: "t2" });
    writeUpdateSource(ud, { feed: "" });
    expect(readUpdateSource(ud)).toEqual({ feed: null, token: "t2" });
    writeUpdateSource(ud, { token: "" });
    expect(readUpdateSource(ud).token).toBeNull();
  });

  it("refuses a feed that isn't owner/repo", () => {
    expect(() => writeUpdateSource(profile(), { feed: "https://evil/x" })).toThrow(/owner\/repo/);
  });

  it("a tampered token or a swapped key reads as no token, never as garbage", () => {
    const ud = profile();
    writeUpdateSource(ud, { feed: "a/b", token: "t1" });
    const f = path.join(ud, UPDATE_SOURCE_FILE);
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.token.ct = Buffer.from("xx").toString("base64");
    fs.writeFileSync(f, JSON.stringify(j), { mode: 0o600 });
    expect(readUpdateSource(ud)).toEqual({ feed: "a/b", token: null });
  });

  it("refuses a key file that is a link or readable by others", () => {
    const ud = profile();
    writeUpdateSource(ud, { token: "t1" });
    fs.chmodSync(path.join(ud, UPDATE_KEY_FILE), 0o644);
    expect(readUpdateSource(ud).token).toBeNull();
  });

  it("moves the keychain copy over once, when the keychain can be read", () => {
    const ud = profile();
    const secrets: Record<string, string> = { updateFeed: "example/synapse-releases", updateToken: "tok" };
    expect(migrateUpdateSourceFromKeychain(ud, { readable: false, read: (n) => secrets[n] ?? null })).toBe(false);
    expect(readUpdateSource(ud)).toEqual({ feed: null, token: null });
    expect(migrateUpdateSourceFromKeychain(ud, { readable: true, read: (n) => secrets[n] ?? null })).toBe(true);
    expect(readUpdateSource(ud)).toEqual({ feed: "example/synapse-releases", token: "tok" });
    // Once only: a later keychain change does not overwrite what the user set in the file.
    writeUpdateSource(ud, { feed: "other/repo" });
    expect(migrateUpdateSourceFromKeychain(ud, { readable: true, read: (n) => secrets[n] ?? null })).toBe(false);
    expect(readUpdateSource(ud).feed).toBe("other/repo");
  });
});
