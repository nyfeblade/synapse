import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoxPin } from "../../src/main/box-pin";
import { MacSecretVault } from "../../src/main/secret-vault";
import { SecretSync } from "../../src/main/secret-sync";

/**
 * Bug 57: a NEW profile (reinstall, new Mac, wiped profile, a second dev/test profile) starts with an
 * empty Mac vault, and resync() used to send `removes` = every name the box held — deleting every
 * Bot secret on the box, whose values this profile never had. Deletion on the box is now only for a
 * name THIS profile synced and the user has since removed here.
 */
const crypt = { encrypt: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString("base64")}`), decrypt: (b: Buffer) => Buffer.from(b.toString().slice(4), "base64").toString() };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "first-sync-"));

function rig(boxNames: string[], profile = dir()) {
  const vault = new MacSecretVault(path.join(profile, "secrets.vault.json"), crypt, () => Buffer.alloc(32, 5));
  const box: Record<string, { valueHash: string; needsSync: boolean; description: string }> = Object.fromEntries(boxNames.map((n) => [n, { valueHash: `h-${n}`, needsSync: false, description: `${n} desc` }]));
  const sets: { upserts: { name: string }[]; removes: string[] }[] = [];
  let online = true;
  const call = (async (cmd: string, args: any) => {
    if (!online) throw new Error("box unreachable");
    if (cmd === "getBotSecretsStatus") return { boxPublicKey: "K", status: Object.entries(box).map(([name, s]) => ({ name, updatedAt: 1, ...s })) };
    if (cmd === "setBotSecrets") {
      sets.push(args);
      for (const u of args.upserts) box[u.name] = { valueHash: u.valueHash, needsSync: false, description: u.description };
      for (const r of args.removes) delete box[r];
      return { status: [] };
    }
    return {};
  }) as never;
  const sync = new SecretSync({ vault, pin: new BoxPin(path.join(profile, "box-pin.json")), call, seal: async () => "sealed" });
  return { vault, box, sets, sync, profile, offline: (v: boolean) => { online = !v; } };
}

describe("bug 57: a fresh profile never deletes the box's secrets", () => {
  it("resync from an empty, never-synced profile leaves every box secret in place", async () => {
    const r = rig(["STRIPE_KEY", "OPENAI_API_KEY", "GH_PAT"]);
    await r.sync.resync(["b"]);
    expect(r.sets.flatMap((s) => s.removes)).toEqual([]);
    expect(Object.keys(r.box).sort()).toEqual(["GH_PAT", "OPENAI_API_KEY", "STRIPE_KEY"]);
  });

  it("a profile whose vault predates the ledger (no `synced` field) deletes nothing either", async () => {
    const r = rig(["STRIPE_KEY", "LEFT_BEHIND"]);
    fs.writeFileSync(path.join(r.profile, "secrets.vault.json"), JSON.stringify({ version: 1, entries: [] }));
    r.vault.upsert("b", "STRIPE_KEY", "", "value-stripe");
    await r.sync.resync(["b"]);
    expect(r.sets.flatMap((s) => s.removes)).toEqual([]);
    expect(Object.keys(r.box).sort()).toEqual(["LEFT_BEHIND", "STRIPE_KEY"]);
  });

  it("still deletes what THIS profile synced and the user removed while the box was unreachable", async () => {
    const r = rig(["NOT_MINE"]);
    await r.sync.save("b", "OLD_KEY", "", "value-old-1");
    await r.sync.save("b", "KEEP_KEY", "", "value-keep-1");
    r.offline(true);
    await expect(r.sync.remove("b", "OLD_KEY")).rejects.toThrow("box unreachable");
    r.offline(false);
    await r.sync.resync(["b"]);
    expect(r.sets.at(-1)!.removes).toEqual(["OLD_KEY"]);
    expect(Object.keys(r.box).sort()).toEqual(["KEEP_KEY", "NOT_MINE"]);
    expect(r.vault.synced("b")).toEqual(["KEEP_KEY"]);
  });

  it("the ledger shares the vault's fate: deleting the profile's vault file forgets it, so nothing is deleted", async () => {
    const r = rig([]);
    await r.sync.save("b", "API_KEY", "", "value-api-1");
    fs.rmSync(path.join(r.profile, "secrets.vault.json"));
    await r.sync.resync(["b"]);
    expect(Object.keys(r.box)).toEqual(["API_KEY"]);
  });

  it("surfaces box-only secrets as a state with actions, names and descriptions only", async () => {
    const r = rig(["STRIPE_KEY", "GH_PAT"]);
    await r.sync.resync(["b"]);
    await r.sync.save("b", "MINE", "", "value-mine-1");
    const rows = await r.sync.list("b");
    expect(rows.filter((x) => x.boxOnly).map((x) => [x.name, x.description, x.kept])).toEqual([["STRIPE_KEY", "STRIPE_KEY desc", undefined], ["GH_PAT", "GH_PAT desc", undefined]]);
    expect(JSON.stringify(rows)).not.toMatch(/valueHash|h-STRIPE|value-mine/);
    r.sync.keepOnBox("b", ["STRIPE_KEY", "GH_PAT"]);
    expect((await r.sync.list("b")).filter((x) => x.boxOnly && !x.kept)).toEqual([]);
    // Kept is not synced: a later resync still leaves them alone.
    await r.sync.resync(["b"]);
    expect(Object.keys(r.box).sort()).toEqual(["GH_PAT", "MINE", "STRIPE_KEY"]);
  });

  it("re-entering a box-only value makes it this profile's; Remove from computer is an explicit delete", async () => {
    const r = rig(["STRIPE_KEY", "GH_PAT"]);
    await r.sync.save("b", "STRIPE_KEY", "Stripe", "value-new-stripe");
    await r.sync.remove("b", "GH_PAT");
    const rows = await r.sync.list("b");
    expect(rows.map((x) => [x.name, !!x.boxOnly])).toEqual([["STRIPE_KEY", false]]);
    expect(r.vault.synced("b")).toEqual(["STRIPE_KEY"]);
  });

  it("list falls back to the last resync's answer when the box can't be reached, rather than hiding the state", async () => {
    const r = rig(["STRIPE_KEY"]);
    await r.sync.resync(["b"]);
    r.offline(true);
    expect((await r.sync.list("b")).map((x) => x.name)).toEqual(["STRIPE_KEY"]);
  });
});
