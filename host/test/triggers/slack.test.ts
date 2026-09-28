import { describe, expect, it } from "vitest";
import { SlackSocket, mapSlackEvent, type WsLike } from "../../triggers/slack";
import type { TriggerEvent } from "../../triggers/types";

const env = (event: Record<string, unknown>) => ({ event_id: "Ev1", event_time: 1_758_276_000, event });

describe("mapSlackEvent", () => {
  it("maps mentions, top-level and threaded messages, DMs and reactions", () => {
    expect(mapSlackEvent(env({ type: "app_mention", user: "U1", text: "<@UB> deploy?", channel: "C1", channel_name: "ops", ts: "1.0" }), "UB")).toMatchObject({ source: "slack", eventId: "Ev1", kind: "mention", channel: "#ops", actor: "U1", occurredAt: 1_758_276_000_000 });
    const top = mapSlackEvent(env({ type: "message", user: "U1", text: "hi", channel: "C1", channel_name: "ops", ts: "1.0" }), "UB")!;
    expect(top.raw.thread_ts).toBeUndefined();
    expect(mapSlackEvent(env({ type: "message", user: "U1", text: "re", channel: "C1", channel_name: "ops", ts: "2.0", thread_ts: "1.0" }), "UB")!.raw.thread_ts).toBe("1.0");
    expect(mapSlackEvent(env({ type: "message", user: "U1", text: "psst", channel: "D1", channel_type: "im", ts: "1" }), "UB")!.channel).toBe("@dm");
    expect(mapSlackEvent(env({ type: "message", user: "UB", text: "me", channel: "C1", ts: "1" }), "UB")).toBeNull();
    expect(mapSlackEvent(env({ type: "message", subtype: "message_changed", channel: "C1" }), "UB")).toBeNull();
    expect(mapSlackEvent(env({ type: "reaction_added", user: "UME", reaction: "eyes", item: { channel: "C1", ts: "1.0" }, channel_name: "ops" }), "UB", "UME")).toMatchObject({ kind: "reaction", selfAuthored: true, raw: { reaction: "eyes" }, channel: "#ops" });
  });
});

describe("SlackSocket (Socket Mode)", () => {
  it("opens the socket, acks every envelope, resolves channel names and emits events", async () => {
    const sent: string[] = [];
    const listeners: Record<string, (e: { data?: unknown }) => void> = {};
    const ws: WsLike = { send: (d) => sent.push(d), close: () => {}, addEventListener: (t, cb) => { listeners[t] = cb; } };
    const fetchFn = (async (url: string) => {
      if (url.endsWith("auth.test")) return Response.json({ ok: true, user_id: "UB" });
      if (url.endsWith("apps.connections.open")) return Response.json({ ok: true, url: "wss://wss.slack.test/link" });
      if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { name: "ops" } });
      throw new Error(url);
    }) as unknown as typeof fetch;
    const got: TriggerEvent[] = [];
    let opened = "";
    const s = new SlackSocket({ appToken: () => "xapp-1", botToken: () => "xoxb-1", fetch: fetchFn, ws: (u) => { opened = u; return ws; }, onEvent: (e) => got.push(e), setTimer: () => 0, clearTimer: () => {} });
    await s.start();
    expect(opened).toBe("wss://wss.slack.test/link");
    listeners.message!({ data: JSON.stringify({ type: "events_api", envelope_id: "env-1", payload: env({ type: "app_mention", user: "U1", text: "<@UB> hi", channel: "C1", ts: "1.0" }) }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
    expect(got[0]).toMatchObject({ kind: "mention", channel: "#ops" });
    s.stop();
  });
});
