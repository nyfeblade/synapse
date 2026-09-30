/**
 * 0.1.4 first-run (code audit 1.1): on a Mac without on-device recognition for the language, the helper used Apple's
 * servers without a word (`requiresOnDeviceRecognition` was set only when supported, and the `onDevice` flag was never
 * read). Now the helper refuses before capturing audio unless the app passes the user's opt-in, and the renderer shows
 * one notice with an Allow button.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { STR5 } from "@synapse/shared";
import { helperArgs, registerDictation } from "../../src/main/native/dictation";
import { installNativeIpc } from "../../src/main/native";
import { dictationFault } from "../../src/renderer/voice/dictation-errors";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("speech never goes to Apple's servers without the user's opt-in", () => {
  it("the helper refuses a recognizer that isn't on-device unless --allow-server-speech, before any audio is captured", () => {
    const src = fs.readFileSync(path.join(here, "../../native/dictation/Dictation.swift"), "utf8");
    expect(src).toContain('case "--allow-server-speech": opt.allowServer = true');
    const guard = src.indexOf('if !onDevice && !opt.allowServer && opt.file == nil {');
    expect(guard).toBeGreaterThan(0);
    expect(src.slice(guard, guard + 300)).toContain('fail("server-speech"');
    // The guard sits right after onDevice is known and before the first "ready" (the audio source starts after it).
    expect(guard).toBeGreaterThan(src.indexOf("let onDevice = recognizer.supportsOnDeviceRecognition"));
    expect(guard).toBeLessThan(src.indexOf('emit(["type": "ready"'));
  });

  it("the flag is passed only with the opt-in", () => {
    expect(helperArgs("dictation", "en-US")).not.toContain("--allow-server-speech");
    expect(helperArgs("dictation", "en-US", undefined, null, undefined, undefined, [], false, false, true)).toContain("--allow-server-speech");
    expect(helperArgs("call", undefined, undefined, null, undefined, undefined, [], false, false, true)).toContain("--allow-server-speech");
  });

  it("registerDictation reads the opt-in at every session start", async () => {
    const win = { isDestroyed: () => false, webContents: { send: () => {} } };
    const handlers = new Map<string, (e: unknown, m: unknown) => unknown>();
    installNativeIpc({ handle: (ch: string, fn: (e: unknown, m: unknown) => unknown) => void handlers.set(ch, fn) } as never, () => win as never);
    const argv: string[][] = [];
    const spawnFn = vi.fn((_bin: string, args: string[]) => {
      argv.push(args);
      const c = new EventEmitter() as EventEmitter & { stdin: unknown; stdout: EventEmitter };
      c.stdin = { end: vi.fn(), write: vi.fn() };
      c.stdout = new EventEmitter();
      return c as unknown as ChildProcess;
    });
    let allowed = false;
    registerDictation({ binary: "bots-dictation", spawnFn: spawnFn as never, serverSpeech: () => allowed });
    const dispatch = handlers.get("native")!;
    await dispatch({}, { name: "dictation.start", args: {} });
    allowed = true;
    await dispatch({}, { name: "dictation.start", args: {} });
    expect(argv[0]).not.toContain("--allow-server-speech");
    expect(argv[1]).toContain("--allow-server-speech");
  });

  it("the helper's refusal becomes the notice with the opt-in, not a raw error", () => {
    expect(dictationFault("This Mac can't recognise en-US speech on its own.", "server-speech")).toEqual({ text: STR5.speechServerNeeded, pane: null, notice: false, serverOptIn: true });
    expect(dictationFault("Speech recognition isn't available right now.", "recognizer-unavailable").serverOptIn).toBeUndefined();
  });
});
