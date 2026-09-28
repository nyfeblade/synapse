import type { ISODate } from "./dates";
import type { Ledger, LedgerEvents } from "./ledger";
import type { Cents } from "./money";

export type Payment = LedgerEvents["invoice.paid"];

/** Records the ledger's payments from the moment it is created until stop(). */
export class PaymentsLog {
  private log: Payment[] = [];
  private unsubscribe: () => void;

  constructor(ledger: Ledger) {
    this.unsubscribe = ledger.events.on("invoice.paid", (p) => this.log.push({ ...p }));
  }

  totalOn(date: ISODate): Cents {
    return this.log.filter((p) => p.paidOn === date).reduce((a, p) => a + p.total, 0);
  }

  entries(): Payment[] {
    return this.log.map((p) => ({ ...p }));
  }

  stop(): void {
    this.unsubscribe();
  }
}
