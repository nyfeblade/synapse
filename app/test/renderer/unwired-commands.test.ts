import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pass 2 — writers with no callers (the #48 / #54 class).
 *
 * `ensureDisplay` and `setMcpServerEnabled` were fully implemented on the host and never reached
 * from the surface that reported the state. This file names every gateway command and requires
 * either a call site in `app/src` or a reason it is not a user-facing writer.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const SHARED = path.join(repoRoot, "shared", "src");
const APP_SRC = path.join(repoRoot, "app", "src");

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) yield full;
  }
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

export function commandNames(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/^[ \t]{2,4}([a-z][A-Za-z0-9]*):\s*\{\s*args:/gm)) names.add(m[1]!);
  for (const m of src.matchAll(/^[ \t]{2,4}([a-z][A-Za-z0-9]*):\s*\{\s*$/gm)) {
    const rest = src.slice(m.index! + m[0].length, m.index! + m[0].length + 120);
    if (/^[ \t]+args:/.test(rest)) names.add(m[1]!);
  }
  names.delete("args");
  names.delete("result");
  return [...names];
}

const COMMANDS = ["gateway.ts", "phase5.ts", "google.ts"].flatMap((f) => commandNames(fs.readFileSync(path.join(SHARED, f), "utf8")));
const appText = [...walk(APP_SRC)].map((f) => stripComments(fs.readFileSync(f, "utf8"))).join("\n");

/** A quoted command name in app/src — direct `call("x")` or an indirection like TeachBanner's `run("x")`. */
const called = (cmd: string) => new RegExp(`["'\`]${cmd}["'\`]`).test(appText);

/**
 * Not a user-facing writer, or the user action goes through a different command.
 * A reason has to say who calls it, or why the surface does not need to.
 */
const NOT_A_UI_WRITER: Record<string, string> = {
  getBrowserUsage: "mac-browser usage (screenshots counted apart) is read by support/diagnostics for now; no Settings tile yet.",
  broadcastToAgents: "Bot-to-Bot / group @mention path; there is no account-wide shout button.",
  clearTrays: "Clear on the tray list loops dismissTray so each row keeps its own action.",
  createAgentAutomation: "routines are created in chat (the Bot's tool) or by importing a template, not a composer form.",
  deleteSnapshot: "main snapshot-sink rotation; the user Restore/Reset goes through box-lifecycle.",
  dismissWidget: "widgets settle through respondToWidget; there is no separate dismiss control on the card.",
  getAsyncTasks: "the live list arrives on the async-tasks SSE; the chat cards already render it.",
  getAutomationWebhook: "the webhook row is filled from the routine view; rotateAutomationWebhookKey is the action.",
  getBoxStoreStatus: "Updates reads box lifecycle; snapshot status is owned by main's snapshot-sink.",
  getHealth: "coordinator / box-doctor probe; the UI reads connection state from the SSE, not this.",
  getHistoryArchiveStats: "the history archive's per-Bot size, shipped host-first on purpose (feat-history-archive); the memory screen will call it. A read, so nothing is left half-done while it waits.",
  listCodingAgents: "status lives on the in-chat coding-agent card; no Settings list.",
  listPlugins: "getMarketplace already carries installed logos and counts.",
  listSnapshots: "main snapshot-sink lists them for Update/Reset; no Settings snapshot browser.",
  readAttachmentChunk: "file preview / download path in main, not a renderer button.",
  readLocalFile: "local-exec daemon protocol, not a renderer control.",
  uninstallPlugin: "Manage plugins Remove calls removeMcpServer, which is the installed-row action.",
  openComputerApp: "the terminal, files and browser live on the box dock after Take over — not as Synapse title-bar controls.",
  setAgentComputerPerception: "Live perception is shelved (decisions.md 2026-09-21): the Screenshots / Live row was removed and every Bot runs Screenshots; the bench still sets it.",
  pauseTeachRecording: "the host pauses when the last app viewer disconnects — there is no Pause button, only Continue after reopen.",
};

describe("every gateway command is either called from the app or named as not a UI writer", () => {
  it("finds the command list (the guard's own smoke test)", () => {
    expect(COMMANDS.length).toBeGreaterThan(80);
    expect(COMMANDS).toContain("ensureDisplay");
    expect(COMMANDS).toContain("setMcpServerEnabled");
  });

  it("holds no stale allowlist entries", () => {
    expect(Object.keys(NOT_A_UI_WRITER).filter((c) => !COMMANDS.includes(c))).toEqual([]);
  });

  it("every unused command is declared, and every declared command is unused", () => {
    const unused = COMMANDS.filter((c) => !called(c));
    const declared = Object.keys(NOT_A_UI_WRITER);
    expect(unused.sort(), "a command the app never calls — either wire it or name it in NOT_A_UI_WRITER").toEqual(declared.sort());
    for (const [cmd, why] of Object.entries(NOT_A_UI_WRITER)) {
      expect(why.length, `${cmd}'s reason is too thin`).toBeGreaterThan(40);
    }
  });
});
