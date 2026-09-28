import { describe, expect, it } from "vitest";
import { parseCallCommand, parseGroupCall } from "../../src/renderer/voice/call-commands";
import { matchBots, namesIn } from "../../src/renderer/voice/call-names";

// Bug 134: "call <Bot>" / "add <Bot>" / "hang up on <Bot>" on a call, matched in code (no model call).

const BOTS = [
  { id: "nova", name: "Nova" }, { id: "ledger", name: "Ledger" }, { id: "disk", name: "Disk Saver" },
  { id: "scout", name: "Scout" }, { id: "sam1", name: "Sam Rivera" }, { id: "sam2", name: "Sam Okafor" },
  { id: "kai", name: "Kai" }, { id: "cai", name: "Cai" },
];

describe("voice commands on a call", () => {
  it("add: every variant the user asked for", () => {
    for (const t of ["call Ledger", "Add Ledger.", "bring in Ledger", "bring Ledger in", "get Ledger on the call", "can you call Ledger?", "Could you add Ledger to the call please",
      "okay, let's bring in Ledger", "hey, add ledger too", "invite Ledger", "Loop in Ledger"]) {
      expect(parseCallCommand(t, BOTS, ["nova"]), t).toEqual({ kind: "add", heard: expect.any(String), matches: ["ledger"] });
    }
  });

  it("remove: hang up on / remove / drop", () => {
    for (const t of ["hang up on Ledger", "remove Ledger", "drop Ledger from the call", "can you drop Ledger", "kick Ledger off the call"]) {
      expect(parseCallCommand(t, BOTS, ["nova", "ledger"]), t).toEqual({ kind: "remove", heard: expect.any(String), matches: ["ledger"] });
    }
    // Only a Bot on the call can be removed.
    expect(parseCallCommand("remove Scout", BOTS, ["nova", "ledger"])!.matches).toEqual([]);
  });

  // Bug 158: the way people actually let someone go — the name first, then a dismissal.
  it("remove: the polite forms, name first", () => {
    for (const t of [
      "Ledger, you can go", "Ledger you can go", "thanks Ledger, you're good", "thank you Ledger, you're good",
      "Ledger, you're all set", "okay Ledger, that's all", "Ledger, you can drop off", "cheers Ledger, we're good",
      "Ledger, you can head off for now", "Ledger, you're done",
    ]) {
      expect(parseCallCommand(t, BOTS, ["nova", "ledger"]), t).toEqual({ kind: "remove", heard: expect.any(String), matches: ["ledger"] });
    }
    // The name still has to be a Bot ON the call: everything else stays an ordinary thing to say.
    for (const t of ["the deploy, you're good", "Scout, you can go", "okay, that's all", "you're good"]) {
      expect(parseCallCommand(t, BOTS, ["nova", "ledger"]), t).toBeNull();
    }
  });

  it("fuzzy names: case, first names, and small recognition slips", () => {
    expect(parseCallCommand("add disc saver", BOTS, ["nova"])!.matches).toEqual(["disk"]);
    expect(parseCallCommand("call Disk", BOTS, ["nova"])!.matches).toEqual(["disk"]);
    expect(parseCallCommand("call Legder", BOTS, ["nova"])!.matches).toEqual(["ledger"]);
    expect(parseCallCommand("bring in scoot", BOTS, ["nova"])!.matches).toEqual(["scout"]);
    expect(parseCallCommand("call Sam Okafor", BOTS, ["nova"])!.matches).toEqual(["sam2"]);
    expect(matchBots("NOVA", BOTS)).toEqual(["nova"]);
  });

  it("ambiguous: several matches (the call asks on screen)", () => {
    expect(parseCallCommand("call Sam", BOTS, ["nova"])!.matches).toEqual(["sam1", "sam2"]);
    expect(parseCallCommand("add Kay", BOTS, ["nova"])!.matches.sort()).toEqual(["cai", "kai"]);
  });

  it("no match: the name as heard, for 'I couldn't find a Bot called …'", () => {
    expect(parseCallCommand("call Zebediah", BOTS, ["nova"])).toEqual({ kind: "add", heard: "Zebediah", matches: [] });
  });

  it("ordinary requests are not commands (they go to the Bot as a turn)", () => {
    for (const t of ["call me back later", "can you call the plumber tomorrow at five", "what's the weather", "get me the report", "add a meeting to my calendar for Friday afternoon",
      "remove the duplicate rows from the sheet please", "drop it", "I'll call you tomorrow"]) {
      expect(parseCallCommand(t, BOTS, ["nova"]), t).toBeNull();
    }
  });

  // Phase 2 (bug 213): several Bots in one utterance.
  it("'bring in X and Y' / 'X, Y and Z' / 'X & Y': every name, each matched the usual way", () => {
    const names = (c: ReturnType<typeof parseCallCommand>) => (c ? [{ heard: c.heard, matches: c.matches }, ...(c.also ?? [])].map((n) => n.matches) : null);
    expect(names(parseCallCommand("bring in Scout and Ledger", BOTS, ["nova"]))).toEqual([["scout"], ["ledger"]]);
    expect(names(parseCallCommand("can you call Scout, Ledger and Disk Saver please", BOTS, ["nova"]))).toEqual([["scout"], ["ledger"], ["disk"]]);
    expect(names(parseCallCommand("add Scout & Ledger", BOTS, ["nova"]))).toEqual([["scout"], ["ledger"]]);
    expect(names(parseCallCommand("get Scout and Ledger on the call", BOTS, ["nova"]))).toEqual([["scout"], ["ledger"]]);
    expect(names(parseCallCommand("drop Scout and Ledger", BOTS, ["nova", "scout", "ledger"]))).toEqual([["scout"], ["ledger"]]);
    // A slip in one name still finds it; an unknown one comes back empty (said out loud); an ambiguous one asks.
    expect(names(parseCallCommand("bring in Scout and Legder", BOTS, ["nova"]))).toEqual([["scout"], ["ledger"]]);
    expect(names(parseCallCommand("bring in Scout and Sam", BOTS, ["nova"]))![1]!.sort()).toEqual(["sam1", "sam2"]);
    // One name stays one command, exactly as before (no `also`).
    expect(parseCallCommand("bring in Scout", BOTS, ["nova"])).toEqual({ kind: "add", heard: "Scout", matches: ["scout"] });
  });

  // Review round 1: a multi-name capture is a command only when EVERY part is a Bot; plain speech stays a turn.
  it("plain speech with 'and' is never a call command", () => {
    for (const t of ["add the header and the footer", "add salt and pepper", "call mom and dad", "bring in the chairs and the table",
      "drop the tables and the views", "add Scout and the footer", "bring in Scout and Zebediah", "add milk, eggs and bread",
      "call Ledger and Zebediah please", "remove the header and footer"]) {
      expect(parseCallCommand(t, BOTS, ["nova", "scout"]), t).toBeNull();
    }
    // …while one unknown name alone is still a command ("I couldn't find a Bot called …"), as before.
    expect(parseCallCommand("call Zebediah", BOTS, ["nova"])).toEqual({ kind: "add", heard: "Zebediah", matches: [] });
  });

  it("a Bot named with 'and' is one Bot; a request after 'and' is not a command", () => {
    const bots = [...BOTS, { id: "sp", name: "Salt and Pepper" }];
    expect(parseCallCommand("bring in Salt and Pepper", bots, ["nova"])).toEqual({ kind: "add", heard: "Salt and Pepper", matches: ["sp"] });
    expect(parseCallCommand("call Nova and tell her I'm late", BOTS, [])).toBeNull();
    expect(parseCallCommand("bring in Scout, and ask him about the invoice", BOTS, ["nova"])).toBeNull();
  });

  it("the palette's 'call A and B' / 'call A B': the Bots, in the order typed (1 action to a group call)", () => {
    expect(parseGroupCall("call nova and scout", BOTS)).toEqual(["nova", "scout"]);
    expect(parseGroupCall("Call Nova Scout", BOTS)).toEqual(["nova", "scout"]);
    expect(parseGroupCall("call nova, scout, ledger", BOTS)).toEqual(["nova", "scout", "ledger"]);
    // A two-word name without "and" between names: the longest name that fits wins.
    expect(parseGroupCall("call disk saver nova", BOTS)).toEqual(["disk", "nova"]);
    expect(parseGroupCall("call sam rivera and scout", BOTS)).toEqual(["sam1", "scout"]);
    expect(parseGroupCall("call nova", BOTS)).toEqual(["nova"]);
    expect(parseGroupCall("call nova nova", BOTS)).toEqual(["nova"]);
    // Anything it can't read as Bots — an unknown or ambiguous name, no names, not "call" — is no row.
    expect(parseGroupCall("call nova zebediah", BOTS)).toBeNull();
    expect(parseGroupCall("call sam and nova", BOTS)).toBeNull();
    expect(parseGroupCall("call", BOTS)).toBeNull();
    expect(parseGroupCall("nova scout", BOTS)).toBeNull();
    expect(parseGroupCall("recall nova", BOTS)).toBeNull();
  });

  it("namesIn: who a line addresses (exact handles, any case)", () => {
    expect(namesIn("Ledger, can you take the calendar part?", BOTS)).toEqual(["ledger"]);
    expect(namesIn("nova and disk saver, thoughts?", BOTS)).toEqual(["nova", "disk"]);
    expect(namesIn("novalike things", BOTS)).toEqual([]);
  });
});
