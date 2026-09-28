import { describe, expect, it } from "vitest";
import { factKey } from "../../memory/fact-key";

describe("factKey: a conservative (subject, predicate, value) reading of one memory sentence", () => {
  it("reads possessive facts", () => {
    expect(factKey("The user's dentist is Dr. Kim.")).toEqual({ subject: "user", predicate: "dentist", value: "dr. kim" });
    expect(factKey("Halyard's retainer is $4,500 a month.")).toEqual({ subject: "halyard", predicate: "retainer", value: "$4,500 a month" });
    expect(factKey("The user's favorite coffee roaster is Onyx.")).toEqual({ subject: "user", predicate: "favorite coffee roaster", value: "onyx" });
    expect(factKey("Dana's manager is Lee Park")).toEqual({ subject: "dana", predicate: "manager", value: "lee park" });
  });

  it("reads 'the P of/for S is V', scheduled things and who manages what", () => {
    expect(factKey("The budget for the Acme launch is 55k.")).toEqual({ subject: "acme launch", predicate: "budget", value: "55k" });
    expect(factKey("The design review happens on Tuesdays at 10:00.")).toEqual({ subject: "design review", predicate: "when", value: "tuesdays at 10:00" });
    expect(factKey("Aurelio Brennholt manages the billing team.")).toEqual({ subject: "billing team", predicate: "managed by", value: "aurelio brennholt" });
  });

  it("returns null for multi-valued relations, so two sisters never supersede each other", () => {
    for (const s of ["The user's sister is Maya.", "The user's client is Oakhaven.", "The user's friend is Sam.", "The user's kids are Ada and Bo.", "Dana's dog is Rex."]) expect(factKey(s)).toBeNull();
  });

  it("returns null for sentences it can't read (no guessing)", () => {
    for (const s of ["Sent the Q3 deck to Dana on 2026-09-14.", "The user prefers short answers.", "Waiting on a reply from the landlord about the lease.", "Kim's practice moved across town in 2025."]) expect(factKey(s)).toBeNull();
  });
});
