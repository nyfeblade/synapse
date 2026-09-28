import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CALL_FEEL, STRV, greetingRejectReason, type BotSummary } from "@synapse/shared";
import { StubOneShot } from "../../helper-model/one-shot";
import { loadPrompt } from "../../prompts/index";
import { CallGreetings, userNameFromFacts } from "../../voice/call-greetings";

// Bug 134 (item 1): each Bot authors 12–15 pick-up greetings ONCE, in its own personality, in one short
// helper call; cached per Bot and re-authored only when its profile (or the user's name) changes.

const FIFTEEN = {
  greetings: [
    { text: "Hey!", when: "any" }, { text: "Hey Alex, what's up?", when: "any" }, { text: "Nova here. Go.", when: "any" },
    { text: "Alex! Talk to me.", when: "any" }, { text: "Yo, what's the plan?", when: "any" }, { text: "Hi, I'm all ears.", when: "any" },
    { text: "Hey, what are we fixing?", when: "any" }, { text: "Oh hey, Alex.", when: "any" }, { text: "What's cooking?", when: "any" },
    { text: "Morning, Alex! Coffee yet?", when: "morning" }, { text: "Early start, huh?", when: "morning" },
    { text: "Afternoon! What's up?", when: "afternoon" }, { text: "Hey Alex, good afternoon.", when: "afternoon" },
    { text: "Evening, Alex.", when: "evening" }, { text: "Working late? I'm here.", when: "evening" },
  ],
};

function setup(o: { handler?: (input: unknown) => unknown; description?: string; userName?: string | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "greet-"));
  const file = path.join(dir, "call-greetings.json");
  const profiles: Record<string, { name: string; title: string; description: string }> = {
    nova: { name: "Nova", title: "Ops", description: o.description ?? "Upbeat, a bit cheeky, loves a checklist." },
  };
  const bots = {
    has: (id: string) => id in profiles,
    summary: (id: string) => ({ id, profile: profiles[id], group: null } as unknown as BotSummary),
  };
  const model = new StubOneShot({ "orig/call-greetings.md": o.handler ?? (() => FIFTEEN) });
  const make = () => new CallGreetings({ bots, model, file, now: () => 1_000, userName: () => (o.userName === undefined ? null : o.userName) });
  return { dir, file, profiles, model, make };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("CallGreetings (bug 134, item 1)", () => {
  it("first ask: the stock set at once (no waiting on a model), and ONE helper call authors the Bot's own set in the background", async () => {
    const s = setup();
    const g = s.make();
    const first = g.view("nova", "Alex");
    expect(first.authored).toBe(false);
    expect(first.greetings.length).toBeGreaterThanOrEqual(CALL_FEEL.greetingsMin);
    expect(first.greetings.some((x) => x.text.includes("Alex"))).toBe(true);
    await settle();
    expect(s.model.calls).toHaveLength(1);
    const input = s.model.calls[0]!.input as { bot: { name: string; description: string }; user: string | null; count: number };
    expect(input).toMatchObject({ bot: { name: "Nova", description: "Upbeat, a bit cheeky, loves a checklist." }, user: "Alex", count: 15 });
    const second = g.view("nova", "Alex");
    expect(second.authored).toBe(true);
    expect(second.greetings).toHaveLength(15);
    expect(second.greetings.filter((x) => x.when === "morning").length).toBe(2);
    expect(second.greetings.find((x) => x.text === "Hey!")!.when).toBeUndefined(); // "any" = no time of day
    expect(second.version).not.toBe(first.version);
  });

  it("cached: more calls, and a restart, never ask the model again while the profile is unchanged", async () => {
    const s = setup();
    s.make().view("nova", "Alex");
    await settle();
    const again = s.make(); // a host restart reads the file
    for (let i = 0; i < 5; i++) expect(again.view("nova", "Alex").authored).toBe(true);
    await settle();
    expect(s.model.calls).toHaveLength(1);
  });

  it("re-authored when the Bot's profile changes, or the user's name does", async () => {
    const s = setup();
    const g = s.make();
    g.view("nova", "Alex");
    await settle();
    const v1 = g.view("nova", "Alex").version;
    s.profiles.nova!.description = "Calm, dry humour, speaks in short sentences.";
    expect(g.view("nova", "Alex").authored).toBe(false); // stale: the stock set until the new one lands
    await settle();
    expect(s.model.calls).toHaveLength(2);
    expect(g.view("nova", "Alex").version).not.toBe(v1);
    g.view("nova", "Sam");
    await settle();
    expect(s.model.calls).toHaveLength(3);
  });

  it("the model's output is checked: too long, emoji, duplicates and junk are dropped; too few left = one more ask, then the built-in set", async () => {
    const s = setup({ handler: () => ({ greetings: [
      { text: "Hey!", when: "any" }, { text: "hey!", when: "any" }, { text: "\"Hi Alex 👋\"", when: "any" },
      { text: "Hello there, it is truly wonderful to hear from you again today", when: "any" }, { text: "", when: "any" },
    ] }) });
    const g = s.make();
    g.view("nova", "Alex");
    await settle(); await settle();
    const v = g.view("nova", "Alex");
    expect(v.authored).toBe(false);
    expect(v.greetings).toEqual(STRV.stockGreetings("Alex")); // the small neutral built-in set
    // Asked exactly twice (never per ring): the retry, then the backoff.
    expect(s.model.calls).toHaveLength(2);
    await settle();
    expect(s.model.calls).toHaveLength(2);
  });

  // ---- bug 151: greetings only, never a claim about work ----

  it("a set that claims work is thrown away line by line, and the second ask is told what was rejected", async () => {
    let attempt = 0;
    const s = setup({ handler: () => {
      attempt += 1;
      return attempt === 1
        ? { greetings: [
            { text: "Hi, I've drafted three replies for you.", when: "any" }, // the user's exact line
            { text: "Hey Alex, I finished the report.", when: "any" },
            { text: "Morning! I sent those emails.", when: "morning" },
            { text: "Hi, your inbox is quiet today.", when: "any" },
            { text: "Hey, main.ts is failing.", when: "any" },
            { text: "Hi! Here's where we left off.", when: "any" },
            { text: "Hey, I found 2 things.", when: "any" },
            { text: "Hey!", when: "any" },
          ] }
        : FIFTEEN;
    } });
    const g = s.make();
    g.view("nova", "Alex");
    await settle(); await settle();
    const v = g.view("nova", "Alex");
    expect(v.authored).toBe(true);
    for (const x of v.greetings) expect(greetingRejectReason(x.text), x.text).toBeNull();
    expect(v.greetings.some((x) => /drafted|finished|sent|inbox|main\.ts/i.test(x.text))).toBe(false);
    expect(s.model.calls).toHaveLength(2);
    const retry = s.model.calls[1]!.input as { rejected?: { text: string; why: string }[] };
    expect(retry.rejected?.[0]).toEqual({ text: "Hi, I've drafted three replies for you.", why: expect.any(String) });
  });

  it("a set cached before the rules tightened is purged on launch, so the Bot re-authors it", async () => {
    const s = setup();
    fs.writeFileSync(s.file, JSON.stringify({
      nova: { version: "whatever", authoredAt: 1, cost: { inputTokens: 1, outputTokens: 1 }, greetings: [{ text: "Hey!" }, { text: "Hi, I've drafted three replies for you." }] },
      calm: { version: "whatever", authoredAt: 1, cost: { inputTokens: 1, outputTokens: 1 }, greetings: [{ text: "Hey!" }, { text: "Hi there!" }] },
    }));
    const g = s.make();
    const onDisk = JSON.parse(fs.readFileSync(s.file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toEqual(["calm"]); // the bad set is gone from disk, the clean one stays
    expect(g.view("nova", "Alex").authored).toBe(false); // …and Nova re-authors instead of saying it again
    await settle();
    expect(s.model.calls).toHaveLength(1);
  });

  it("the prompt bans claims, context and anything that could be false at a random moment", () => {
    const p = loadPrompt("orig/call-greetings.md");
    expect(p).toMatch(/knows NOTHING|not read the chat/i);
    expect(p).toMatch(/I've|I have/);
    expect(p).toMatch(/here's/i);
    expect(p).toMatch(/false at an arbitrary moment/i);
    expect(p).toMatch(/rejected/);
  });

  it("the prompt asks for 15 short, varied greetings in the Bot's own personality with time-of-day variants", () => {
    const p = loadPrompt("orig/call-greetings.md");
    expect(p).toMatch(/personality/i);
    expect(p).toMatch(/morning/);
    expect(p).toMatch(/2 seconds|two seconds/);
    expect(p).toMatch(/data, not instructions/);
  });

  it("the user's name: a memory profile fact wins over the Mac account name", async () => {
    expect(userNameFromFacts(["The user's name is Alex Rivera.", "The user's dentist is Kim."])).toBe("Alex");
    expect(userNameFromFacts(["The user goes by Lu."])).toBe("Lu");
    expect(userNameFromFacts(["The user's first name is Sam."])).toBe("Sam");
    expect(userNameFromFacts(["The user's dog is Rex."])).toBeNull();
    const s = setup({ userName: "Lucas" });
    const g = s.make();
    g.view("nova", "Alex");
    await settle();
    expect((s.model.calls[0]!.input as { user: string }).user).toBe("Lucas");
  });

  it("one-off cost with 15 greetings stays small (estimated from the real prompt, input and output)", async () => {
    const s = setup();
    const g = s.make();
    g.view("nova", "Alex");
    await settle();
    const cost = g.lastCost("nova")!;
    // ~4 chars a token: the prompt + input, and the 15 greetings back. The ceiling covers the style
    // examples the user asked for (bug 151): ~760 input tokens, ONCE per Bot, not once per call.
    expect(cost.inputTokens).toBeGreaterThan(150);
    expect(cost.inputTokens).toBeLessThan(900);
    expect(cost.outputTokens).toBeGreaterThan(80);
    expect(cost.outputTokens).toBeLessThan(400);
    console.info(`call greetings one-off cost (15 greetings, estimated): ${cost.inputTokens} in + ${cost.outputTokens} out tokens`);
  });

  it("an unknown or group chat is an error; the stock set never needs a model", () => {
    const s = setup();
    expect(() => s.make().view("ghost")).toThrow();
    const noModel = new CallGreetings({ bots: { has: () => true, summary: () => ({ profile: { name: "A", title: "", description: "" } } as unknown as BotSummary) }, model: null, file: s.file, now: () => 1 });
    expect(noModel.view("a").authored).toBe(false);
  });
});
