import type { TranscriptEntry, VoiceCallView } from "@synapse/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createHostApp, type HostApp } from "../../app";
import { FRONT_REQUEST_PREFIX } from "../../voice/front";
import { tmpConfig } from "../helpers";

// Bug 142: the voice fast path wired into the real host (fake brain, the scripted voice): a 1:1 call's spoken posts
// go to the Bot's voice, delegated work runs on the full session and comes back through the voice, the call
// view says fastPath, and SYNAPSE_VOICE_FAST_PATH=off restores a full-session turn per utterance.

let app: HostApp | null = null;
afterEach(async () => { await app?.close(); app = null; });
const until = async (f: () => boolean, ms = 6000) => { const t = Date.now() + ms; while (!f()) { if (Date.now() > t) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

describe("the voice fast path in the host", () => {
  it("a 1:1 call: the voice answers small talk itself, delegates a task, and speaks the full session's report", async () => {
    app = await createHostApp(tmpConfig());
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Nova", isKickstartRequested: false });
    const view = (await a.handlers.startCall!({ id })) as VoiceCallView;
    expect(view.fastPath).toBe(true);
    const tail = () => a.services.bots.tail(id, 200) as TranscriptEntry[];
    const texts = () => tail().flatMap((e) => (e.kind === "send-message" && e.message.type === "text" ? [{ rid: e.requestId, text: e.message.content }] : []));
    await a.handlers.sendPrompt!({ id, text: "hey, how's it going", clientNonce: "v1", voice: { durationMs: 900, call: true } });
    await until(() => texts().length >= 1);
    expect(texts()[0]!.rid.startsWith(FRONT_REQUEST_PREFIX)).toBe(true);
    await a.handlers.sendPrompt!({ id, text: "send the report to Sam", clientNonce: "v2", voice: { durationMs: 1200, call: true } });
    // The voice's "on it", the full session's own report (quiet on the call), then the voice's relay of it.
    await until(() => texts().filter((t) => t.rid.startsWith(FRONT_REQUEST_PREFIX)).length >= 3 && a.services.runner.isIdle(id), 8000);
    const front = texts().filter((t) => t.rid.startsWith(FRONT_REQUEST_PREFIX)).map((t) => t.text);
    expect(front).toEqual(["Sure. What else?", "Sure, on it.", "All done, it's in the chat."]);
    expect(texts().some((t) => !t.rid.startsWith(FRONT_REQUEST_PREFIX))).toBe(true);
    const users = tail().filter((e) => e.kind === "message" && e.role === "user");
    expect(users).toHaveLength(2);
    await a.handlers.endCall!({ callId: view.callId, durationMs: 60_000 });
  });

  it("with the fast path off, a spoken post is a full-session turn as before", async () => {
    app = await createHostApp(tmpConfig({ SYNAPSE_VOICE_FAST_PATH: "off" }));
    const a = app;
    const { id } = await a.handlers.createAgent!({ name: "Nova", isKickstartRequested: false });
    const view = (await a.handlers.startCall!({ id })) as VoiceCallView;
    expect(view.fastPath).toBe(false);
    await a.handlers.sendPrompt!({ id, text: "hey", clientNonce: "v1", voice: { durationMs: 900, call: true } });
    await until(() => a.services.bots.tail(id, 50).some((e) => e.kind === "send-message") && a.services.runner.isIdle(id));
    const sent = a.services.bots.tail(id, 50).filter((e) => e.kind === "send-message");
    expect(sent.every((e) => !(e as { requestId: string }).requestId.startsWith(FRONT_REQUEST_PREFIX))).toBe(true);
  });
});
