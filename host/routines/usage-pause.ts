/** USE-04 / ORIG-14 subset: after BOT-E0420, routine fires are dropped ("usage_paused") until the reset; user turns are never paused. */
export class UsagePause {
  private until = 0;

  constructor(private now: () => number = Date.now) {}

  pauseUntil(ms: number): void {
    this.until = Math.max(this.until, ms);
  }
  paused(): boolean {
    return this.now() < this.until;
  }
  hoursLeft(): number {
    return Math.max(1, Math.ceil((this.until - this.now()) / 3_600_000));
  }
  resetsInText(): string {
    const h = this.hoursLeft();
    return `It resets in ${h} hour${h === 1 ? "" : "s"}`;
  }
}
