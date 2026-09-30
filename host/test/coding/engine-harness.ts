import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolCall } from "../../brain/types";
import { ProviderSessionStore } from "../../brain/provider/session-store";
import type { CodingGate } from "../../coding/engines/policy";
import type { CodingChild, CodingMessage } from "../../coding/engines/types";
import { setUsageSink, type MeteredRun } from "../../usage/metered-query";
import { localBotFile } from "../../walls/bot-file";
import { finish, reply, startFakeChatServer, toolChunks, usageChunk, type FakeReply, type FakeRequest } from "../brain/provider/fake-chat-server";
import { startProviderRuntime } from "../brain/provider/runtime";

/**
 * Shared pieces for the coding-engine tests: a tiny project in a git worktree (a failing test the agent must fix), the
 * host's private folder and another Bot's home next to it (the walls), a fake Chat Completions server that plays a
 * scripted model, the provider runtime in front of it, a recording approval gate and a usage recorder.
 */
export const cleanups: (() => void | Promise<void>)[] = [];
export async function cleanup(): Promise<void> {
  setUsageSink(null);
  for (const c of cleanups.splice(0).reverse()) await c();
}

export function project() {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-")));
  cleanups.push(() => fs.rmSync(T, { recursive: true, force: true }));
  const hostPrivate = path.join(T, "host-private");
  const bots = path.join(T, "home/bots");
  const me = path.join(bots, "bot-aaaaaaaaaaaa");
  const other = path.join(bots, "bot-bbbbbbbbbbbb");
  const wt = path.join(me, "code", "calc");
  for (const d of [hostPrivate, other, path.join(wt, "src")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(hostPrivate, "vault.key"), "HOST-SECRET\n");
  fs.writeFileSync(path.join(other, "notes.md"), "OTHER-BOT-SECRET\n");
  fs.writeFileSync(path.join(wt, "src/add.js"), "exports.add = (a, b) => a - b;\n");
  fs.writeFileSync(path.join(wt, "test.js"), "const { add } = require('./src/add');\nif (add(2, 3) !== 5) { console.error('FAIL add(2, 3) = ' + add(2, 3)); process.exit(1); }\nconsole.log('1 passed');\n");
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: wt, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-qm", "start");
  fs.symlinkSync(hostPrivate, path.join(wt, "escape")); // a link in the repo that leads out
  const files = localBotFile({ deny: [hostPrivate], botHomes: bots, ownHome: () => me });
  const store = new ProviderSessionStore(hostPrivate, Date.now);
  return { T, hostPrivate, bots, me, other, wt, files, store, git: g };
}

/** A gate that records every command it is asked about and refuses anything with `curl` in it. */
export function recordingGate() {
  const calls: { toolName: string; input: Record<string, unknown> }[] = [];
  const gate: CodingGate = async (_botId, call: ToolCall) => {
    calls.push({ toolName: call.toolName, input: call.input });
    if (String(call.input.command ?? "").includes("curl")) return { behavior: "deny", message: "Auto-review blocked it: it sends data out." };
    return { behavior: "allow" };
  };
  return { gate, calls };
}

export function usageRecorder() {
  const rows: MeteredRun[] = [];
  setUsageSink({ record: (r) => rows.push(r), lastTotals: () => null, noteTotals: () => {} });
  return rows;
}

export type Step = { calls: { name: string; args: Record<string, unknown> }[] } | { text: string } | { raw: FakeReply };
let seq = 0;
export function stepReply(s: Step): FakeReply {
  if ("raw" in s) return s.raw;
  if ("text" in s) return reply({ text: s.text, usage: [1200, 40] });
  return { sse: [...toolChunks(s.calls.map((c) => ({ id: `call_${++seq}`, name: c.name, args: c.args }))), finish("tool_calls"), usageChunk(1000, 30)] };
}

/** A fake Chat Completions provider that plays `steps` in order (then says "done"), and the runtime in front of it. */
export async function scriptedProvider(steps: Step[] | ((req: FakeRequest, n: number) => FakeReply), o: { allow?: () => { ok: boolean; message: string | null } } = {}) {
  const up = await startFakeChatServer((req, n) => (typeof steps === "function" ? steps(req, n) : stepReply(steps[n] ?? { text: "done" })));
  const rt = await startProviderRuntime({ upstream: up.url, ...(o.allow ? { allow: o.allow } : {}) });
  cleanups.push(() => up.close(), () => rt.stop());
  return up;
}

/** Everything a child emits until it settles (or its stream ends). */
export async function drain(child: CodingChild, ms = 15_000): Promise<{ messages: CodingMessage[]; result: CodingMessage | null }> {
  const messages: CodingMessage[] = [];
  const t = setTimeout(() => child.close(), ms);
  try {
    for await (const m of child.messages) {
      messages.push(m);
      if (m.type === "result") break;
    }
  } finally {
    clearTimeout(t);
  }
  return { messages, result: messages.find((m) => m.type === "result") ?? null };
}

export const toolResults = (ms: CodingMessage[]) => ms.filter((m) => m.type === "progress" && m.step === "tool_result") as unknown as { name: string; isError: boolean; output: string }[];
