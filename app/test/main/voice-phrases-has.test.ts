import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KOKORO_LEVEL_DEFAULT } from "../../src/main/native/qwen";
import { PhraseCache, phraseCached } from "../../src/main/native/voice-cache";

// Bug 218: the end-of-turn sound only plays a line already rendered in the Bot's voice, so the call asks which are.

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "phr-has-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("voice.phrases.has: is this line rendered for this voice (keyed as a call plays it)", () => {
  it("a Kokoro or a Qwen voice, at the Bot's speed; anything else is not", () => {
    const c = new PhraseCache({ dir: tmp() });
    c.put("am_puck", 1, "Mm-hm.", Buffer.alloc(400));
    c.put("ryan", 1.25, "Okay.", Buffer.alloc(400), KOKORO_LEVEL_DEFAULT); // no Kokoro voice named: the default level (bug 221)
    expect(phraseCached(c, { voice: "kokoro:am_puck", speed: 1, text: "Mm-hm." })).toBe(true);
    expect(phraseCached(c, { voice: "kokoro:am_puck", speed: 1, text: " Mm-hm. " })).toBe(true);
    expect(phraseCached(c, { voice: "qwen3:ryan", speed: 1.25, text: "Okay." })).toBe(true);
    expect(phraseCached(c, { voice: "qwen3:ryan", speed: 1, text: "Okay." })).toBe(false);
    expect(phraseCached(c, { voice: "kokoro:am_puck", speed: 1, text: "Sure." })).toBe(false);
    expect(phraseCached(c, { voice: "com.apple.voice.premium.en-US.Ava", speed: 1, text: "Mm-hm." })).toBe(false);
    expect(phraseCached(c, null)).toBe(false);
    expect(phraseCached(c, { voice: "kokoro:am_puck", text: "x".repeat(500) })).toBe(false);
  });
});
