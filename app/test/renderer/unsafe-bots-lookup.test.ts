import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard against the class of bug behind the NewChat crash and the near-miss in Sidebar (see PR #24 and
// the fix that followed it): sortedBotIds() (reducer.ts) derives each id from the BotSummary's own
// `.id` field, not from Object.keys(bots) — so an id coming out of sortedBotIds(), or out of any other
// list derived from the bots map (pinned ids, a group's memberIds, a stashed id in local component
// state such as a context menu's target), is only a *claim* that `bots[id]` resolves. That claim has
// already been false twice on the write side (openBot / setGroupMembers keying by the id the caller
// asked for instead of the id the response returned) and can also go false transiently on the read side
// (a real-time delete landing while a menu/sheet built from an older snapshot is still open).
//
// The rule this enforces: a non-null assertion (`!`) may never be used to resolve an index into a map
// named `bots` (`bots[expr]!`, or `<anything>.bots[expr]!`). Anywhere the renderer needs the BotSummary
// behind an id, it must handle "not found" explicitly — `bots[id] &&`, `bots[id]?.`, an `if (!b) return`
// (or `return null` / `return []`) guard, or a `.filter`/`.flatMap` that drops unresolvable ids — and
// then use the checked value, never assert past the lookup.
//
// This is a deliberately blunt, zero-exception rule rather than an allowlist: every place in the
// renderer that legitimately already knows a bots-map lookup can't fail (e.g. GroupPanel's member rows,
// which are built from an id list already filtered by `bots[id]`) resolves the bot into a local once and
// reuses that local, instead of re-indexing the map and asserting on the second lookup. That means there
// is currently no legitimate call site this rule needs to carve out — if one ever turns up, the fix is
// to resolve-once-and-reuse like GroupPanel/NewChat do, not to add an exception here (a rule with
// exceptions is a rule the next unsafe assertion can hide behind).
//
// Modeled on the source-level CSS guards in interaction-states.test.ts / layout-fit.test.ts: this reads
// the actual .ts/.tsx source rather than rendering, because the bug is a lie in the source ("this lookup
// can't fail") that only a real store desync or race would ever exercise at runtime.

const RENDERER_DIR = fileURLToPath(new URL("../../src/renderer/", import.meta.url));

// Matches `bots[<anything but a bracket>]` immediately followed by a non-null assertion, e.g.
// `bots[id]!`, `bots[menu.id]!`, `state.bots[groupId]!`. Deliberately does NOT match `bots[id]?.` or
// `bots[id] &&` (both handle "not found"), nor a bare `bots[id]` used after its own guard.
const UNSAFE_BOTS_INDEX = /\bbots\[[^[\]]*\]\s*!/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = dir + entry;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listSourceFiles(full + "/"));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function violationsIn(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (UNSAFE_BOTS_INDEX.test(line)) out.push(`${file}:${i + 1}: ${line.trim()}`);
  });
  return out;
}

describe("no non-null assertion may resolve a bots[id] lookup (unsafe-lookups guard)", () => {
  it("finds no `bots[...]!` in the renderer source", () => {
    const violations = listSourceFiles(RENDERER_DIR).flatMap(violationsIn);
    expect(violations).toEqual([]);
  });
});
