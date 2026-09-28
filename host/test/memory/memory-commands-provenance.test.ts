import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryFactView, MemoryListView } from "@synapse/shared";
import { FactLedger } from "../../memory/ledger";
import { createMemoryCommands } from "../../memory/memory-commands";
import { MemoryStore } from "../../memory/memory-store";
import { initLayout } from "../../store/layout";
import { tmpConfig } from "../helpers";

const A = "0b7c6f9e-3a8e-4d0c-9a53-1f2e3d4c5b6a";
const B = "1c8d7fa0-4b9f-4e1d-8b64-2a3f4e5d6c7b";

function mk() {
  const cfg = tmpConfig();
  initLayout(cfg);
  for (const id of [A, B]) fs.mkdirSync(path.join(cfg.dataRoot, "agents", id), { recursive: true });
  let t = Date.UTC(2026, 8, 1);
  const ledger = new FactLedger(path.join(cfg.hostPrivate, "memory-ledger.db"), () => t);
  const store = new MemoryStore({ cfg, now: () => t, ledger });
  const cmds = createMemoryCommands({ store, botExists: (id) => id === A || id === B, nameOf: (id) => (id === A ? "Piper" : "Scout"), secrets: () => ["hunter22"] });
  const call = <T>(name: string, args: Record<string, unknown>) => (cmds as Record<string, (a: Record<string, unknown>) => unknown>)[name]!(args) as T;
  return { store, call, advance: (ms: number) => { t += ms; } };
}

describe("memory screen: provenance, history, Forget and Correct this", () => {
  it("each fact says who learned it, when, from what, and links the chat message", () => {
    const { store, call } = mk();
    store.add({ kind: "agent", botId: A }, { content: "The user's dentist is Kim Lee.", tier: "profile", kind: "fact" }, { botId: A, chatId: A, messageId: "t12u", source: "user", confidence: 0.8 });
    const [f] = call<MemoryListView>("getAgentMemories", { id: A, scope: { kind: "agent" } }).facts;
    expect(f!.provenance).toEqual({ botId: A, botName: "Piper", recordedAt: Date.UTC(2026, 8, 1), source: "user", confidence: 0.8, chatBotId: A, messageId: "t12u" });
    expect(f!.history).toEqual([]);
  });

  it("what the user adds on the screen is theirs at confidence 1; a correction keeps the old value as history", () => {
    const { call, advance } = mk();
    const added = call<{ fact: MemoryFactView }>("addAgentMemory", { id: A, scope: { kind: "agent" }, content: "The user's employer is Quillon.", tier: "profile" }).fact;
    expect(added.provenance).toMatchObject({ botId: null, source: "user", confidence: 1, messageId: null });
    advance(86_400_000);
    const fixed = call<{ fact: MemoryFactView }>("updateAgentMemory", { id: A, scope: { kind: "agent" }, factId: added.id, content: "The user's employer is Verdigris." }).fact;
    expect(fixed.content).toBe("The user's employer is Verdigris.");
    expect(fixed.history).toMatchObject([{ content: "The user's employer is Quillon.", validTo: Date.UTC(2026, 8, 2) }]);
    expect(call<{ removed: boolean }>("deleteAgentMemory", { id: A, scope: { kind: "agent" }, factId: fixed.id }).removed).toBe(true);
    expect(call<MemoryListView>("getAgentMemories", { id: A, scope: { kind: "agent" } }).facts).toEqual([]);
  });

  it("a history line that looks like a secret is hidden like a current one", () => {
    const { store, call } = mk();
    store.add({ kind: "agent", botId: A }, { content: "The user's wifi password is hunter22.", tier: "profile", kind: "fact" });
    store.add({ kind: "agent", botId: A }, { content: "The user's wifi password is changed weekly.", tier: "profile", kind: "fact" });
    const [f] = call<MemoryListView>("getAgentMemories", { id: A, scope: { kind: "agent" } }).facts;
    expect(f!.history).toMatchObject([{ content: null }]);
  });

  it("team knowledge is one list across every Bot's shard; any Bot's screen shows who wrote each line", () => {
    const { store, call } = mk();
    store.add({ kind: "team", botId: A }, { content: "Staging runs on box 3.", tier: "profile", kind: "fact" });
    call("addAgentMemory", { id: B, scope: { kind: "team" }, content: "Releases ship on Thursdays.", tier: "profile" });
    const list = call<MemoryListView>("getAgentMemories", { id: B, scope: { kind: "team" } }).facts;
    expect(list.map((f) => [f.content, f.ownerName])).toEqual([["Staging runs on box 3.", "Piper"], ["Releases ship on Thursdays.", "Scout"]]);
    expect(call<MemoryListView>("getAgentMemories", { id: B, scope: { kind: "agent" } }).facts).toEqual([]);
    expect(call<{ removed: number }>("clearAgentMemories", { id: B, scope: { kind: "team" } }).removed).toBe(2);
  });
});
