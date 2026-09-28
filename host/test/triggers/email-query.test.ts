import { describe, expect, it } from "vitest";
import { matchMail, parseMailQuery, type MailMessage } from "../../triggers/email/query";

const NOW = Date.UTC(2026, 8, 19, 12);
const base: MailMessage = {
  id: "1", messageId: "<a@acme.com>", from: "Boss Person <boss@acme.com>", to: ["me@acme.com"], subject: "Q3 invoice due",
  date: NOW - 2 * 3_600_000, text: "Please pay the invoice by Friday. Total $400.", unread: true, folder: "INBOX", labels: ["Finance"], attachments: ["invoice.pdf"],
};
const CASES: [string, Partial<MailMessage>, boolean][] = [
  ["", {}, true],
  ["from:boss", {}, true],
  ["from:boss@acme.com", {}, true],
  ["from:alice", {}, false],
  ["to:me@acme.com", {}, true],
  ["to:other", {}, false],
  ["subject:invoice", {}, true],
  ['subject:"q3 invoice"', {}, true],
  ['subject:"q4 invoice"', {}, false],
  ["has:attachment", {}, true],
  ["has:attachment", { attachments: [] }, false],
  ["is:unread", {}, true],
  ["is:unread", { unread: false }, false],
  ["is:read", { unread: false }, true],
  ["label:finance", {}, true],
  ["label:inbox", {}, true],
  ["label:travel", {}, false],
  ["newer_than:1d", {}, true],
  ["newer_than:1h", {}, false],
  ["invoice", {}, true],
  ["FRIDAY", {}, true],
  ["$400", {}, true],
  ["zebra", { text: `${"x".repeat(9000)} zebra` }, false],
  ["from:boss invoice", {}, true],
  ["from:boss refund", {}, false],
  ["from:alice OR from:boss", {}, true],
  ["refund OR friday", {}, true],
  ["-from:boss", {}, false],
  ["-refund invoice", {}, true],
  ["from:boss -has:attachment", {}, false],
];

describe("email query (ORIG-04 §04.5, 30 cases)", () => {
  it.each(CASES)("%s", (q, over, expected) => {
    expect(matchMail(parseMailQuery(q), { ...base, ...over }, NOW)).toBe(expected);
  });
  it("rejects unsupported operators", () => {
    expect(() => parseMailQuery("has:drive")).toThrow("Unsupported email query: has:drive");
    expect(() => parseMailQuery("newer_than:soon")).toThrow("Unsupported email query: newer_than:soon");
  });
});
