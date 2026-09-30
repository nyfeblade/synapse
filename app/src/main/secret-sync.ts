import { createRequire } from "node:module";
import { STR_AUTH, validateSecretName, type SecretStatusEntry } from "@synapse/shared";
import type sodiumType from "libsodium-wrappers";
import type { BoxPin } from "./box-pin";
import type { Call } from "./gateway-call";
import type { MacSecretVault } from "./secret-vault";

export type { Call };

// libsodium-wrappers@0.7.16's ESM build (dist/modules-esm/libsodium-wrappers.mjs) has a broken
// relative import ("./libsodium.mjs") that isn't shipped in its own package — only in the
// `libsodium` package's dist. Its CJS build (used via the package.json "require" export
// condition) is fine, so we need the working CJS build one way or another.
//
// Unlike host/secrets/crypto.ts (bundled to ESM by host/build.mjs, where `createRequire(import
// .meta.url)` alone is correct), this file is bundled to CJS by app/build.mjs. esbuild does not
// support `import.meta.url` in cjs output — it becomes `createRequire(undefined)`, which throws
// at load time in the packaged app (esbuild only warns at build time; nothing else catches it).
// But under Vitest, this .ts source runs unbundled via Node's native ESM loader, where there is
// no ambient `require` and `import.meta.url` is real. So neither a bare `require(...)` nor a bare
// `createRequire(import.meta.url)` works in both contexts — use whichever the current module
// actually provides: the esbuild-cjs wrapper's real `require` when present (production build),
// falling back to `createRequire(import.meta.url)` when it isn't (Vitest's native-ESM load).
// `req` is not itself named `require`, and is invoked indirectly, so esbuild does not try to
// statically bundle libsodium-wrappers into the output — it stays a real runtime lookup either
// way, exactly like the previous createRequire-only form.
const req: NodeJS.Require = typeof require !== "undefined" ? require : createRequire(import.meta.url);
const sodium: typeof sodiumType = req("libsodium-wrappers");

export async function sealWith(publicKey: string, value: string): Promise<string> {
  await sodium.ready;
  const V = sodium.base64_variants.ORIGINAL;
  return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(publicKey, V)), V);
}

const PIN_MISMATCH = STR_AUTH.pinMismatch;

/** A Secrets-section row. `boxOnly`: on the box, with no value on this Mac (bug 57). */
export interface SecretListRow { name: string; description: string; updatedAt: number; unusable?: string; boxOnly?: true; kept?: true }

/**
 * Bug 57, THE RULE for every Mac → box reconcile: a remote name may be deleted only if this profile's ledger
 * says it synced that name AND it is gone locally. "Absent here" alone is never a reason, because a new or
 * wiped profile has nothing here and the box holds values this Mac never had. With an empty ledger (a
 * first sync) this returns nothing, whatever the box holds. Guarded by secret-first-sync.test.ts.
 */
export function removableOnBox(remote: string[], local: string[], ledger: string[]): string[] {
  return remote.filter((n) => ledger.includes(n) && !local.includes(n));
}

export class SecretSync {
  private lastBox = new Map<string, SecretStatusEntry[]>();
  constructor(private o: { vault: MacSecretVault; pin: BoxPin; call: Call; seal(publicKey: string, value: string): Promise<string> }) {}

  private async status(botId: string): Promise<{ key: string; status: SecretStatusEntry[] }> {
    const r = await this.o.call("getBotSecretsStatus", { botId });
    if (this.o.pin.check(r.boxPublicKey) === "mismatch") throw new Error(PIN_MISMATCH);
    return { key: r.boxPublicKey, status: r.status };
  }

  async save(botId: string, name: string, description: string, value: string): Promise<SecretStatusEntry[]> {
    const nameErr = validateSecretName(name);
    if (nameErr) throw new Error(nameErr);
    const { key } = await this.status(botId);
    const { valueHash } = this.o.vault.upsert(botId, name, description, value);
    const r = await this.o.call("setBotSecrets", { botId, upserts: [{ name, description, sealed: await this.o.seal(key, value), valueHash }], removes: [] });
    this.o.vault.markSynced(botId, [name]);
    return r.status;
  }

  /** Also the box-only row's "Remove from box". If the box can't be reached, the name stays in the ledger,
   *  so the next resync finishes the removal the user asked for (bug 57). */
  async remove(botId: string, name: string): Promise<SecretStatusEntry[]> {
    this.o.vault.remove(botId, name);
    const r = await this.o.call("setBotSecrets", { botId, upserts: [], removes: [name] });
    this.o.vault.markSynced(botId, [], [name]);
    this.lastBox.set(botId, (this.lastBox.get(botId) ?? []).filter((s) => s.name !== name));
    return r.status;
  }

  /**
   * Bug 56: move a stored secret (typically one whose name the Bot's env refuses) to a new name. The value is
   * read from the Mac vault here in main, so it never crosses to the renderer. One setBotSecrets carries the
   * new name and the removal of the old one; the old local entry goes only after the box has accepted that.
   */
  async rename(botId: string, from: string, to: string): Promise<SecretStatusEntry[]> {
    const nameErr = validateSecretName(to);
    if (nameErr) throw new Error(nameErr);
    const entries = this.o.vault.entries(botId);
    const old = entries.find((e) => e.name === from);
    if (!old) throw new Error(`No secret ${from}`);
    if (to !== from && entries.some((e) => e.name === to)) throw new Error(`A secret named ${to} already exists.`);
    const { key } = await this.status(botId);
    const value = this.o.vault.value(botId, from);
    const { valueHash } = this.o.vault.upsert(botId, to, old.description, value);
    const r = await this.o.call("setBotSecrets", { botId, upserts: [{ name: to, description: old.description, sealed: await this.o.seal(key, value), valueHash }], removes: to === from ? [] : [from] });
    if (to !== from) this.o.vault.remove(botId, from);
    this.o.vault.markSynced(botId, [to], to === from ? [] : [from]);
    return r.status;
  }

  /**
   * Bug 57: what the box holds for this Bot that this Mac has no value for, e.g. after a reinstall, on a new
   * Mac or in a second profile. Names and descriptions only: never a value or its hash. `kept` means the user
   * already chose "Keep them on the box". If the box can't be reached, the last resync's answer is used.
   */
  async list(botId: string): Promise<SecretListRow[]> {
    const rows: SecretListRow[] = this.o.vault.list(botId);
    let status: SecretStatusEntry[] | undefined;
    try { status = (await this.status(botId)).status; } catch { status = this.lastBox.get(botId); }
    if (status) this.lastBox.set(botId, status);
    const kept = this.o.vault.keptOnBox(botId);
    for (const s of status ?? []) {
      if (rows.some((r) => r.name === s.name)) continue;
      rows.push({ name: s.name, description: s.description, updatedAt: s.updatedAt, boxOnly: true, ...(kept.includes(s.name) ? { kept: true } : {}) });
    }
    return rows;
  }

  /** Bug 57, the notice's "Keep them on the box": they stay there, listed, and the notice stops asking. */
  keepOnBox(botId: string, names: string[]): void {
    this.o.vault.keepOnBox(botId, names);
  }

  /**
   * After every (re)connection and after Update/Recover/Reset: push what the box lacks, and delete on the box
   * only what THIS profile synced and the user has since removed here (bug 57). A name the box has that this
   * profile never synced is NOT "removed": it is a secret whose value this Mac simply doesn't have (new
   * profile, reinstall, new Mac). It stays, and list() surfaces it with Re-enter / Keep on the box.
   */
  async resync(botIds: string[]): Promise<number> {
    // Load the local vault for every Bot BEFORE talking to the box. MacSecretVault throws rather than
    // reporting empty on a bad read; let that propagate here, before a single setBotSecrets goes out.
    const local = new Map(botIds.map((botId) => [botId, { mine: this.o.vault.entries(botId), synced: this.o.vault.synced(botId) }]));
    let changed = 0;
    for (const botId of botIds) {
      const { key, status } = await this.status(botId);
      this.lastBox.set(botId, status);
      const box = new Map(status.map((s) => [s.name, s]));
      const { mine, synced } = local.get(botId)!;
      const upserts = [];
      for (const e of mine) {
        // Bug 56: the box refuses a batch containing a disallowed name, which used to strand EVERY secret in it.
        // Such an entry stays on the Mac, listed as unusable with Rename/Remove, and is not sent.
        if (validateSecretName(e.name)) continue;
        const b = box.get(e.name);
        if (!b || b.needsSync || b.valueHash !== e.valueHash || b.description !== e.description) {
          upserts.push({ name: e.name, description: e.description, sealed: await this.o.seal(key, this.o.vault.value(botId, e.name)), valueHash: e.valueHash });
        }
      }
      const removes = removableOnBox(status.map((s) => s.name), mine.map((e) => e.name), synced);
      if (upserts.length || removes.length) {
        await this.o.call("setBotSecrets", { botId, upserts, removes });
        changed += upserts.length + removes.length;
        this.lastBox.set(botId, status.filter((s) => !removes.includes(s.name)));
      }
      // Every usable local name is on the box now (pushed above, or already there with this value).
      this.o.vault.setSynced(botId, mine.filter((e) => !validateSecretName(e.name)).map((e) => e.name));
    }
    return changed;
  }

  async submitRequest(botId: string, entryId: string, value: string, meta: { destination: "env" | "connector" | "page"; field: string | null; label: string }): Promise<string> {
    const { key } = await this.status(botId);
    // A field the box would refuse is not stored here first (bug 56 sibling): the box answers the card with the refusal.
    const storeLocally = meta.destination === "env" && !!meta.field && !validateSecretName(meta.field);
    const valueHash = storeLocally ? this.o.vault.upsert(botId, meta.field!, meta.label, value).valueHash : this.o.vault.hash(value);
    const status = (await this.o.call("submitSecret", { id: botId, entryId, sealed: await this.o.seal(key, value), valueHash })).status;
    if (storeLocally) this.o.vault.markSynced(botId, [meta.field!]);
    return status;
  }

  async submitForm(botId: string, entryId: string, answers: Record<string, string>, secrets: Record<string, string>): Promise<string> {
    const { key } = await this.status(botId);
    const sealed: Record<string, string> = {};
    for (const [k, v] of Object.entries(secrets)) sealed[k] = await this.o.seal(key, v);
    return (await this.o.call("submitForm", { id: botId, entryId, answers, sealed })).status;
  }
}
