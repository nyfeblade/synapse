import { describe, expect, it } from "vitest";
import {
  MACAPP_ACTIONS,
  STRMA,
  macAppBindTarget,
  macAppConsequence,
  macAppLabelConsequence,
  macAppReadOnly,
  macAppSummary,
  pickContact,
  resolveContacts,
  type ContactCandidate,
  type MacAppArgs,
} from "../src/macapp";

const A = (a: Partial<MacAppArgs> & { action: MacAppArgs["action"] }): MacAppArgs => a as MacAppArgs;

describe("the MacApp action surface", () => {
  it("covers the fast paths people actually use, plus the generic UI fallback", () => {
    for (const a of [
      "open", "apps",
      "messages.send", "messages.threads",
      "mail.compose", "mail.send", "mail.search", "mail.read",
      "calendar.list", "calendar.create", "calendar.move", "calendar.cancel", "calendar.calendars",
      "reminders.create", "reminders.complete", "reminders.list",
      "notes.create", "notes.append", "notes.search",
      "contacts.find",
      "music", "finder.reveal", "finder.move", "finder.tag", "tabs", "shortcut",
      "ui.outline", "ui.more", "ui.press", "ui.set", "ui.menu", "ui.key", "ui.focus",
    ]) expect(MACAPP_ACTIONS as readonly string[], a).toContain(a);
  });

  it("names every action exactly once", () => {
    expect(new Set(MACAPP_ACTIONS).size).toBe(MACAPP_ACTIONS.length);
  });

  it("says app content is untrusted, never returns screenshots, and stays inside the schema budget", () => {
    expect(STRMA.toolDescription).toMatch(/untrusted/i);
    expect(STRMA.toolDescription).toMatch(/user's Mac/);
    expect(STRMA.toolDescription.length).toBeLessThan(1_500);
  });
});

describe("the read-only fast path (the reviewer skips these)", () => {
  it("reads, lists and searches are read-only", () => {
    for (const action of ["apps", "messages.threads", "mail.search", "mail.read", "calendar.list", "calendar.calendars", "reminders.list", "notes.search", "contacts.find", "ui.outline", "ui.more"] as const) {
      expect(macAppReadOnly(A({ action })), action).toBe(true);
    }
  });

  it("anything that changes an app is not", () => {
    for (const action of ["open", "messages.send", "mail.send", "mail.compose", "calendar.create", "calendar.move", "calendar.cancel", "reminders.create", "reminders.complete", "notes.create", "notes.append", "finder.move", "finder.tag", "shortcut", "ui.press", "ui.set", "ui.menu", "ui.key", "ui.focus"] as const) {
      expect(macAppReadOnly(A({ action })), action).toBe(false);
    }
  });

  it("tabs is read-only for a listing and not for a close", () => {
    expect(macAppReadOnly(A({ action: "tabs", value: "list" }))).toBe(true);
    expect(macAppReadOnly(A({ action: "tabs", value: "close 2" }))).toBe(false);
  });
});

/**
 * The Full-auto policy: send, delete, spend and security always ask, whatever the mode.
 * Everything else runs without a card in Full auto.
 */
describe("the consequential classifier", () => {
  it("sending is always a send, whatever the app", () => {
    expect(macAppConsequence(A({ action: "messages.send", target: "Sam", text: "hi" }))).toBe("send");
    expect(macAppConsequence(A({ action: "mail.send", target: "sam@x.test", title: "Hi" }))).toBe("send");
  });

  it("a draft is not a send", () => {
    expect(macAppConsequence(A({ action: "mail.compose", target: "sam@x.test", title: "Hi" }))).toBe(null);
  });

  it("an event with attendees sends invitations, so it asks; one without does not", () => {
    expect(macAppConsequence(A({ action: "calendar.create", title: "Sync", people: "sam@x.test" }))).toBe("send");
    expect(macAppConsequence(A({ action: "calendar.create", title: "Gym" }))).toBe(null);
    expect(macAppConsequence(A({ action: "calendar.move", ref: "ev1", people: "sam@x.test" }))).toBe("send");
  });

  it("cancelling an event and moving a file to the Trash are deletes", () => {
    expect(macAppConsequence(A({ action: "calendar.cancel", ref: "ev1" }))).toBe("destruction");
    expect(macAppConsequence(A({ action: "finder.move", target: "~/.Trash" }))).toBe("destruction");
    expect(macAppConsequence(A({ action: "finder.move", target: "~/Documents/archive" }))).toBe(null);
  });

  it("opening a credential store is a security action", () => {
    expect(macAppConsequence(A({ action: "open", app: "Keychain Access" }))).toBe("security");
    expect(macAppConsequence(A({ action: "open", app: "Passwords" }))).toBe("security");
    expect(macAppConsequence(A({ action: "open", app: "Mail" }))).toBe(null);
  });

  it("a destructive key or menu path asks", () => {
    expect(macAppConsequence(A({ action: "ui.key", value: "cmd+delete" }))).toBe("destruction");
    expect(macAppConsequence(A({ action: "ui.menu", value: "File > Move to Trash" }))).toBe("destruction");
    expect(macAppConsequence(A({ action: "ui.menu", value: "Message > Send" }))).toBe("send");
    expect(macAppConsequence(A({ action: "ui.menu", value: "File > Save" }))).toBe(null);
  });

  it("reads never ask", () => {
    for (const action of ["apps", "mail.search", "calendar.list", "reminders.list", "notes.search", "contacts.find", "ui.outline"] as const) {
      expect(macAppConsequence(A({ action })), action).toBe(null);
    }
  });

  /** The generic fallback resolves a ref to its on-screen label, then asks the same question of it. */
  it("classifies a resolved button label so an Accessibility press is judged like a click", () => {
    expect(macAppLabelConsequence("Send")).toBe("send");
    expect(macAppLabelConsequence("Send Message")).toBe("send");
    expect(macAppLabelConsequence("Delete")).toBe("destruction");
    expect(macAppLabelConsequence("Move to Trash")).toBe("destruction");
    expect(macAppLabelConsequence("Buy now")).toBe("money");
    expect(macAppLabelConsequence("Pay $42.00")).toBe("money");
    expect(macAppLabelConsequence("Change password")).toBe("security");
    expect(macAppLabelConsequence("Cancel")).toBe(null);
    expect(macAppLabelConsequence("Save")).toBe(null);
  });
});

describe("the card target and summary", () => {
  it("binds a card to the action and its target, and never puts a typed body in the bind", () => {
    const t = macAppBindTarget(A({ action: "messages.send", target: "Sam Lee", text: "the secret" }));
    expect(t).toContain("messages.send");
    expect(t).toContain("Sam Lee");
    expect(t).not.toContain("the secret");
    expect(t.length).toBeLessThanOrEqual(2_000);
  });

  it("a send card names the recipient and the exact text, so a spoken yes is informed", () => {
    const s = macAppSummary(A({ action: "messages.send", target: "Sam Lee", text: "running late" }));
    expect(s).toContain("Sam Lee");
    expect(s).toContain("running late");
  });
});

/** "text Sam" → Contacts, fuzzy, with recency and the user's own nicknames breaking a tie. */
describe("contact resolution", () => {
  const people: ContactCandidate[] = [
    { name: "Sam Lee", phones: ["+15551110001"], emails: ["sam.lee@x.test"] },
    { name: "Sam Okafor", phones: ["+15551110002"], emails: ["sam.okafor@x.test"], company: "Northwind" },
    { name: "Samantha Ruiz", phones: ["+15551110005"], emails: ["sam.ruiz@x.test"] },
    { name: "Priya Nair", phones: ["+15551110003"], emails: ["priya@x.test"] },
    { name: "Robert Chen", phones: ["+15551110004"], emails: ["rob@x.test"], nickname: "Bobby" },
  ];

  it("an exact first name wins outright", () => {
    const r = pickContact("Priya", people);
    expect(r.kind).toBe("one");
    expect(r.kind === "one" && r.match.candidate.name).toBe("Priya Nair");
  });

  it("two people of the same name ask which; a mere prefix (Samantha) is not one of them", () => {
    const r = pickContact("Sam", people);
    expect(r.kind).toBe("several");
    expect(r.kind === "several" && r.options.map((o) => o.candidate.name)).toEqual(["Sam Lee", "Sam Okafor"]);
  });

  it("recency breaks the tie without asking", () => {
    const r = pickContact("Sam", people, { recent: ["Sam Okafor"] });
    expect(r.kind).toBe("one");
    expect(r.kind === "one" && r.match.candidate.name).toBe("Sam Okafor");
  });

  it("the user's own nickname memory resolves a name Contacts does not hold", () => {
    const r = pickContact("Bobby", people, { nicknames: { bobby: "Robert Chen" } });
    expect(r.kind).toBe("one");
    expect(r.kind === "one" && r.match.candidate.name).toBe("Robert Chen");
  });

  it("a Contacts nickname field resolves too", () => {
    const r = pickContact("bobby", people);
    expect(r.kind).toBe("one");
    expect(r.kind === "one" && r.match.candidate.name).toBe("Robert Chen");
  });

  it("a handle is taken as itself, with no lookup at all", () => {
    for (const q of ["+15551119999", "someone@else.test"]) {
      const r = pickContact(q, people);
      expect(r.kind, q).toBe("handle");
    }
  });

  it("a name nobody has comes back as nothing, never as a wrong guess", () => {
    expect(pickContact("Zoltan", people).kind).toBe("none");
  });

  it("a typo still finds the person", () => {
    const r = pickContact("Priyaa Nair", people);
    expect(r.kind).toBe("one");
    expect(r.kind === "one" && r.match.candidate.name).toBe("Priya Nair");
  });

  it("scores are ordered and never invented for a non-match", () => {
    const r = resolveContacts("Sam", people);
    expect(r.map((x) => x.candidate.name)).toEqual(["Sam Lee", "Sam Okafor", "Samantha Ruiz"]);
    for (let i = 1; i < r.length; i++) expect(r[i - 1]!.score).toBeGreaterThanOrEqual(r[i]!.score);
  });
});
