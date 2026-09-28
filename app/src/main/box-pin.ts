import fs from "node:fs";

/** ORIG-12 §12.2: trust on first use; re-pinned only after a Reset the user confirmed. */
export class BoxPin {
  constructor(private file: string) {}
  private get(): string | null {
    try { return (JSON.parse(fs.readFileSync(this.file, "utf8")) as { publicKey: string }).publicKey; } catch { return null; }
  }
  check(publicKey: string): "pinned" | "match" | "mismatch" {
    const have = this.get();
    if (have === null) {
      this.repin(publicKey);
      return "pinned";
    }
    return have === publicKey ? "match" : "mismatch";
  }
  repin(publicKey: string): void {
    fs.writeFileSync(this.file, JSON.stringify({ publicKey, pinnedAt: Date.now() }), { mode: 0o600 });
  }
  /**
   * Portable install (blocker c): the app itself just created or recreated the box, or the user confirmed
   * "Trust this computer" — the next check pins the new box's key. Nothing else ever calls this, so a box
   * whose key changed behind the app's back still reads as a mismatch.
   */
  forget(): void {
    try { fs.unlinkSync(this.file); } catch { /* not pinned */ }
  }
}
