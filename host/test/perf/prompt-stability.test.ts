import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { makeRunnerHarness } from "../runner/harness";
import { tmpConfig } from "../helpers";

/**
 * The appended system prompt is ONE system block to the API, and one prompt-cache unit. TurnRunner
 * composes it from the frozen prompt snapshot plus every Phase 5 module's systemAppendExtra, and the
 * extras are re-derived on every single turn. That is fine while they are stable and catastrophic
 * when they are not: measured with the CLI's own /context accounting on 2026-09-19, the block is
 * 6,142 tokens, so a module that varies its note turn to turn turns a 614-token cache read into a
 * 7,678-token cache write, every turn, for the life of the session.
 *
 * Nothing in the codebase asserted this, which is why a static file could quietly be placed in the
 * mutable region without anyone being able to say what it cost. These tests make the property
 * checkable: composed prompt stable across turns, and a genuinely varying extra caught immediately.
 */
let app: HostApp | null = null;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = null; });

describe("the composed system prompt is byte-stable across turns (prompt-cache prefix)", () => {
  it("does not change between turns of a session on the real integrated host", async () => {
    app = await createHostApp(tmpConfig({ FUZZ: "1" }));
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Stable", isKickstartRequested: false });
    const seen = new Set<string>();
    for (let turn = 0; turn < 5; turn++) seen.add(a.services.runner.systemAppend(id));
    expect([...seen], "every turn must re-derive the identical system prompt").toHaveLength(1);
  });

  it("catches a module whose note varies turn to turn", async () => {
    let n = 0;
    const h = await makeRunnerHarness({ script: () => [], systemAppendExtras: () => `NOTE ${n++}` });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Drifty" });
    const seen = new Set([h.runner.systemAppend(id), h.runner.systemAppend(id)]);
    expect(seen.size, "a varying extra must be visible as a changed prompt, not silently absorbed").toBe(2);
  });

  it("still lets a note follow durable state, which only re-keys the prefix once", async () => {
    let installed = false;
    const h = await makeRunnerHarness({ script: () => [], systemAppendExtras: () => (installed ? "INSTALLED" : "") });
    const id = h.bots.create({ origin: "user", kickstart: false, name: "Durable" });
    const before = h.runner.systemAppend(id);
    expect(h.runner.systemAppend(id)).toBe(before);
    installed = true;
    const after = h.runner.systemAppend(id);
    expect(after).not.toBe(before);
    expect(h.runner.systemAppend(id)).toBe(after);
  });
});
