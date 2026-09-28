import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPortableMigration } from "../../src/main/portable-migration";
import { readAppSettings, writeAppSettings } from "../../src/main/app-settings";

// Portable install, existing Mac: a profile that pinned a box is recorded as set up at startup. Voice settings
// (a hand-set path anywhere, a Qwen env in Synapse's own folder) are kept exactly as they were.
describe("runPortableMigration on a real settings file", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it("keeps every setting, voice paths included, and runs once", () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "portable-mig-"));
    dirs.push(ud);
    const voice = {
      kokoroPython: "/Users/alex/voice-lab/.venv/bin/python", kokoroModelDir: "/Users/alex/voice-lab/models/tts/kokoro-82m-4bit",
      qwenPython: "/q/py", qwenModelDir: "/q/m",
    };
    writeAppSettings(ud, { autoUpdate: true, audioInput: "BuiltIn", ttsVoice: "qwen3:vivian", voiceMode: "full", ...voice });
    expect(runPortableMigration(ud, "/Users/alex", () => {})).toBe(true);
    const s = readAppSettings(ud, "/nowhere");
    expect(s).toMatchObject({ autoUpdate: true, audioInput: "BuiltIn", ttsVoice: "qwen3:vivian", voiceMode: "full", ...voice });
    expect(s.portableMigrated).toBe(1);
    // Second launch: nothing to do, nothing written.
    const before = fs.statSync(path.join(ud, "app-settings.json")).mtimeMs;
    expect(runPortableMigration(ud, "/Users/alex", () => {})).toBe(false);
    expect(fs.statSync(path.join(ud, "app-settings.json")).mtimeMs).toBe(before);
  });

  // Fix round 1: the machine an existing install uses is recorded at startup, not lazily by the setup gate.
  it("an existing install (it pinned a box) keeps 'box' and is marked set up, at startup", () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "portable-mig-"));
    dirs.push(ud);
    writeAppSettings(ud, { autoUpdate: true });
    fs.writeFileSync(path.join(ud, "box-pin.json"), JSON.stringify({ publicKey: "k" }));
    expect(runPortableMigration(ud, "/Users/alex", () => {})).toBe(true);
    expect(readAppSettings(ud, "/nowhere")).toMatchObject({ autoUpdate: true, boxMachine: "box", setupDone: true });
  });

  it("even with no settings file yet, a pinned profile is recorded", () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "portable-mig-"));
    dirs.push(ud);
    fs.writeFileSync(path.join(ud, "box-pin.json"), JSON.stringify({ publicKey: "k" }));
    runPortableMigration(ud, "/Users/alex", () => {});
    expect(readAppSettings(ud, "/nowhere")).toMatchObject({ boxMachine: "box", setupDone: true });
  });

  it("a fresh profile gets no settings file just for the migration", () => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "portable-mig-"));
    dirs.push(ud);
    expect(runPortableMigration(ud, "/Users/alex", () => {})).toBe(false);
    expect(fs.existsSync(path.join(ud, "app-settings.json"))).toBe(false);
  });
});
