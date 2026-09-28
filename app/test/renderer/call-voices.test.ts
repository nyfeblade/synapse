import { beforeEach, describe, expect, it } from "vitest";
import { assignVoices } from "../../src/renderer/voice/call-voices";
import { useCall } from "../../src/renderer/voice/call-store";

// Voice calls: every Bot has its own voice — the best installed, deterministic per Bot, overridable.

const V = (id: string, quality: "premium" | "enhanced" | "default") => ({ id, name: id, lang: "en-US", quality, siri: false, personal: false });
const VOICES = [V("zoe", "premium"), V("ava", "premium"), V("evan", "premium"), V("sam-e", "enhanced"), V("sam", "default")];

describe("per-Bot call voices", () => {
  it("1:1: the Bot's own override, else Settings → Voice, else a best-quality voice picked by the Bot's id", () => {
    expect(assignVoices(["b1"], VOICES, { b1: "sam" }, "ava", false)).toEqual({ b1: "sam" });
    expect(assignVoices(["b1"], VOICES, {}, "ava", false)).toEqual({ b1: "ava" });
    const auto = assignVoices(["b1"], VOICES, {}, null, false).b1;
    expect(["zoe", "ava", "evan"]).toContain(auto);
    expect(assignVoices(["b1"], VOICES, {}, null, false).b1).toBe(auto); // deterministic
  });

  it("group: each Bot gets a different voice (Settings → Voice doesn't flatten them), best quality first", () => {
    const g = assignVoices(["n", "l", "s"], VOICES, {}, "ava", true);
    expect(new Set(Object.values(g)).size).toBe(3);
    for (const v of Object.values(g)) expect(["zoe", "ava", "evan"]).toContain(v);
    expect(assignVoices(["s", "n", "l"], VOICES, {}, "ava", true)).toEqual(g); // order-independent
  });

  it("group: an override is kept and nobody else gets that voice; more Bots than top voices spill to the next tier", () => {
    const g = assignVoices(["a", "b", "c", "d"], VOICES, { a: "zoe" }, null, true);
    expect(g.a).toBe("zoe");
    expect(new Set(Object.values(g)).size).toBe(4);
    expect(Object.values(g)).toContain("sam-e");
  });

  it("no voices listed: nothing is forced, the helper picks", () => {
    expect(assignVoices(["b1"], [], {}, null, false)).toEqual({ b1: undefined });
  });
});

describe("per-Bot natural (Kokoro) voices (bug 107)", () => {
  const NATURAL = ["af_heart", "am_michael", "bf_emma", "bm_george", "af_bella", "am_fenrir", "af_nicole", "am_puck", "bm_fable"];
  it("Kokoro Ready: every Bot without its own voice gets a deterministic Kokoro voice, 1:1 and in a group", () => {
    const one = assignVoices(["b1"], VOICES, {}, null, false, NATURAL).b1!;
    expect(one).toMatch(/^kokoro:/);
    expect(NATURAL).toContain(one.slice(7));
    expect(assignVoices(["b1"], VOICES, {}, null, false, NATURAL).b1).toBe(one);
    const g = assignVoices(["n", "l", "s", "t"], VOICES, {}, null, true, NATURAL);
    expect(new Set(Object.values(g)).size).toBe(4);
    for (const v of Object.values(g)) expect(v).toMatch(/^kokoro:/);
    expect(assignVoices(["t", "s", "l", "n"], VOICES, {}, null, true, NATURAL)).toEqual(g);
  });

  it("overrides win (a Kokoro one or an Apple one), and Settings → Voice's choice applies 1:1", () => {
    expect(assignVoices(["b1"], VOICES, { b1: "kokoro:bm_fable" }, null, false, NATURAL)).toEqual({ b1: "kokoro:bm_fable" });
    expect(assignVoices(["b1"], VOICES, { b1: "zoe" }, null, false, NATURAL)).toEqual({ b1: "zoe" });
    expect(assignVoices(["b1"], VOICES, {}, "kokoro:af_nicole", false, NATURAL)).toEqual({ b1: "kokoro:af_nicole" });
    expect(assignVoices(["b1"], VOICES, {}, "ava", false, NATURAL)).toEqual({ b1: "ava" });
    const g = assignVoices(["a", "b"], VOICES, { a: "kokoro:af_heart" }, null, true, NATURAL);
    expect(g.a).toBe("kokoro:af_heart");
    expect(g.b).not.toBe("kokoro:af_heart");
  });

  // Bug 157: the picker now stores the helper's identifier (Premium Ava is not Enhanced Ava, and a
  // Siri bundle has no browser name at all). Those go through untouched — Kokoro Ready or not.
  it("an explicit Apple identifier wins over Kokoro, and the others still get distinct natural voices", () => {
    const AVA = "com.apple.voice.premium.en-US.Ava";
    const AARON = "com.apple.ttsbundle.siri_Aaron_en-US_premium";
    expect(assignVoices(["b1"], VOICES, { b1: AVA }, null, false, NATURAL)).toEqual({ b1: AVA });
    expect(assignVoices(["b1"], VOICES, { b1: AARON }, null, true, NATURAL)).toEqual({ b1: AARON });
    const g = assignVoices(["a", "b", "c"], VOICES, { a: AVA, b: "Ava" }, null, true, NATURAL);
    expect(g.a).toBe(AVA);
    expect(g.b).toBe("Ava"); // an older saved value (a bare name) is still passed on
    expect(g.c).toMatch(/^kokoro:/);
    expect(new Set(Object.values(g)).size).toBe(3);
  });

  it("Kokoro not found: a Kokoro choice counts as unset and Apple's best voices are used", () => {
    const g = assignVoices(["a", "b"], VOICES, { a: "kokoro:af_heart" }, "kokoro:bf_emma", true, []);
    for (const v of Object.values(g)) expect(["zoe", "ava", "evan"]).toContain(v);
    expect(["zoe", "ava", "evan"]).toContain(assignVoices(["b1"], VOICES, {}, "kokoro:bf_emma", false, []).b1);
  });
});

describe("voice mode and Qwen3 voices (bug 164)", () => {
  const NATURAL = ["af_heart", "am_michael", "bf_emma", "bm_george"];
  it("Full: a Qwen or cloned choice is used as picked; Qwen missing falls the Bot back to Kokoro", () => {
    expect(assignVoices(["b1"], VOICES, { b1: "qwen3:vivian" }, null, false, NATURAL)).toEqual({ b1: "qwen3:vivian" });
    expect(assignVoices(["b1"], VOICES, { b1: "f5:my-voice" }, null, false, NATURAL)).toEqual({ b1: "f5:my-voice" });
    expect(assignVoices(["b1"], VOICES, { b1: "qwen3:vivian" }, null, false, NATURAL, "full", false).b1).toMatch(/^kokoro:/);
  });

  it("Light: a Qwen or cloned choice speaks in the Bot's Kokoro voice instead, and is never returned", () => {
    const q = assignVoices(["b1"], VOICES, { b1: "qwen3:vivian" }, null, false, NATURAL, "light").b1!;
    expect(q).toMatch(/^kokoro:/);
    expect(assignVoices(["b1"], VOICES, { b1: "f5:my-voice" }, null, false, NATURAL, "light").b1).toMatch(/^kokoro:/);
    // The same voice a Bot with nothing saved would have been given: the mode changes nothing else.
    expect(q).toBe(assignVoices(["b1"], VOICES, {}, null, false, NATURAL, "light").b1);
    // Settings → Voice set to a Qwen voice is blocked the same way.
    expect(assignVoices(["b1"], VOICES, {}, "qwen3:vivian", false, NATURAL, "light").b1).toMatch(/^kokoro:/);
  });

  it("Qwen is never auto-assigned, and a group call still mixes the engines", () => {
    const g = assignVoices(["a", "b", "c"], VOICES, { a: "qwen3:dylan", b: "com.apple.voice.premium.en-US.Ava" }, null, true, NATURAL);
    expect(g.a).toBe("qwen3:dylan");
    expect(g.b).toBe("com.apple.voice.premium.en-US.Ava");
    expect(g.c).toMatch(/^kokoro:/);
    for (const v of Object.values(assignVoices(["n", "l", "s"], VOICES, {}, null, true, NATURAL))) expect(v).toMatch(/^kokoro:/);
  });
});

describe("interrupted replies", () => {
  beforeEach(() => useCall.setState({ interrupted: {} }));
  it("remembers where a reply was cut, per entry", () => {
    useCall.getState().markInterrupted("t3b", "Once upon a time.");
    expect(useCall.getState().interrupted).toEqual({ t3b: "Once upon a time." });
  });
});
